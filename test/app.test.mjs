// Browser regressions for app-level bugs. Needs playwright or patchright.
// Run: SSMD_PW=<dir containing node_modules/patchright> (or install playwright) [SSMD_CHANNEL=chromium|chrome] node --test test/app.test.mjs  (skips if no browser lib)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRequire } from 'node:module';
let pw = null;
for (const load of [
  () => createRequire(process.env.SSMD_PW + '/x.js')('patchright'), // SSMD_PW = dir whose node_modules has it
  () => import('playwright'),
  () => import('patchright'),
]) { try { pw = await load(); break; } catch {} }
const skip = pw ? false : 'no playwright/patchright (set SSMD_PW)';
const url = new URL('../index.html', import.meta.url).href;
let browser, page;

before(async () => { if (pw) browser = await (pw.chromium || pw.default.chromium).launch(process.env.SSMD_CHANNEL ? { channel: process.env.SSMD_CHANNEL } : {}); }, { skip });
after(async () => { await browser?.close(); });
beforeEach(async () => {
  if (!browser) return;
  page = await (await browser.newContext({ hasTouch: true })).newPage();
  await page.addInitScript(() => {
    Element.prototype.setPointerCapture = () => {}; // synthetic pointers can't be captured
    const tb = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...a) { const d = Number(localStorage.__slowBlob || 0); if (!d) return tb.apply(this, a); setTimeout(() => tb.apply(this, a), d); };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      if (localStorage.__fail === 'throw') throw new Error('quota');
      if (localStorage.__fail === 'abort') { const r = put.apply(this, a); this.transaction.abort(); return r; } // abort after a successful put
      return put.apply(this, a);
    };
  });
  await page.goto(url);
  await page.waitForFunction(() => !document.querySelector('#sampleBtn').disabled);
  await page.click('#sampleBtn');
  await page.waitForSelector('#board:not([hidden])');
});

const unloadBlocked = () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });

test('CX-01: canvas Enter keeps an unsaved draft', { skip }, async () => {
  await page.keyboard.press('Escape');
  await page.focus('#cv');
  await page.keyboard.press('Enter');
  await page.fill('#noteText', 'precious draft');
  await page.focus('#cv');
  await page.keyboard.press('Enter'); // second keyboard pin
  assert.equal(await page.locator('#list li.note-item').count(), 1, 'draft saved, not dropped');
  assert.match(await page.locator('#list .note-text').first().textContent(), /precious draft/);
  assert.equal(await page.inputValue('#noteText'), '', 'new blank draft opened');
});

for (const mode of ['throw', 'abort']) {
  test(`CX-02: failed autosave (${mode}) keeps unload warning, retry clears it`, { skip }, async () => {
    await page.evaluate((m) => localStorage.setItem('__fail', m), mode);
    await page.fill('#ctxIn', 'changed context');
    await page.dispatchEvent('#ctxIn', 'change');
    await page.waitForFunction(() => /Not saved/.test(document.querySelector('#saveState').textContent));
    assert.equal(await unloadBlocked(), true, 'unload must warn after failed save');
    await page.setViewportSize({ width: 390, height: 800 });
    assert.equal(await page.locator('#saveState').isVisible(), true, 'failure visible on narrow screens');
    await page.evaluate(() => localStorage.removeItem('__fail'));
    await page.fill('#ctxIn', 'changed again');
    await page.dispatchEvent('#ctxIn', 'change');
    await page.waitForFunction(() => /Saved on this device/.test(document.querySelector('#saveState').textContent));
    assert.equal(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), false);
  });
}

test('CX-04: Copy replacement whitespace survives save', { skip }, async () => {
  await page.click('#addNote');
  await page.selectOption('#noteType', 'Copy');
  await page.fill('#noteText', 'rename');
  await page.fill('#noteExpected', '  indented ');
  await page.click('#saveNote');
  assert.match(await page.inputValue('#promptOut'), /Replacement text: "  indented "/);
});

