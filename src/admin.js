// Teacher console. Runs on the teacher's own laptop screen, NOT the projector:
// this is the only surface that shows live correct/incorrect per student.
import { C, S, decode, encode } from './net/protocol.js';
import { LETTERS, parseQuestionCsv } from './quiz.js';

const $ = (id) => document.getElementById(id);
const el = {
  conn: $('conn'), live: $('livebox'), table: $('livetable'),
  askNow: $('asknow'), closeNow: $('closenow'),
  cfgSet: $('cfgset'), cfgTimer: $('cfgtimer'), cfgEnabled: $('cfgenabled'),
  cfgAuto: $('cfgauto'), cfgProject: $('cfgproject'), cfgNote: $('cfgnote'),
  setList: $('setlist'), setName: $('setname'), csv: $('csv'),
  preview: $('previewbox'), saveErr: $('saveerr'),
};

let socket = null;
let sets = [];
let cfg = {};
let editingId = null;
let openQid = null;

// ------------------------------------------------------------------ transport

function connect() {
  socket = new WebSocket(`ws://${location.host}`);
  socket.addEventListener('open', () => {
    el.conn.textContent = 'connected';
    socket.send(encode({ t: C.HELLO, role: 'teacher' }));
  });
  socket.addEventListener('message', (e) => handle(decode(e.data)));
  socket.addEventListener('close', () => {
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
  }
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
    edit.addEventListener('click', () => {
      editingId = s.id;
      el.setName.value = s.name;
      el.csv.value = s.csv || '';
      renderPreview();
    });
    const del = document.createElement('button');
    del.className = 'mini danger';
    del.textContent = 'DELETE';
    del.addEventListener('click', () => {
      if (confirm(`Delete "${s.name}"? This cannot be undone.`)) {
        if (editingId === s.id) clearEditor();
        sendMsg({ t: C.SET_DELETE, id: s.id });
      }
    });
    row.append(label, use, edit, del);
    el.setList.appendChild(row);
  }
  if (!sets.length) el.setList.innerHTML = '<div class="dim small">No sets yet — paste some CSV below.</div>';
}

el.cfgSet.addEventListener('change', () => sendMsg({ t: C.QUIZ_CFG, setId: el.cfgSet.value || null }));
el.cfgTimer.addEventListener('change', () => sendMsg({ t: C.QUIZ_CFG, timerSec: +el.cfgTimer.value }));
el.cfgEnabled.addEventListener('change', () => sendMsg({ t: C.QUIZ_CFG, enabled: el.cfgEnabled.checked }));
el.cfgAuto.addEventListener('change', () => sendMsg({ t: C.QUIZ_CFG, autoAdvance: el.cfgAuto.checked }));
el.cfgProject.addEventListener('change', () => sendMsg({ t: C.QUIZ_CFG, projectResults: el.cfgProject.checked }));

// ------------------------------------------------------------------- editor

function renderPreview() {
  el.saveErr.textContent = '';
  const { questions, errors, skippedHeader } = parseQuestionCsv(el.csv.value);
  const box = el.preview;
  box.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'small';
  head.innerHTML =
    `<strong>${questions.length}</strong> question${questions.length === 1 ? '' : 's'} ready` +
    ` · <strong>${questions.filter((q) => q.options.length === 2).length}</strong> two-option` +
    (skippedHeader ? ' · header row ignored' : '') +
    (errors.length ? ` · <span class="bad">${errors.length} row(s) skipped</span>` : '');
  box.appendChild(head);

  if (errors.length) {
    const ul = document.createElement('ul');
    ul.className = 'errlist';
    for (const e of errors) {
      const li = document.createElement('li');
      li.textContent = e.line ? `line ${e.line}: ${e.msg}` : e.msg;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }

  const t = document.createElement('table');
  t.className = 'ltable';
  t.innerHTML = '<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Answer</th><th>Topic</th></tr></thead>';
  const tb = document.createElement('tbody');
  questions.forEach((q, i) => {
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

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function clearEditor() {
  editingId = null;
  el.setName.value = '';
  el.csv.value = '';
  el.preview.innerHTML = '';
  el.saveErr.textContent = '';
}

$('preview').addEventListener('click', renderPreview);
$('clearedit').addEventListener('click', clearEditor);
$('loadsample').addEventListener('click', () => {
  const s = sets[0];
  if (!s) { el.saveErr.textContent = 'No saved sets to copy from.'; return; }
  editingId = null;
  el.setName.value = `${s.name} (copy)`;
  el.csv.value = s.csv || '';
  renderPreview();
});
$('save').addEventListener('click', () => {
  const name = el.setName.value.trim();
  if (!name) { el.saveErr.textContent = 'Give the set a name first.'; return; }
  const { questions } = parseQuestionCsv(el.csv.value);
  if (!questions.length) { el.saveErr.textContent = 'No valid questions in that CSV yet.'; return; }
  renderPreview();
  sendMsg({ t: C.SET_SAVE, id: editingId, name, csv: el.csv.value });
  editingId = null;
});
el.csv.addEventListener('blur', renderPreview);

// --------------------------------------------------------------- live board

el.askNow.addEventListener('click', () => { el.saveErr.textContent = ''; sendMsg({ t: C.QUIZ_ASK_NOW }); });
el.closeNow.addEventListener('click', () => sendMsg({ t: C.QUIZ_CLOSE }));

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

renderPreview();
connect();
