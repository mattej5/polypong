// Teacher console. Runs on the teacher's own laptop screen, NOT the projector:
// this is the only surface that shows live correct/incorrect per student.
import { C, S, decode, encode } from './net/protocol.js';
import { LETTERS, buildQuestion, parseQuestionCsv, questionsToCsv } from './quiz.js';

const $ = (id) => document.getElementById(id);
const el = {
  template: $('template'),
  conn: $('conn'), live: $('livebox'), table: $('livetable'),
  askNow: $('asknow'), closeNow: $('closenow'), endGame: $('endgame'),
  cfgSet: $('cfgset'), cfgTimer: $('cfgtimer'), cfgEnabled: $('cfgenabled'),
  cfgAuto: $('cfgauto'), cfgProject: $('cfgproject'), cfgNote: $('cfgnote'),
  setList: $('setlist'), setName: $('setname'), csv: $('csv'),
  preview: $('previewbox'), saveErr: $('saveerr'),
  pickFile: $('pickfile'), fileInput: $('fileinput'), fileNote: $('filenote'),
  tabForm: $('tab-form'), tabCsv: $('tab-csv'),
  paneForm: $('pane-form'), paneCsv: $('pane-csv'),
  qList: $('qlist'), addQ: $('addq'), useCsv: $('usecsv'), dropVeil: $('dropveil'),
  arenaUrl: $('arenaurl'),
};

let socket = null;
let sets = [];
let cfg = {};
let editingId = null;
let openQid = null;
let endingSession = false;   // true once END GAME is clicked — the socket close
                              // that follows is expected, so stop reconnecting.

// ------------------------------------------------------------------ transport

function connect() {
  socket = new WebSocket(`ws://${location.host}`);
  socket.addEventListener('open', () => {
    el.conn.textContent = 'connected';
    socket.send(encode({ t: C.HELLO, role: 'teacher' }));
  });
  socket.addEventListener('message', (e) => handle(decode(e.data)));
  socket.addEventListener('close', () => {
    if (endingSession) { el.conn.textContent = 'session ended'; return; }
    el.conn.textContent = 'reconnecting…';
    setTimeout(connect, 1000);
  });
}
const sendMsg = (m) => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(encode(m));
};

function handle(msg) {
  if (!msg) return;
  switch (msg.t) {
    case S.SETS:      return onSets(msg);
    case S.ERROR:     el.saveErr.textContent = msg.msg; return;
    case S.QUIZ_ASK:  return onAsk(msg);
    case S.QUIZ_TICK: return onTick(msg);
    case S.QUIZ_LIVE: return onLive(msg);
    case S.QUIZ_END:  return onEnd(msg);
    case S.QUIZ_OFF:  return clearLive();
    case S.QUIZ_LOG:  return onLog(msg);
    case S.LOBBY:     return onLobby(msg);
  }
}

function onLobby(msg) {
  if (msg.meta && msg.meta.arenaUrl) el.arenaUrl.textContent = msg.meta.arenaUrl;
}

// ------------------------------------------------------------------- settings