test('CX-05: blur clears stale touches; cancel of other pointer keeps pan', { skip }, async () => {
  const r = await page.evaluate(() => {
    const cv = document.querySelector('#cv');
    const b = cv.getBoundingClientRect();
    const ev = (t, id) => cv.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: b.x + 50, clientY: b.y + 50, button: 0, bubbles: true }));
    const notes = () => document.querySelectorAll('#list li.note-item').length;
    ev('pointerdown', 1); window.dispatchEvent(new Event('blur'));
    ev('pointerdown', 2); ev('pointerup', 2); // single tap after interruption must be a normal pin tap
    const editorAfterTap = !document.querySelector('#editor').hidden;
    document.querySelector('#cancelEdit').click();
    ev('pointerdown', 3); ev('pointerdown', 4); ev('pointercancel', 3); // pan owner is 4
    ev('pointermove', 4); const stillPanning = cv.style.cursor === 'grabbing';
    ev('pointerup', 4);
    return { editorAfterTap, stillPanning, notes: notes() };
  });
  assert.equal(r.editorAfterTap, true, 'stale pointer must not turn a tap into a pan');
  assert.equal(r.stillPanning, true);
  assert.equal(r.notes, 0);
});

const ok = (m) => /Saved on this device/.test(m);
const saved = () => page.waitForFunction(() => /Saved on this device/.test(document.querySelector('#saveState').textContent));
const setCtx = async (pg, v) => { await pg.fill('#ctxIn', v); await pg.dispatchEvent('#ctxIn', 'change'); };

test('CX-07: two-finger pan during group destination placement does not commit it', { skip }, async () => {
  const b = await page.locator('#cv').boundingBox();
  await page.click('[data-tool=group]');
  await page.mouse.click(b.x + 100, b.y + 100); await page.mouse.click(b.x + 200, b.y + 120);
  await page.click('#moveGroup');
  for (const order of [[1, 2], [2, 1]]) {
    const r = await page.evaluate((order) => {
      const cv = document.querySelector('#cv'), bb = cv.getBoundingClientRect();
      const ev = (t, id) => cv.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: bb.x + 300, clientY: bb.y + 200, button: 0, bubbles: true }));
      ev('pointerdown', 1); ev('pointerdown', 2); ev('pointerup', order[0]); ev('pointerup', order[1]);
      return { editor: !document.querySelector('#editor').hidden, bar: !document.querySelector('#selectionBar').hidden };
    }, order);
    assert.deepEqual(r, { editor: false, bar: true }, 'order ' + order);
  }
  const tap = await page.evaluate(() => {
    const cv = document.querySelector('#cv'), bb = cv.getBoundingClientRect();
    const ev = (t) => cv.dispatchEvent(new PointerEvent(t, { pointerId: 9, pointerType: 'touch', clientX: bb.x + 300, clientY: bb.y + 200, button: 0, bubbles: true }));
    ev('pointerdown'); ev('pointerup');
    return !document.querySelector('#editor').hidden;
  });
  assert.equal(tap, true, 'single tap still places the destination');
});

test('CX-09: manual project save after a failed write clears the unload warning until the next edit', { skip }, async () => {
  await page.evaluate(() => localStorage.setItem('__fail', 'throw'));
  await setCtx(page, 'edit 1');
  await page.waitForFunction(() => /Not saved/.test(document.querySelector('#saveState').textContent));
  await page.click('#projectMenu summary');
  const dl = page.waitForEvent('download');
  await page.click('#saveProject');
  await dl;
  await page.waitForTimeout(900); // let the retried write fail again
  assert.equal(await unloadBlocked(), false, 'portable snapshot taken, no later edits');
  await setCtx(page, 'edit 2');
  assert.equal(await unloadBlocked(), true, 'new edit is dirty again');
});

