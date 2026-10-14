// backuppanel.js — the two buttons of "Backup and restore" and what they say. Browser only;
// every rule (what is in a file, what is refused, merge and replace) is js/app/backup.js.
//
// CONTRACT
//   mountBackup(host, { storage, takes?, songs?, download?, reload?, now? }) -> { el, refresh(), choose(file), destroy() }
//       storage   localStorage or a stand-in (getItem / setItem / removeItem / key / length)
//       takes     a take STORE (takes.js createTakeStore), or null: recordings are not offered
//       songs     a song BACKEND (songstore.js idbSongBackend), or null: songs are not offered
//       download  (blob, name) => void. Default: hands the file to the browser's downloads.
//       reload    () => void, behind "Load the page again" after a restore. The screens read
//                 their saved data when they start, so a restore shows after a fresh load.
//       refresh() reads the sizes again (after a take was recorded, say).
//       choose(file) the same path as picking a file with the button.
//   Order kept here: a chosen file is read and checked, then the plan is SHOWN, and only a
//   press on Merge, or on Replace and then once more, writes anything. Cancel, Esc-safe
//   sheets and a refused file write nothing.
//   Says what happened to anything that listens: document event 'mt:backup', detail
//   { type: 'saved' | 'refused' | 'planned' | 'cancelled' | 'restored' | 'failed', ...numbers and
//     reason codes only, never the saved data }.
//   No microphone, camera, sound or network. Needs css/backup.css.

import { banner, confirmSheet, h, openSheet, switchRow } from './shell.js';
import { BACKUP_WORDS, collect, fromFile, plan, restore, sizeWords, sizes, snapshot, toFile } from './backup.js';

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  // Not at once: the download reads the URL after this turn (as song/mix.js downloadWav).
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tell = (type, detail = {}) => document.dispatchEvent(new CustomEvent('mt:backup', { detail: { type, ...detail } }));