function onSets(msg) {
  sets = msg.sets;
  cfg = msg.cfg;

  el.cfgSet.innerHTML = '';
  if (!sets.length) {
    const o = document.createElement('option');
    o.textContent = 'no sets saved yet';
    o.value = '';
    el.cfgSet.appendChild(o);
  }
  for (const s of sets) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.name} — ${s.count} question${s.count === 1 ? '' : 's'}` +
      (s.twoOption ? ` (${s.twoOption} two-option)` : '');
    el.cfgSet.appendChild(o);
  }
  if (cfg.setId) el.cfgSet.value = cfg.setId;

  if (document.activeElement !== el.cfgTimer) el.cfgTimer.value = cfg.timerSec;
  el.cfgEnabled.checked = !!cfg.enabled;
  el.cfgAuto.checked = !!cfg.autoAdvance;
  el.cfgProject.checked = !!cfg.projectResults;
  el.cfgNote.textContent =
    `A question fires after every elimination and after every ${cfg.volleysPerQuestion} volleys. ` +
    `A student can only be served at once every ${cfg.targetCooldownRounds} rounds.`;

  el.setList.innerHTML = '';
  for (const s of sets) {
    const row = document.createElement('div');
    row.className = 'setrow' + (s.id === cfg.setId ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'setname';
    label.textContent = `${s.name} (${s.count})`;
    const use = document.createElement('button');
    use.className = 'mini';
    use.textContent = s.id === cfg.setId ? 'IN USE' : 'USE';
    use.disabled = s.id === cfg.setId;
    use.addEventListener('click', () => sendMsg({ t: C.QUIZ_CFG, setId: s.id }));
    const edit = document.createElement('button');
    edit.className = 'mini';
    edit.textContent = 'EDIT';
    edit.addEventListener('click', () => editSet(s));
    const del = document.createElement('button');
    del.className = 'mini danger';
    del.textContent = 'DELETE';
    del.addEventListener('click', async () => {
      const ok = await ask(`Delete the set "${s.name}"?`,
        `All ${s.count} question${s.count === 1 ? '' : 's'} in it are removed from the server. ` +
        'This cannot be undone — export it as CSV first if you want to keep a copy.',
        'DELETE THE SET');
      if (!ok) return;
      if (editingId === s.id) await clearEditor(false);
      sendMsg({ t: C.SET_DELETE, id: s.id });
    });
    row.append(label, use, edit, del);
    el.setList.appendChild(row);
  }
  if (!sets.length) {
    el.setList.innerHTML =
      '<div class="dim small">No sets saved yet — build one below and press SAVE SET.</div>';
  }
}

el.cfgSet.addEventListener('change', () => sendMsg({ t: C.QUIZ_CFG, setId: el.cfgSet.value || null }));
el.cfgTimer.addEventListener('change', () => sendMsg({ t: C.QUIZ_CFG, timerSec: +el.cfgTimer.value }));
el.cfgEnabled.addEventListener('change', () => sendMsg({ t: C.QUIZ_CFG, enabled: el.cfgEnabled.checked }));
el.cfgAuto.addEventListener('change', () => sendMsg({ t: C.QUIZ_CFG, autoAdvance: el.cfgAuto.checked }));
el.cfgProject.addEventListener('change', () => sendMsg({ t: C.QUIZ_CFG, projectResults: el.cfgProject.checked }));

// ------------------------------------------------------------------- editor
// One representation, two ways in. `draft` is the canonical list of questions;
// the CSV box and the hand-written list are both views of it. Every route in
// runs through parseQuestionCsv / buildQuestion in quiz.js -- the same code
// Room runs when it saves -- so the preview cannot disagree with what the
// server ends up storing.

let draft = [];          // [{ q, options, correct, topic }]
let importErrors = [];   // rows the last import refused, with line numbers
let formIndex = null;    // question open in the hand form; -1 means "a new one"
let unsaved = false;     // draft differs from anything stored on the server
let undoDelete = null;   // { index, question } for the one-step undo

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------- little bits

/** Status line under the import bar. Plain sentences, never a code. */
function note(text, kind = '') {
  el.fileNote.textContent = text;
  el.fileNote.className = `filenote small ${kind}`;
}

/**
 * In-page confirm. A native confirm() box on a Chromebook opens against the
 * top of the browser window, which is exactly where a teacher running a
 * projector is not looking. Resolves true only on a deliberate click.
 */
function ask(title, detail, yesLabel = 'YES, DO IT') {
  return new Promise((resolve) => {
    const veil = document.createElement('div');
    veil.className = 'askveil';
    veil.innerHTML =
      `<div class="askcard" role="alertdialog" aria-modal="true">` +
      `<div class="asktitle"></div><div class="askdetail"></div>` +
      `<div class="btnrow"><button class="mini danger" id="ask-yes"></button>` +
      `<button class="mini" id="ask-no">CANCEL</button></div></div>`;
    veil.querySelector('.asktitle').textContent = title;
    veil.querySelector('.askdetail').textContent = detail;
    veil.querySelector('#ask-yes').textContent = yesLabel;
    const done = (v) => { document.removeEventListener('keydown', onKey); veil.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    veil.querySelector('#ask-yes').addEventListener('click', () => done(true));
    veil.querySelector('#ask-no').addEventListener('click', () => done(false));
    veil.addEventListener('click', (e) => { if (e.target === veil) done(false); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(veil);
    veil.querySelector('#ask-no').focus();
  });
}

const hasContent = () => draft.length > 0 || el.csv.value.trim() !== '';

function markChanged() {
  unsaved = true;
  syncCsvBox();
  render();
}

/** Hand edits round-trip straight back out to CSV text. */
function syncCsvBox() {
  el.csv.value = draft.length ? questionsToCsv(draft) : '';
}

// ------------------------------------------------------------------ tabs

function showPane(which) {
  const form = which === 'form';
  el.paneForm.classList.toggle('hidden', !form);
  el.paneCsv.classList.toggle('hidden', form);
  el.tabForm.classList.toggle('on', form);
  el.tabCsv.classList.toggle('on', !form);
  el.tabForm.setAttribute('aria-selected', String(form));
  el.tabCsv.setAttribute('aria-selected', String(!form));
}
el.tabForm.addEventListener('click', () => showPane('form'));
el.tabCsv.addEventListener('click', () => { syncCsvBox(); showPane('csv'); });

// ----------------------------------------------------------------- render

function render() {
  renderList();
  renderPreview();
}

function optionSummary(q) {
  return q.options
    .map((o, j) => `${j === q.correct ? '<b class="good">' : '<span>'}${LETTERS[j]}. ${esc(o)}` +
      `${j === q.correct ? '</b>' : '</span>'}`)
    .join(' · ');
}

function renderList() {
  const box = el.qList;
  box.innerHTML = '';
  box.classList.toggle('editing', formIndex !== null);

  if (!draft.length && formIndex === null) {
    const empty = document.createElement('div');
    empty.className = 'qempty';
    empty.textContent = 'No questions yet. Add one below, choose a file, drag a file onto the page, ' +
      'or paste CSV in the CSV TEXT tab.';
    box.appendChild(empty);
  }

  draft.forEach((q, i) => {
    box.appendChild(formIndex === i ? questionForm(q, i) : questionRow(q, i));
  });
  if (formIndex === -1) box.appendChild(questionForm(null, -1));

  const open = box.querySelector('.qform');
  if (open) open.scrollIntoView({ block: 'nearest' });
}

function questionRow(q, i) {
  const row = document.createElement('div');
  row.className = 'qrow';

  const num = document.createElement('span');
  num.className = 'qnum';
  num.textContent = String(i + 1);

  const main = document.createElement('div');
  main.className = 'qmain';
  main.innerHTML =
    `<div class="qhead">${esc(q.q)}` +
    (q.options.length === 2 ? '<span class="qtag">2-OPTION</span>' : '') + `</div>` +
    `<div class="qsub">${optionSummary(q)}${q.topic ? ` — ${esc(q.topic)}` : ''}</div>`;

  const btns = document.createElement('div');
  btns.className = 'qbtns';
  const mk = (label, title, cls, fn, disabled = false) => {
    const b = document.createElement('button');
    b.className = `mini ${cls}`;
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', fn);
    btns.appendChild(b);
    return b;
  };
  mk('↑', 'Move up', 'move', () => moveQuestion(i, -1), i === 0);
  mk('↓', 'Move down', 'move', () => moveQuestion(i, 1), i === draft.length - 1);
  mk('EDIT', 'Edit this question', '', () => { formIndex = i; render(); });
  mk('DELETE', 'Delete this question', 'danger', () => deleteQuestion(i));

  row.append(num, main, btns);
  return row;
}

function moveQuestion(i, by) {
  const j = i + by;
  if (j < 0 || j >= draft.length) return;
  [draft[i], draft[j]] = [draft[j], draft[i]];
  if (formIndex === i) formIndex = j;
  markChanged();
  note(`Moved question ${i + 1} to position ${j + 1}.`);
}

function deleteQuestion(i) {
  undoDelete = { index: i, question: draft[i] };
  const text = draft[i].q;
  draft.splice(i, 1);
  if (formIndex === i) formIndex = null;
  markChanged();
  note(`Deleted "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}".`);
  const b = document.createElement('button');
  b.className = 'mini';
  b.textContent = 'UNDO';
  b.addEventListener('click', () => {
    if (!undoDelete) return;
    draft.splice(undoDelete.index, 0, undoDelete.question);
    undoDelete = null;
    markChanged();
    note('Put it back.');
  });
  el.fileNote.append(' ', b);
}

// ------------------------------------------------------- the hand-written form

function questionForm(q, index) {
  const form = document.createElement('form');
  form.className = 'qform';
  form.innerHTML =
    `<label for="f-q">QUESTION ${index === -1 ? '' : index + 1}</label>` +
    `<textarea id="f-q" rows="2" spellcheck="false"></textarea>` +
    `<div class="optkey">OPTIONS — CLICK THE CIRCLE BESIDE THE CORRECT ONE</div>` +
    LETTERS.map((L, j) =>
      `<div class="optrow" data-opt="${j}">` +
      `<input type="radio" name="f-correct" value="${j}" aria-label="Option ${L} is the correct answer" />` +
      `<span class="optletter">${L}</span>` +
      `<input type="text" id="f-opt${j}" aria-label="Option ${L}" ` +
      `placeholder="${j < 2 ? 'needed' : 'leave blank for a two-option question'}" /></div>`).join('') +
    `<label class="check"><input type="checkbox" id="f-two" />` +
    `<span>Two options only (A and B)` +
    `<small>The accessibility mode. Students get two large buttons instead of four.</small>` +
    `</span></label>` +
    `<label for="f-topic">TOPIC (optional — used for the end-of-lesson breakdown)</label>` +
    `<input type="text" id="f-topic" />` +
    `<div class="err" id="f-err"></div>` +
    `<div class="btnrow">` +
    `<button type="submit" class="mini">${index === -1 ? 'ADD THIS QUESTION' : 'DONE'}</button>` +
    `<button type="button" class="mini" id="f-cancel">CANCEL</button></div>`;

  const qBox = form.querySelector('#f-q');
  const opts = LETTERS.map((_, j) => form.querySelector(`#f-opt${j}`));
  const radios = [...form.querySelectorAll('input[name="f-correct"]')];
  const two = form.querySelector('#f-two');
  const topic = form.querySelector('#f-topic');
  const err = form.querySelector('#f-err');

  if (q) {
    qBox.value = q.q;
    q.options.forEach((o, j) => { opts[j].value = o; });
    radios[q.correct].checked = true;
    topic.value = q.topic || '';
    two.checked = q.options.length === 2;
  }

  const applyTwo = () => {
    for (const j of [2, 3]) {
      opts[j].disabled = two.checked;
      radios[j].disabled = two.checked;
      form.querySelector(`.optrow[data-opt="${j}"]`).classList.toggle('off', two.checked);
      if (two.checked) { opts[j].value = ''; if (radios[j].checked) radios[0].checked = true; }
    }
  };
  applyTwo();
  two.addEventListener('change', applyTwo);

  form.querySelector('#f-cancel').addEventListener('click', () => { formIndex = null; render(); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.textContent = '';
    const picked = radios.find((r) => r.checked && !r.disabled);
    if (!picked) {
      err.textContent = 'Click the circle beside the option that is the correct answer.';
      radios[0].focus();
      return;
    }
    const val = (j) => (two.checked && j > 1 ? '' : opts[j].value);
    const { question, error } = buildQuestion({
      q: qBox.value, a: val(0), b: val(1), c: val(2), d: val(3),
      correct: LETTERS[Number(picked.value)], topic: topic.value,
    });
    if (error) {
      err.textContent = `Cannot save this question yet: ${error.msg}`;
      const target = { q: qBox, a: opts[0], b: opts[1], c: opts[2], d: opts[3] }[error.field];
      if (target && !target.disabled) target.focus();
      return;
    }
    if (index === -1) draft.push(question);
    else draft[index] = question;
    formIndex = null;
    markChanged();
    note(index === -1
      ? `Added question ${draft.length}. Press SAVE SET to store it on the server.`
      : `Question ${index + 1} updated. Press SAVE SET to store it on the server.`);
  });

  setTimeout(() => qBox.focus(), 0);
  return form;
}