test('CX-10: stale second tab cannot silently overwrite the first; reason persists; export works; reload recovers', { skip }, async () => {
  await saved();
  const b = await page.context().newPage();
  await b.goto(url);
  await b.waitForFunction(() => !document.querySelector('#board').hidden && /Saved on this device/.test(document.querySelector('#saveState').textContent));
  assert.equal(await b.inputValue('#screenTitle'), await page.inputValue('#screenTitle'), 'B restored the same baseline');
  // A adds a real annotation + context
  await page.click('#addNote'); await page.fill('#noteText', 'from tab A'); await page.click('#saveNote');
  await setCtx(page, 'tab A wins');
  await saved();
  // stale B edits
  await b.click('#addNote'); await b.fill('#noteText', 'from tab B'); await b.click('#saveNote');
  await b.waitForFunction(() => /another tab/.test(document.querySelector('#saveState').textContent));
  await setCtx(b, 'more B edits'); // CX-13: reason must survive further edits
  await b.waitForTimeout(700);
  assert.match(await b.textContent('#saveState'), /another tab/);
  assert.equal(await b.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), true);
  await b.click('#projectMenu summary');
  const dl = b.waitForEvent('download'); await b.click('#saveProject'); await dl; // stale tab can still export its work
  assert.match(await b.textContent('#saveState'), /another tab/);
  const c = await page.context().newPage();
  await c.goto(url);
  await c.waitForFunction(() => !document.querySelector('#board').hidden);
  assert.equal(await c.inputValue('#ctxIn'), 'tab A wins');
  assert.match(await c.inputValue('#promptOut'), /from tab A/);
  assert.doesNotMatch(await c.inputValue('#promptOut'), /from tab B/);
  await b.reload();
  await b.waitForFunction(() => !document.querySelector('#board').hidden && /Saved on this device/.test(document.querySelector('#saveState').textContent));
  assert.equal(await b.inputValue('#ctxIn'), 'tab A wins', 'reload picks up the latest revision and saving works again');
});

test('CX-06 integration: remove screen, undo restores the image; redo/undo keep it', { skip }, async () => {
  const px = () => page.evaluate(() => document.querySelector('#cv').getContext('2d').getImageData(5, 5, 1, 1).data[3]);
  assert.equal(await px(), 255);
  await page.click('#removeScreen'); await page.click('#confirmYes');
  await page.waitForSelector('#board', { state: 'hidden' });
  await page.click('#undoBtn');
  await page.waitForSelector('#board:not([hidden])');
  assert.equal(await px(), 255, 'image survived pruning');
  await page.click('#redoBtn'); await page.waitForSelector('#board', { state: 'hidden' });
  await page.click('#undoBtn'); await page.waitForSelector('#board:not([hidden])');
  assert.equal(await px(), 255, 'image survived redo -> undo');
});

test('Coordinate workflow: create, edit and export pin/area/arrow/move by coordinates (mouse on buttons, no canvas pointer)', { skip }, async () => {
  const add = async (kind) => { await page.selectOption('#addKind', kind); await page.click('#addTarget'); };
  const brief = () => page.inputValue('#promptOut');
  await page.click('#addNote');
  await page.evaluate(() => { document.querySelector('#moreDetails').open = true; });
  await page.fill('#noteText', 'keyboard area');
  await add('box');
  await page.fill('[aria-label="Target 1 x (px)"]', '10'); await page.dispatchEvent('[aria-label="Target 1 x (px)"]', 'change');
  await page.fill('[aria-label="Target 1 y (px)"]', '20'); await page.dispatchEvent('[aria-label="Target 1 y (px)"]', 'change');
  await page.fill('[aria-label="Target 1 w (px)"]', '100'); await page.dispatchEvent('[aria-label="Target 1 w (px)"]', 'change');
  await page.fill('[aria-label="Target 1 h (px)"]', '50'); await page.dispatchEvent('[aria-label="Target 1 h (px)"]', 'change');
  await page.fill('[aria-label="Target 1 x (px)"]', '99999'); await page.dispatchEvent('[aria-label="Target 1 x (px)"]', 'change');
  assert.equal(await page.inputValue('[aria-label="Target 1 x (px)"]'), '10', 'out-of-image value is rejected');
  await add('arrow'); await add('pin');
  await page.click('#saveNote');
  let p = await brief();
  assert.match(p, /Apply this instruction to all 3 targets/);
  assert.match(p, /Area from \(10 px, 20 px\).*; 100 × 50 px/);
  assert.match(p, /Arrow points at/);
  // move by coordinates, then edit the offset
  await page.click('#addNote');
  await page.evaluate(() => { document.querySelector('#moreDetails').open = true; });
  await page.selectOption('#addKind', 'move'); await page.click('#addTarget');
  assert.equal(await page.inputValue('#noteType'), 'Move');
  await page.fill('[aria-label^="Move right"]', '40'); await page.dispatchEvent('[aria-label^="Move right"]', 'change');
  await page.click('#saveNote');
  p = await brief();
  assert.match(p, /· Move/);
  assert.match(p, /40 px \(\d+(\.\d+)?%\) right/);
  // delete via the list (Select-less): reopen and delete
  await page.locator('#list .note-open').first().click();
  await page.click('#deleteNote');
  assert.equal(await page.locator('#list li.note-item').count(), 1);
});

