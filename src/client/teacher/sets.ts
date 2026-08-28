// Question sets: upload or paste a CSV, name it, save it; list what is saved;
// delete; download a blank template.
//
// The CSV is parsed HERE, in the browser, with the very same `parseCsv` the
// room uses when it builds a deck (src/shared/quiz.ts). That is deliberate:
// the preview and the real import can never disagree about what a valid
// question is, and the teacher gets the verdict as they type instead of after
// a round trip.
//
// Errors are reported BY LINE NUMBER, because the person reading them is
// fixing a spreadsheet at 7am and "invalid file" tells them nothing. `CsvIssue`
// already carries both the line and a sentence written for a teacher; this
// panel's whole job is to not throw that away.
//
// What this panel deliberately does NOT do: show the contents of a saved set.
// The correct answers live in that CSV, and the only sanctioned way for an
// answer to appear on this page is the `reveal` message (SPEC I11).

import { blankCsvTemplate, parseCsv, type CsvIssue } from '../../shared/quiz';
import type { QuestionSetSummary } from '../../shared/protocol';
import { button, clear, el, setClass, setText, show } from './dom';
import type { Send } from './panels';

const MAX_ISSUES_SHOWN = 25;

/** A question set is a few kilobytes of text. Anything much larger is a
 *  spreadsheet that was renamed rather than exported, and parsing it
 *  synchronously would freeze the console mid-lesson. */
const MAX_CSV_BYTES = 2_000_000;

export interface SetsPanel {
  update(sets: readonly QuestionSetSummary[]): void;
}

export function createSetsPanel(root: HTMLElement, send: Send): SetsPanel {
  // ---- saved sets
  const saved = el('div');
  const savedEmpty = el('p', 'empty', 'No sets saved yet. Paste or upload a CSV below.');

  // ---- import form
  const nameField = el('div', 'field');
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'e.g. Cells and Organelles';
  nameField.append(el('label', undefined, 'SET NAME'), nameInput);

  const csvField = el('div', 'field');
  const csvInput = el('textarea');
  csvInput.placeholder = 'question,optionA,optionB,optionC,optionD,correct';
  csvInput.spellcheck = false;
  csvField.append(el('label', undefined, 'PASTE CSV'), csvInput);

  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.csv,text/csv,text/plain';
  fileInput.style.display = 'none';

  const upload = button('btn small', 'UPLOAD CSV');
  const template = button('btn small', 'BLANK TEMPLATE');
  const save = button('btn small go', 'SAVE SET');
  const savedNote = el('span', 'note', '');
  const buttons = el('div', 'setsrow');
  buttons.append(upload, template, save, savedNote, fileInput);

  const preview = el('p', 'preview none', 'Nothing pasted yet.');
  const issues = el('ul', 'issues');

  root.append(saved, savedEmpty, nameField, csvField, buttons, preview, issues);

  let questionCount = 0;
  let pendingName: string | null = null;
  let debounce = 0;

  function renderIssues(list: readonly CsvIssue[]): void {
    clear(issues);
    for (const issue of list.slice(0, MAX_ISSUES_SHOWN)) {
      const li = el('li');
      li.append(el('b', undefined, `line ${issue.line}: `), document.createTextNode(issue.message));
      issues.append(li);
    }
    if (list.length > MAX_ISSUES_SHOWN) {
      issues.append(el('li', undefined, `…and ${list.length - MAX_ISSUES_SHOWN} more rows with problems.`));
    }
  }

  function reparse(): void {
    const csv = csvInput.value;
    if (csv.trim() === '') {
      questionCount = 0;
      setText(preview, 'Nothing pasted yet.');
      setClass(preview, 'preview none');
      clear(issues);
      save.disabled = true;
      return;
    }
    const { questions, issues: found } = parseCsv(csv);
    questionCount = questions.length;
    const skipped = found.length === 0 ? '' : ` · ${found.length} row${found.length === 1 ? '' : 's'} skipped`;
    setText(preview, `${questions.length} question${questions.length === 1 ? '' : 's'} ready${skipped}`);
    setClass(preview, questions.length > 0 ? 'preview ok' : 'preview none');
    renderIssues(found);
    save.disabled = questions.length === 0;
  }

  csvInput.addEventListener('input', () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(reparse, 150);
  });

  upload.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) {
      setText(preview, 'That file is too big to be a question set. Export it as CSV and try again.');
      setClass(preview, 'preview none');
      return;
    }
    if (nameInput.value.trim() === '') nameInput.value = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
    file
      .text()
      .then((txt) => {
        csvInput.value = txt;
      })
      .catch(() => {
        // Only a READ failure gets this message. Parsing happens after, so a
        // file that reads fine but is not a CSV reports line numbers instead
        // of a misleading "could not be read".
        setText(preview, 'That file could not be read. Try opening it and pasting instead.');
        setClass(preview, 'preview none');
      })
      .finally(reparse);
  });

  template.addEventListener('click', () => {
    const blob = new Blob([blankCsvTemplate()], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = 'polypong-questions.csv';
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  save.addEventListener('click', () => {
    if (questionCount === 0) return;
    const name = nameInput.value.trim().slice(0, 40) || 'Untitled set';
    pendingName = name;
    send({ t: 'saveSet', name, csv: csvInput.value });
    setText(savedNote, 'saving…');
  });

  save.disabled = true;

  return {
    update(sets) {
      clear(saved);
      for (const s of sets) {
        if (!s || typeof s.name !== 'string') continue;
        const row = el('div', 'savedset');
        const del = button('btn small danger', 'DELETE');
        // Two-step, no dialog: a question set is a teacher's own work and a
        // stray click on a projector-sized button should not destroy it.
        let armed = 0;
        del.addEventListener('click', () => {
          const now = Date.now();
          if (armed && now - armed < 4000) {
            send({ t: 'deleteSet', id: s.id });
            return;
          }
          armed = now;
          setText(del, 'DELETE?');
          window.setTimeout(() => {
            armed = 0;
            setText(del, 'DELETE');
          }, 4000);
        });
        row.append(
          el('span', 'sname', s.name),
          el('span', 'scount', `${s.count} question${s.count === 1 ? '' : 's'}`),
          del,
        );
        saved.append(row);
      }
      show(savedEmpty, sets.length === 0);

      // Clear the form only once the server has confirmed the save by sending
      // back a set list that contains it.
      if (pendingName !== null && sets.some((s) => s.name === pendingName)) {
        pendingName = null;
        nameInput.value = '';
        csvInput.value = '';
        reparse();
        setText(savedNote, 'saved ✓');
        window.setTimeout(() => setText(savedNote, ''), 3000);
      }
    },
  };
}