el.addQ.addEventListener('click', () => { showPane('form'); formIndex = -1; render(); });

// ---------------------------------------------------------------- preview

function renderPreview() {
  const box = el.preview;
  box.innerHTML = '';

  const twoOpt = draft.filter((q) => q.options.length === 2).length;
  const head = document.createElement('div');
  head.className = 'small pvhead';
  head.innerHTML =
    `<strong>${draft.length}</strong> question${draft.length === 1 ? '' : 's'} in this set` +
    ` · <strong>${twoOpt}</strong> two-option` +
    (importErrors.length ? ` · <span class="bad">${importErrors.length} row(s) not used</span>` : '') +
    (unsaved && draft.length ? ' · <span class="bad">not saved yet</span>' : '');
  box.appendChild(head);

  if (importErrors.length) {
    const ul = document.createElement('ul');
    ul.className = 'errlist';
    for (const e of importErrors) {
      const li = document.createElement('li');
      li.innerHTML = e.line ? `<b>line ${e.line}</b>: ${esc(e.msg)}` : esc(e.msg);
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }

  if (!draft.length) return;

  const t = document.createElement('table');
  t.className = 'ltable';
  t.innerHTML = '<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Answer</th><th>Topic</th></tr></thead>';
  const tb = document.createElement('tbody');
  draft.forEach((q, i) => {
    const tr = document.createElement('tr');
    const opts = q.options.map((o, j) =>
      `<span class="${j === q.correct ? 'good' : ''}">${LETTERS[j]}. ${esc(o)}</span>`).join('<br>');
    tr.innerHTML = `<td>${i + 1}</td><td>${esc(q.q)}</td><td>${opts}</td>` +
      `<td class="good">${LETTERS[q.correct]}</td><td>${esc(q.topic)}</td>`;
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  box.appendChild(t);
}

// ------------------------------------------------------------- text import

/**
 * Every route in lands here: the CSV box, a picked file, a dropped file, and
 * a saved set pulled back for editing.
 */
async function importText(text, source, { confirmFirst = true } = {}) {
  const { questions, errors } = parseQuestionCsv(text);

  if (!questions.length) {
    importErrors = errors;
    renderPreview();
    note(errors.length
      ? `Nothing in ${source} could be used — see the list on the right. Your questions were left alone.`
      : `${source} has no questions in it. The columns should be: question, a, b, c, d, correct, topic. ` +
        'Your questions were left alone.', 'bad');
    return false;
  }

  if (confirmFirst && hasContent()) {
    const ok = await ask(
      `Replace what is in the editor?`,
      `The editor holds ${draft.length} question${draft.length === 1 ? '' : 's'}. ` +
      `Loading ${source} will replace ${draft.length === 1 ? 'it' : 'them all'} with ` +
      `${questions.length} question${questions.length === 1 ? '' : 's'}. ` +
      'Anything you have not saved into a set is lost.',
      'REPLACE THEM');
    if (!ok) { note('Left the editor as it was.'); return false; }
  }

  draft = questions;
  importErrors = errors;
  formIndex = null;
  unsaved = true;
  syncCsvBox();
  render();
  note(`Loaded ${questions.length} question${questions.length === 1 ? '' : 's'} from ${source}` +
    (errors.length ? ` · ${errors.length} row(s) could not be used — see the list on the right` : '') +
    '. Press SAVE SET to store it.', errors.length ? 'bad' : 'ok');
  return true;
}

// ------------------------------------------------------------- file import
// The file is read to text here and then goes down the exact same path as a
// paste. No new wire message: SET_SAVE still carries CSV text.

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Sheets writes UTF-8. Excel's "Unicode Text (*.txt)" writes UTF-16 with a
 * byte-order mark, and a teacher will absolutely hand us one of those, so the
 * BOM decides the decoder instead of assuming.
 */
async function readFileText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

async function importFile(file) {
  if (!file) return;
  const where = `"${file.name}"`;
  if (!file.size) { note(`${where} is empty — there is nothing in it to import.`, 'bad'); return; }
  if (file.size > MAX_FILE_BYTES) {
    note(`${where} is ${(file.size / 1048576).toFixed(1)} MB. That is far too big for a question list — ` +
      'check you picked the right file. A spreadsheet must be exported as CSV or TSV first, ' +
      'not saved as .xlsx.', 'bad');
    return;
  }
  if (/\.(xlsx|xls|ods|numbers|pdf|docx?)$/i.test(file.name)) {
    note(`${where} is a spreadsheet or document, not a text file. In Google Sheets use ` +
      'File → Download → Comma-separated values, then choose that file.', 'bad');
    return;
  }

  let text;
  try { text = await readFileText(file); }
  catch (e) { note(`Could not read ${where}: ${e.message}`, 'bad'); return; }

  const ok = await importText(text, where);
  if (!ok) return;
  if (text.includes('�')) {
    note(`${el.fileNote.textContent} Some characters did not survive — if you see garbled letters, ` +
      're-save the file from Excel as "CSV UTF-8".', 'bad');
  }
  if (!el.setName.value.trim()) {
    el.setName.value = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60);
  }
}

el.pickFile.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', async () => {
  await importFile(el.fileInput.files[0]);
  el.fileInput.value = '';        // so picking the same file twice still fires
});