const field = (l) => `[aria-label="${l}"]`;
const setField = async (l, v) => { await page.fill(field(l), v); await page.dispatchEvent(field(l), 'change'); };

test('CX-11: source edit that would push a Move destination out of the image is rejected', { skip }, async () => {
  await page.click('#addNote');
  await page.evaluate(() => { document.querySelector('#moreDetails').open = true; });
  await page.selectOption('#addKind', 'move'); await page.click('#addTarget');
  const x = field('Target 1 x (px)');
  const before = await page.inputValue(x); // centre, offset +100
  await setField('Target 1 x (px)', '1195'); // dest 1295 > 1200
  assert.equal(await page.inputValue(x), before, 'invalid source edit reverts');
  await setField('Target 1 x (px)', '1050'); // dest 1150 ok
  assert.equal(await page.inputValue(x), '1050');
  await setField('Move right (px, negative for left)', '-1100'); // dest -50 < 0
  assert.equal(await page.inputValue(field('Move right (px, negative for left)')), '100', 'invalid offset reverts');
  await page.click('#saveNote'); // must save without a surprise
  assert.equal(await page.locator('#list li.note-item').count(), 1);
  assert.match(await page.inputValue('#promptOut'), /150 px/);
});

test('CX-12: editor scope title follows coordinate targets and announces the count', { skip }, async () => {
  await page.click('#addNote');
  await page.evaluate(() => { document.querySelector('#moreDetails').open = true; });
  await page.fill('#noteText', 'keep my text');
  assert.match(await page.textContent('#editorTitle'), /General/);
  await page.click('#addTarget');
  assert.doesNotMatch(await page.textContent('#editorTitle'), /General/);
  assert.match(await page.textContent('#status'), /1 target in this instruction/);
  await page.click('#addTarget');
  assert.match(await page.textContent('#editorTitle'), /2 targets/);
  await page.click('[aria-label="Remove target 1"]'); await page.click('[aria-label="Remove target 1"]');
  assert.match(await page.textContent('#editorTitle'), /General/);
  assert.equal(await page.inputValue('#noteText'), 'keep my text');
});

test('Keyboard only: reach and operate the coordinate controls with Tab/Enter/Space/arrows', { skip }, async () => {
  await page.focus('#addNote');
  await page.keyboard.press('Enter'); // opens editor, focuses text
  assert.equal(await page.evaluate(() => document.activeElement.id), 'noteText');
  await page.keyboard.type('keyboard area');
  const tabTo = async (match) => { for (let i = 0; i < 30; i++) { await page.keyboard.press('Tab'); if (await page.evaluate((m) => { const e = document.activeElement; return m === 'summary' ? e.tagName === 'SUMMARY' && !!e.closest('#moreDetails') : e.id === m; }, match)) return; } assert.fail('could not Tab to ' + match); };
  await tabTo('summary');
  await page.keyboard.press('Space'); // native summary toggle
  assert.equal(await page.evaluate(() => document.querySelector('#moreDetails').open), true);
  await tabTo('addKind');
  await page.keyboard.type('Are'); // native select type-ahead: Area
  assert.equal(await page.inputValue('#addKind'), 'box');
  await tabTo('addTarget');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#targetList li').count(), 1);
  await tabTo('saveNote');
  await page.keyboard.press('Enter');
  assert.match(await page.inputValue('#promptOut'), /Area from/);
});

test('Redact: blacks out pixels permanently, survives reload, undo cannot restore', { skip }, async () => {
  const px = (pg) => pg.evaluate(() => Array.from(document.querySelector('#cv').getContext('2d').getImageData(100, 100, 1, 1).data));
  assert.notDeepEqual((await px(page)).slice(0, 3), [0, 0, 0]);
  const b = await page.locator('#cv').boundingBox();
  await page.click('[data-tool=redact]');
  await page.mouse.move(b.x + b.width * 0.05, b.y + b.height * 0.05);
  await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.4, { steps: 4 }); await page.mouse.up();
  await page.click('#confirmNo'); // cancel first
  assert.notDeepEqual((await px(page)).slice(0, 3), [0, 0, 0], 'cancel leaves the image alone');
  await page.mouse.move(b.x + b.width * 0.05, b.y + b.height * 0.05);
  await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.4, { steps: 4 }); await page.mouse.up();
  await page.click('#confirmYes');
  await page.waitForFunction(() => /blacked out/.test(document.querySelector('#status').textContent));
  assert.deepEqual((await px(page)).slice(0, 3), [0, 0, 0]);
  await saved();
  const r = await page.context().newPage();
  await r.goto(url);
  await r.waitForFunction(() => !document.querySelector('#board').hidden);
  assert.deepEqual((await px(r)).slice(0, 3), [0, 0, 0], 'persisted redaction');
});