export function mountBackup(host, { storage = null, takes = null, songs = null, download = downloadBlob, reload = () => window.location.reload(), now = () => new Date() } = {}) {
  const include = { takes: false, songs: false };
  let busy = false, gone = false, size = null;
  const where = { storage, takes, songs };

  const what = h('div', { class: 'backup-what' });
  const status = h('div', { class: 'backup-status', role: 'status', 'aria-live': 'polite' });
  const saveBtn = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => save() }, 'Save a backup');
  const restoreBtn = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => picker.click() }, 'Restore from a backup…');
  // The real control is the button; the browser's own file box cannot be styled or worded.
  const picker = h('input', { type: 'file', class: 'backup-file', accept: '.json,.mtbackup,application/json', tabindex: '-1', 'aria-hidden': 'true' });
  picker.addEventListener('change', () => {
    const file = picker.files && picker.files[0];
    picker.value = '';   // so the same file can be chosen again after a Cancel
    if (file) choose(file);
  });
  const el = h('div', { class: 'backup' },
    h('p', { class: 'reason' }, 'Everything you have practised is kept in this browser only. A backup is a file you keep somewhere safe; restoring reads it back.'),
    what,
    h('div', { class: 'action-row' }, saveBtn, restoreBtn, picker),
    status);
  host.append(el);

  const setBusy = (on) => { busy = on; saveBtn.disabled = on; restoreBtn.disabled = on; el.dataset.busy = on ? 'yes' : 'no'; };
  const say = (...kids) => { status.replaceChildren(...kids.filter(Boolean)); };
  const line = (text) => h('p', null, text);
  const total = () => (size ? size.progress.bytes + (include.takes && size.takes ? size.takes.bytes : 0) + (include.songs && size.songs ? size.songs.bytes : 0) : 0);

  function paint() {
    if (!size) { what.replaceChildren(h('p', { class: 'reason' }, 'Looking at what is saved here…')); return; }
    const sum = h('p', { class: 'backup-sum' });
    const paintSum = () => { sum.textContent = `This backup: about ${sizeWords(total())}.`; el.dataset.bytes = String(total()); };
    const rows = [h('div', { class: 'field field-row' },
      h('div', null, h('span', { class: 'field-label' }, 'Progress and settings'),
        h('p', { class: 'reason' }, size.progress.count ? `Always in the backup: your practice record, range, constellations and settings (${sizeWords(size.progress.bytes)}).` : 'Nothing is saved here yet.')),
      h('span', { class: 'backup-always' }, 'Always'))];
    if (size.takes) {
      rows.push(size.takes.count
        ? switchRow({ label: 'My recordings', note: `${plural(size.takes.count, 'recording')}, ${sizeWords(size.takes.bytes)}. They cannot be made again, and they make the file big.`, value: include.takes, onChange: (v) => { include.takes = v; paintSum(); } })
        : h('p', { class: 'reason' }, 'No recordings are kept here yet.'));
    }
    if (size.songs) {
      rows.push(size.songs.count
        ? switchRow({ label: 'Songs and their sound', note: `${plural(size.songs.count, 'song')}, ${sizeWords(size.songs.bytes)}. ${BACKUP_WORDS.songsNote}`, value: include.songs, onChange: (v) => { include.songs = v; paintSum(); } })
        : h('p', { class: 'reason' }, 'No songs are kept here yet.'));
    }
    paintSum();
    what.replaceChildren(...rows, sum);
  }

  async function refresh() {
    try { size = await sizes(where); } catch { size = { progress: { count: 0, bytes: 0 }, takes: null, songs: null }; }
    if (size.takes && !size.takes.count) include.takes = false;
    if (size.songs && !size.songs.count) include.songs = false;
    if (!gone) paint();
    return size;
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    say(line('Making the backup…'));
    try {
      const backup = await collect({ ...where, include: { progress: true, ...include }, now });
      const file = toFile(backup);
      download(file.blob, file.name);
      const held = [`${plural(Object.keys(backup.keys).length, 'saved item')}`, backup.include.takes && plural(backup.takes.length, 'recording'), backup.include.songs && plural(backup.songs.length, 'song')].filter(Boolean).join(', ');
      say(line(`Saved “${file.name}” (${sizeWords(file.bytes)}: ${held}). It is in your Downloads folder; keep a copy somewhere safe.`),
        ...backup.skipped.map(line),
        !backup.include.songs && size && size.songs && size.songs.count ? line('Songs are not in it: drop a song’s file on the app again to make it again.') : null);
      tell('saved', { bytes: file.bytes, keys: Object.keys(backup.keys).length, takes: backup.takes.length, songs: backup.songs.length, skipped: backup.skipped.length });
    } catch {
      say(banner({ role: 'error', text: 'The backup could not be made.', detail: h('p', null, 'Nothing was changed. Try again, or leave the recordings and songs out.') }));
      tell('failed', { during: 'save' });
    }
    setBusy(false);
  }

  const list = (lines) => h('ul', { class: 'backup-lines' }, lines.map((l) => h('li', null, l)));

  // The plan, in words, with the three answers. Resolves 'merge' | 'replace' | null.
  function ask(p, file) {
    return new Promise((done) => {
      let answer = null;
      const sheet = openSheet({
        title: 'Restore this backup?', className: 'sheet-backup',
        onClose: () => done(answer),
        body: [
          h('p', null, `${p.madeWords} “${file.name || 'backup'}”, ${sizeWords(file.size)}. Nothing has been changed yet.`),
          h('section', { class: 'backup-choice', dataset: { mode: 'merge' } }, h('h3', null, 'Merge'),
            h('p', { class: 'reason' }, 'Adds what is missing here and keeps what is newer here. Nothing is removed.'), list(p.merge.lines)),
          h('section', { class: 'backup-choice', dataset: { mode: 'replace' } }, h('h3', null, 'Replace'),
            h('p', { class: 'reason' }, 'Makes this browser the same as the backup. What is here and not in the backup is removed.'),
            p.replace.blocked ? h('p', null, p.replace.blocked) : list(p.replace.lines)),
          h('div', { class: 'sheet-actions' },
            // The safe answer holds the focus, as in every confirm of the app.
            h('button', { class: 'btn btn-primary', type: 'button', autofocus: true, dataset: { answer: 'cancel' }, onclick: () => sheet.close() }, 'Cancel'),
            h('button', { class: 'btn btn-secondary', type: 'button', dataset: { answer: 'merge' }, onclick: () => { answer = 'merge'; sheet.close(); } }, 'Merge'),
            h('button', { class: 'btn btn-danger', type: 'button', dataset: { answer: 'replace' }, disabled: !!p.replace.blocked, onclick: () => { answer = 'replace'; sheet.close(); } }, 'Replace…')),
        ],
      });
    });
  }

  async function choose(file) {
    if (busy || !file) return;
    setBusy(true);
    try {
      say(line('Reading the file…'));
      const read = await fromFile(file);
      if (!read.ok) {
        say(banner({ role: 'error', text: read.words, detail: h('p', null, 'Nothing was changed.') }));
        tell('refused', { reason: read.reason });
        return;
      }
      const p = plan(read.backup, await snapshot(where));
      if (!p.ok) { say(banner({ role: 'error', text: p.words, detail: h('p', null, 'Nothing was changed.') })); tell('refused', { reason: p.reason }); return; }
      say();
      tell('planned', { merge: { add: p.merge.add, update: p.merge.update }, replace: { add: p.replace.add, update: p.replace.update, remove: p.replace.remove }, blocked: !!p.replace.blocked });
      let mode = await ask(p, file);
      if (mode === 'replace') {
        const n = p.replace.update + p.replace.remove;
        const sure = await confirmSheet({ title: 'Replace what is here?', body: `${plural(n, 'thing')} saved here will be replaced or removed, and the app cannot undo it. Save a backup of what is here first if you are not sure.`, yes: 'Replace', no: 'Keep what is here' });
        if (!sure) mode = null;
      }
      if (!mode) { say(line('Nothing was changed.')); tell('cancelled'); return; }
      say(line('Restoring…'));
      const done = await restore(read.backup, { ...where, mode });
      if (done.ok) {
        const changed = done.keys.add + done.keys.update + done.keys.remove > 0;
        say(line(done.words), changed ? h('div', { class: 'action-row' }, h('p', { class: 'reason' }, 'The screens show it after the page loads again.'),
          h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => reload() }, 'Load the page again')) : null);
        tell('restored', { mode, keys: done.keys, takes: done.takes, songs: done.songs });
      } else {
        const safety = !done.rolledBack && done.safety ? toFile(done.safety) : null;
        say(banner({
          role: 'error', text: `Not restored. ${done.words}`,
          detail: h('p', null, done.rolledBack ? 'Everything is as it was before.' : 'Part of what was here could not be put back. Save the copy that was made first.'),
          buttons: safety ? [h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => download(safety.blob, safety.name.replace('-backup-', '-before-restore-')) }, 'Save what was here as a file')] : [],
        }));
        tell('failed', { during: 'restore', mode, reason: done.reason, rolledBack: done.rolledBack });
      }
      await refresh();
    } catch {
      say(banner({ role: 'error', text: 'The backup could not be restored.', detail: h('p', null, 'Try again. If it keeps happening, the file may be damaged.') }));
      tell('failed', { during: 'restore' });
    } finally {
      setBusy(false);
    }
  }

  paint();
  refresh();
  return { el, refresh, choose, destroy() { gone = true; el.remove(); } };
}