// Drag and drop anywhere on the page.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  el.dropVeil.classList.remove('hidden');
});
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; el.dropVeil.classList.add('hidden'); }
});
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  el.dropVeil.classList.add('hidden');
  const files = [...e.dataTransfer.files];
  if (files.length > 1) {
    note(`You dropped ${files.length} files. Drop one file at a time — importing "${files[0].name}".`);
  }
  await importFile(files[0]);
});

// --------------------------------------------------------------- csv text

/** The CSV box is a direct view of the draft, so editing it needs no warning. */
async function useCsvBox() {
  const text = el.csv.value;
  if (text.trim() === questionsToCsv(draft).trim()) return;   // unchanged
  if (!text.trim()) {
    if (!draft.length) return;
    const ok = await ask('Clear every question?',
      `The CSV box is empty and the editor holds ${draft.length} question(s).`, 'CLEAR THEM');
    if (!ok) { syncCsvBox(); return; }
    draft = []; importErrors = []; unsaved = true; render();
    note('Cleared.');
    return;
  }
  await importText(text, 'the CSV box', { confirmFirst: false });
}
el.useCsv.addEventListener('click', useCsvBox);
el.csv.addEventListener('blur', useCsvBox);

// ------------------------------------------------------------------ export

$('export').addEventListener('click', () => {
  if (!draft.length) { note('There is nothing to export yet.', 'bad'); return; }
  const base = (el.setName.value.trim() || 'question-set')
    .replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '-') || 'question-set';
  // Leading BOM so Excel opens accented characters correctly. Our own reader
  // strips it again on the way back in.
  const blob = new Blob(['﻿' + questionsToCsv(draft) + '\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  note(`Exported ${draft.length} question(s) as ${base}.csv — look in your Downloads folder.`, 'ok');
});

// -------------------------------------------------------------- save / clear

async function clearEditor(askFirst = true) {
  if (askFirst && hasContent()) {
    const ok = await ask('Start a new, empty set?',
      `The editor holds ${draft.length} question${draft.length === 1 ? '' : 's'}. ` +
      'Anything not already saved into a set is lost.', 'CLEAR THE EDITOR');
    if (!ok) return;
  }
  editingId = null;
  draft = [];
  importErrors = [];
  formIndex = null;
  unsaved = false;
  undoDelete = null;
  el.setName.value = '';
  el.csv.value = '';
  el.saveErr.textContent = '';
  note('Empty editor. Add a question, or import a file.');
  render();
}

$('clearedit').addEventListener('click', () => clearEditor(true));

$('loadsample').addEventListener('click', async () => {
  const s = sets[0];
  if (!s) { el.saveErr.textContent = 'There are no saved sets to copy from yet.'; return; }
  const ok = await importText(s.csv || '', `the saved set "${s.name}"`);
  if (!ok) return;
  editingId = null;                      // a copy, never an overwrite
  el.setName.value = `${s.name} (copy)`;
});

$('save').addEventListener('click', async () => {
  el.saveErr.textContent = '';
  const name = el.setName.value.trim();
  if (!name) {
    el.saveErr.textContent = 'Give the set a name first — that is the name you will pick during the lesson.';
    el.setName.focus();
    return;
  }
  if (formIndex !== null) {
    el.saveErr.textContent = 'Finish the question you are editing first — press DONE or CANCEL on it.';
    return;
  }
  if (!draft.length) {
    el.saveErr.textContent = 'There are no questions in this set yet. Add one, or import a file.';
    return;
  }
  const existing = editingId && sets.find((s) => s.id === editingId);
  if (existing) {
    const ok = await ask(`Overwrite the saved set "${existing.name}"?`,
      `Its ${existing.count} stored question${existing.count === 1 ? '' : 's'} will be replaced by the ` +
      `${draft.length} in the editor. This cannot be undone.`, 'OVERWRITE IT');
    if (!ok) { note('Nothing was overwritten.'); return; }
  }
  // Serialise the draft rather than posting raw text: the server re-parses it
  // with the same parser this page just used, so what you saw is what it saves.
  sendMsg({ t: C.SET_SAVE, id: editingId, name, csv: questionsToCsv(draft) });
  editingId = null;
  unsaved = false;
  importErrors = [];
  render();
  note(`Saved "${name}" with ${draft.length} question(s).`, 'ok');
});

/** Pull a stored set back into the editor. */
async function editSet(s) {
  const ok = await importText(s.csv || '', `the saved set "${s.name}"`);
  if (!ok) return;
  editingId = s.id;
  el.setName.value = s.name;
  unsaved = false;
  render();
  note(`Editing "${s.name}". SAVE SET will overwrite it; NEW / CLEAR starts a fresh one.`);
}

// --------------------------------------------------------------- live board

el.askNow.addEventListener('click', () => { el.saveErr.textContent = ''; sendMsg({ t: C.QUIZ_ASK_NOW }); });
el.closeNow.addEventListener('click', () => sendMsg({ t: C.QUIZ_CLOSE }));

el.endGame.addEventListener('click', () => {
  if (!confirm('End the game and shut down the server? Every screen disconnects and nobody can rejoin until you start it again from this computer.')) return;
  endingSession = true;
  el.endGame.disabled = true;
  sendMsg({ t: C.SHUTDOWN });
});

let current = null;

function onAsk(msg) {
  current = msg;
  openQid = msg.qid;
  el.closeNow.disabled = false;
  const why = msg.reason === 'elimination' ? 'after an elimination'
    : msg.reason === 'volley' ? 'after 3 volleys' : 'asked by you';
  el.live.innerHTML =
    `<div class="qwhy">${esc(why)}${msg.topic ? ` · ${esc(msg.topic)}` : ''}</div>` +
    `<div class="qtext">${esc(msg.q)}</div>` +
    `<ol class="qopts">${msg.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ol>` +
    `<div id="qcount" class="dim small">0 answered</div>`;
}

function onTick(msg) {
  const c = $('qcount');
  if (c) {
    c.textContent = `${msg.answered} of ${msg.total} answered` +
      (msg.overtime ? ' · timer expired, still waiting' : '');
    c.className = msg.overtime ? 'small bad' : 'dim small';
  }
}

function onLive(msg) {
  const tb = el.table.querySelector('tbody');
  tb.innerHTML = '';
  for (const r of msg.rows) {
    const tr = document.createElement('tr');
    const ans = !r.answered ? '<span class="dim">…</span>'
      : `<span class="${r.correct ? 'good' : 'bad'}">${LETTERS[r.choice]} ${r.correct ? '✓' : '✗'}</span>`;
    tr.innerHTML = `<td>${esc(r.name)}</td><td>${ans}</td><td>${r.remaining}s</td>`;
    const td = document.createElement('td');
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = r.extension ? `+15s (has +${r.extension}s)` : '+15s';
    b.addEventListener('click', () => sendMsg({ t: C.QUIZ_EXTEND, slot: r.slot, sec: 15 }));
    td.appendChild(b);
    if (r.extension) {
      const z = document.createElement('button');
      z.className = 'mini';
      z.textContent = 'reset';
      z.addEventListener('click', () => sendMsg({ t: C.QUIZ_EXTEND, slot: r.slot, sec: 0 }));
      td.appendChild(z);
    }
    tr.appendChild(td);
    tb.appendChild(tr);
  }
}

function onEnd(msg) {
  el.closeNow.disabled = true;
  openQid = null;
  const key = LETTERS[msg.correct];
  const rows = msg.rows || [];
  const right = rows.filter((r) => r.correct).length;
  el.live.innerHTML =
    `<div class="qwhy">closed (${esc(msg.why || '')})</div>` +
    `<div class="qtext">${esc(current ? current.q : '')}</div>` +
    `<div>Answer: <span class="good">${key}. ${esc(msg.options[msg.correct])}</span></div>` +
    `<div class="small">${right} of ${rows.length} correct` +
    (msg.targeted !== null && msg.targeted !== undefined
      ? ` · next serve aimed at <strong>${esc(nameOf(rows, msg.targeted))}</strong>`
      : ' · no serve targeted') + `</div>`;
  const tb = el.table.querySelector('tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const ans = r.choice === null ? '<span class="dim">no answer</span>'
      : `<span class="${r.correct ? 'good' : 'bad'}">${LETTERS[r.choice]} ${r.correct ? '✓' : '✗'}</span>`;
    tr.innerHTML = `<td>${esc(r.name)}</td><td>${ans}</td><td>—</td><td>—</td>`;
    tb.appendChild(tr);
  }
}

const nameOf = (rows, slot) => {
  const r = rows.find((x) => x.slot === slot);
  return r ? r.name : `seat ${slot + 1}`;
};

function clearLive() {
  el.closeNow.disabled = true;
  el.live.innerHTML = '<div class="dim">No question open.</div>';
  el.table.querySelector('tbody').innerHTML = '';
}

function onLog(msg) {
  const box = $('logbox');
  if (!msg.entries.length) { box.textContent = 'Nothing asked yet.'; return; }
  const topics = msg.topics
    .map((t) => `${esc(t.topic)}: ${t.right} right / ${t.wrong} wrong`)
    .join(' · ');
  const list = msg.entries.slice().reverse().map((e) =>
    `<li>${esc(e.q)} — <span class="good">${e.right.length} right</span>, ` +
    `<span class="bad">${e.wrong.length} wrong</span> (${esc(e.reason)})</li>`).join('');
  box.innerHTML = `<div>${topics}</div><ul class="errlist">${list}</ul>`;
}

render();
note('Choose a file, drag one onto the page, add a question by hand, or paste CSV.');
connect();

// ---------------------------------------------------------------- template
// A starter file for a teacher who has never seen this format. Built through
// questionsToCsv so the columns can never drift from what the parser expects,
// and carrying one four-option and one two-option example because the
// two-option form is the accessibility path and is not guessable from a header.
const TEMPLATE_QUESTIONS = [
  {
    q: 'Which organelle releases energy from food?',
    options: ['Nucleus', 'Mitochondria', 'Ribosome', 'Golgi body'],
    correct: 1,
    topic: 'cells',
  },
  {
    q: 'Delete these two rows and type your own. Leave c and d blank for a two-option question.',
    options: ['True', 'False', '', ''],
    correct: 0,
    topic: 'example',
  },
];

function downloadCsv(text, filename) {
  // Leading BOM so Excel opens accented characters correctly.
  const blob = new Blob(['\ufeff' + text + '\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

if (el.template) {
  el.template.addEventListener('click', () => {
    downloadCsv(questionsToCsv(TEMPLATE_QUESTIONS), 'polypong-question-template.csv');
    note('Template saved to your Downloads folder. Fill it in, then choose the file or drag it here.', 'ok');
  });
}