test('Project roundtrip: save editable project, wipe workspace, reopen -> same brief and image', { skip }, async () => {
  await page.click('#addNote'); await page.fill('#noteText', 'roundtrip me');
  await page.evaluate(() => { document.querySelector('#moreDetails').open = true; });
  await page.selectOption('#addKind', 'box'); await page.click('#addTarget'); await page.click('#saveNote');
  await setCtx(page, 'ctx roundtrip');
  const before = await page.inputValue('#promptOut');
  await page.click('#projectMenu summary');
  const dl = page.waitForEvent('download'); await page.click('#saveProject');
  const file = await (await dl).path();
  await page.click('#projectMenu summary'); await page.click('#newProject'); await page.click('#confirmYes');
  await page.waitForSelector('#board', { state: 'hidden' });
  await page.setInputFiles('#projectFile', file);
  await page.waitForSelector('#board:not([hidden])');
  assert.equal(await page.inputValue('#promptOut'), before);
  assert.equal(await page.evaluate(() => document.querySelector('#cv').getContext('2d').getImageData(5, 5, 1, 1).data[3]), 255);
});

// ---------------- final release ----------------
const png = (pg, color, w = 400, h = 300) => pg.evaluate(([c, w, h]) => {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, w, h);
  return cv.toDataURL('image/png').split(',')[1];
}, [color, w, h]).then((b64) => Buffer.from(b64, 'base64'));
const addPng = async (pg, name, buf) => { await pg.setInputFiles('#file', { name, mimeType: 'image/png', buffer: buf }); };
const pixelAt = (pg, x, y) => pg.evaluate(([x, y]) => Array.from(document.querySelector('#cv').getContext('2d').getImageData(x, y, 1, 1).data), [x, y]);
const redactNum = async (pg, x, y, w, h) => {
  await pg.click('#redactNumbers');
  for (const [id, v] of [['#rx', x], ['#ry', y], ['#rw', w], ['#rh', h]]) await pg.fill(id, String(v));
  await pg.click('#redactYes');
};

test('Tabs: x closes (neighbour activates), Undo restores, + New opens the picker', { skip }, async () => {
  const buf = await png(page, '#336699');
  await addPng(page, 'second.png', buf);
  await page.waitForFunction(() => document.querySelectorAll('#boardTabs .tab').length === 2);
  assert.equal(await page.locator('#boardTabs .tab.active .tab-main span').textContent(), 'second');
  await page.click('[aria-label="Close second"]');
  assert.equal(await page.locator('#boardTabs .tab').count(), 1);
  assert.equal(await page.locator('#boardTabs .tab.active .tab-main span').textContent(), 'Sample workspace');
  await page.click('#undoBtn');
  assert.equal(await page.locator('#boardTabs .tab').count(), 2);
  const chooser = page.waitForEvent('filechooser');
  await page.click('.tab-new');
  await chooser;
  await page.click('[aria-label="Close Sample workspace"]'); await page.click('[aria-label="Close second"]');
  await page.waitForSelector('#drop:not([hidden])'); // empty state returns
});

test('FINAL-04: Undo never discards an unsaved draft', { skip }, async () => {
  await page.click('#addNote'); await page.fill('#noteText', 'saved text'); await page.click('#saveNote');
  await page.locator('#list .note-open').first().click();
  await page.fill('#noteText', 'edited but unsaved');
  await page.click('#undoBtn');
  assert.equal(await page.inputValue('#noteText'), 'edited but unsaved');
  assert.match(await page.textContent('#status'), /Save or Close/);
  await page.press('#noteText', 'Control+Enter'); // save through the editor shortcut
  await page.click('#undoBtn'); // now a real undo of the edit
  await page.waitForFunction(() => /saved text/.test(document.querySelector('#list .note-text').textContent));
});

test('FINAL-01: two quick redactions both survive, even after reload', { skip }, async () => {
  await redactNum(page, 0, 0, 100, 100);
  await redactNum(page, 600, 300, 100, 100);
  const blackBoth = () => page.evaluate(() => { const g = document.querySelector('#cv').getContext('2d'); return [[50, 50], [650, 350]].every(([x, y]) => g.getImageData(x, y, 1, 1).data[0] === 0); });
  await page.waitForFunction(() => { const g = document.querySelector('#cv').getContext('2d'); return [[50, 50], [650, 350]].every(([x, y]) => g.getImageData(x, y, 1, 1).data[0] === 0); }, null, { timeout: 8000 });
  await page.waitForFunction(() => /saved on this device/.test(document.querySelector('#status').textContent));
  await page.waitForTimeout(500);
  const both = async (pg) => { for (const [x, y] of [[50, 50], [650, 350]]) assert.deepEqual((await pixelAt(pg, x, y)).slice(0, 3), [0, 0, 0], `${x},${y}`); };
  assert.equal(await blackBoth(), true);
  const r = await page.context().newPage(); await r.goto(url);
  await r.waitForFunction(() => !document.querySelector('#board').hidden);
  await both(r);
  assert.equal(await redactDialogClosed(page), true);
});
const redactDialogClosed = (pg) => pg.evaluate(() => !document.querySelector('#redactDialog').open);

test('FINAL-02: an export that finishes after a redaction delivers nothing', { skip }, async () => {
  await page.evaluate(() => localStorage.setItem('__slowBlob', '1500'));
  let downloaded = false; page.on('download', () => { downloaded = true; });
  await page.click('#savePng'); // renders slowly
  await redactNum(page, 0, 0, 100, 100);
  await page.waitForFunction(() => /redacted while exporting/.test(document.querySelector('#status').textContent) || false, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2200);
  assert.equal(downloaded, false, 'stale pixels must not be delivered');
  await page.evaluate(() => localStorage.removeItem('__slowBlob'));
  const dl = page.waitForEvent('download'); await page.click('#savePng'); await dl; // a fresh export works
});

test('FINAL-02: another tab is told about a redaction and cannot export old pixels', { skip }, async () => {
  await saved();
  const b = await page.context().newPage(); await b.goto(url);
  await b.waitForFunction(() => !document.querySelector('#board').hidden && /Saved on this device/.test(document.querySelector('#saveState').textContent));
  await redactNum(page, 0, 0, 100, 100);
  await b.waitForFunction(() => /Redacted in another tab/.test(document.querySelector('#saveState').textContent));
  let dl = false; b.on('download', () => { dl = true; });
  await b.click('#savePng'); await b.waitForTimeout(500);
  assert.equal(dl, false);
  assert.match(await b.textContent('#status'), /Reload this tab/);
});

test('FINAL-03: redaction that cannot be saved says so until a save succeeds', { skip }, async () => {
  await saved();
  await page.evaluate(() => localStorage.setItem('__fail', 'throw'));
  await redactNum(page, 0, 0, 100, 100);
  await page.waitForFunction(() => /Redaction not saved yet/.test(document.querySelector('#saveState').textContent));
  assert.match(await page.textContent('#status'), /older copy is still stored|Retry/);
  assert.equal(await unloadBlocked(), true);
  await page.evaluate(() => localStorage.removeItem('__fail'));
  await setCtx(page, 'retry');
  await saved();
  assert.equal(await unloadBlocked(), false);
  // the stored record itself holds the blacked-out pixels
  const stored = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('screenshot-markup-workspace', 1); r.onsuccess = () => res(r.result); });
    const rec = await new Promise((res) => { const r = db.transaction('workspace').objectStore('workspace').get('current'); r.onsuccess = () => res(r.result); });
    const im = new Image(); await new Promise((res) => { im.onload = res; im.src = rec.images[0].src; });
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0);
    return Array.from(c.getContext('2d').getImageData(50, 50, 1, 1).data);
  });
  assert.deepEqual(stored.slice(0, 3), [0, 0, 0]);
});

test('Redaction also masks identical copies of the same screenshot in the workspace', { skip }, async () => {
  const buf = await png(page, '#cc3355');
  await addPng(page, 'one.png', buf);
  await page.waitForFunction(() => document.querySelectorAll('#boardTabs .tab').length === 2);
  await addPng(page, 'two.png', buf);
  await page.waitForFunction(() => document.querySelectorAll('#boardTabs .tab').length === 3);
  await redactNum(page, 0, 0, 100, 100); // on 'two'
  await page.waitForFunction(() => /saved on this device/.test(document.querySelector('#status').textContent));
  await page.click('#boardTabs .tab:nth-child(2) .tab-main');
  assert.deepEqual((await pixelAt(page, 50, 50)).slice(0, 3), [0, 0, 0], 'identical copy under another id is masked too');
});

test('FINAL-05: unannotated reference screen is included in brief, zip and summary', { skip }, async () => {
  await addPng(page, 'ref.png', await png(page, '#ddeeff'));
  await page.waitForFunction(() => document.querySelectorAll('#boardTabs .tab').length === 2);
  await page.check('#refToggle');
  await page.click('#boardTabs .tab:nth-child(1) .tab-main');
  await page.click('#addNote'); await page.fill('#noteText', 'match reference'); await page.click('#saveNote');
  await page.click('#undoBtn'); await page.click('#redoBtn'); // exercise history around it
  await page.click('#boardTabs .tab:nth-child(2) .tab-main');
  if (!(await page.isChecked('#refToggle'))) await page.check('#refToggle');
  assert.match(await page.inputValue('#promptOut'), /Reference screenshot/);
  assert.match(await page.textContent('#handoffSummary'), /ref · reference/);
  const dl = page.waitForEvent('download'); await page.click('#downloadBundle');
  const file = await (await dl).path();
  const zip = (await import('node:fs')).readFileSync(file);
  for (const n of ['feedback.md', 'feedback.json', 'screen-1-annotated.png', 'screen-2-annotated.png']) assert.ok(zip.includes(n), n);
  assert.ok(zip.includes('"image": "screen-2-annotated.png"'), 'json maps boards to images');
});

test('FINAL-09: mixed import reports exactly what was skipped and why', { skip }, async () => {
  await page.setInputFiles('#file', [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'good.png', mimeType: 'image/png', buffer: await png(page, '#222222') },
  ]);
  await page.waitForFunction(() => /1 screenshot added/.test(document.querySelector('#status').textContent));
  const t = await page.textContent('#status');
  assert.match(t, /1 not added/); assert.match(t, /notes\.txt: not an image file/);
});

test('FINAL-08: an oversized PNG is rejected from its header, before decoding', { skip }, async () => {
  const h = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(h); h.writeUInt32BE(13, 8); h.write('IHDR', 12); h.writeUInt32BE(20000, 16); h.writeUInt32BE(10, 20);
  await page.setInputFiles('#file', { name: 'huge.png', mimeType: 'image/png', buffer: h });
  await page.waitForFunction(() => /huge\.png/.test(document.querySelector('#status').textContent));
  assert.match(await page.textContent('#status'), /too large \(20000 × 10 px\)/);
});

test('Corrupt stored workspace is never silently overwritten', { skip }, async () => {
  await saved();
  await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('screenshot-markup-workspace', 1); r.onsuccess = () => res(r.result); });
    await new Promise((res) => { const t = db.transaction('workspace', 'readwrite'); t.objectStore('workspace').put({ format: 'bogus', version: 2, images: [], keep: 'me' }, 'current'); t.oncomplete = res; });
  });
  await page.reload();
  await page.waitForSelector('#confirmDialog[open]');
  assert.match(await page.textContent('#confirmTitle'), /could not be restored/);
  await page.click('#confirmNo');
  assert.match(await page.textContent('#saveState'), /autosave off/);
  await page.click('#sampleBtn'); await page.waitForTimeout(900);
  const kept = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('screenshot-markup-workspace', 1); r.onsuccess = () => res(r.result); });
    return await new Promise((res) => { const r = db.transaction('workspace').objectStore('workspace').get('current'); r.onsuccess = () => res(r.result.keep); });
  });
  assert.equal(kept, 'me', 'autosave stayed off, stored data untouched');
  await page.reload();
  await page.waitForSelector('#confirmDialog[open]');
  const dl = page.waitForEvent('download'); await page.click('#confirmYes');
  assert.match((await dl).suggestedFilename(), /ssmd-unrestorable-backup/);
});
