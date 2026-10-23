// Run: node --test test/   (no deps; loads markup-core straight out of index.html)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = html.match(/<script id="markup-core">([\s\S]*?)<\/script>/)[1];
const sandbox = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox);
const Core = sandbox.MarkupCore;

const mk = () => {
  const s = new Core.Store();
  s.addBoard({ id: 'b1', title: 'A', width: 1000, height: 500 });
  return s;
};

test('validate rejects bad projects', () => {
  assert.throws(() => Core.validateProject({ version: 1 }));
  assert.throws(() => Core.validateProject({ version: 2, context: '', mode: 'x', activeId: null, boards: [] }));
});

test('store: add/undo/redo annotation, numbers stay stable', () => {
  const s = mk();
  const a = s.addAnnotation('b1', { text: 'x', targets: [{ kind: 'pin', x: 1, y: 1 }] });
  const b = s.addAnnotation('b1', { text: 'y' });
  assert.deepEqual([a.number, b.number], [1, 2]);
  s.deleteAnnotation('b1', a.id);
  const c = s.addAnnotation('b1', { text: 'z' });
  assert.equal(c.number, 3);
  assert.ok(s.undo() && s.undo());
  assert.equal(s.state.boards[0].annotations.length, 2);
  assert.ok(s.redo());
});

test('targets outside the image are rejected', () => {
  const s = mk();
  assert.throws(() => s.addAnnotation('b1', { text: 'x', targets: [{ kind: 'pin', x: 2000, y: 1 }] }));
});

test('translatedTargets clamps to image', () => {
  const r = Core.translatedTargets([{ kind: 'box', x: 900, y: 10, w: 50, h: 50 }], 500, -500, 1000, 500);
  assert.equal(r.dx, 50);
  assert.equal(r.dy, -10);
});

test('move annotation needs move payload and stays in bounds', () => {
  const s = mk();
  assert.throws(() => s.addAnnotation('b1', { type: 'Move', text: 'm', targets: [{ kind: 'pin', x: 1, y: 1 }] }));
  assert.throws(() => s.addAnnotation('b1', { type: 'Move', text: 'm', targets: [{ kind: 'pin', x: 1, y: 1 }], move: { dx: 5000, dy: 0 } }));
  s.addAnnotation('b1', { type: 'Move', text: 'm', targets: [{ kind: 'pin', x: 1, y: 1 }], move: { dx: 10, dy: 10 } });
});

test('buildPrompt: empty, done filtering, move wording', () => {
  const s = mk();
  assert.equal(Core.buildPrompt(s.state), '');
  const a = s.addAnnotation('b1', { text: 'fix it', targets: [{ kind: 'pin', x: 100, y: 50 }] });
  assert.match(Core.buildPrompt(s.state), /#1 · Change/);
  s.updateAnnotation('b1', a.id, { done: true });
  assert.equal(Core.buildPrompt(s.state), '');
  assert.match(Core.buildPrompt(s.state, { includeDone: true }), /Completed/);
  s.addAnnotation('b1', { type: 'Move', text: 'm', targets: [{ kind: 'pin', x: 100, y: 50 }], move: { dx: 10, dy: -5 } });
  assert.match(Core.buildPrompt(s.state), /10 px \(1%\) right; 5 px \(1%\) up/);
});

test('multi-line fields stay inside their bullet', () => {
  const s = mk();
  s.addAnnotation('b1', { text: 'line1\n- injected heading', type: 'Bug', steps: 'a\nb' });
  const p = Core.buildPrompt(s.state);
  assert.ok(!/^- injected heading/m.test(p), 'user text must not start a top-level bullet');
});

test('project roundtrip validates', () => {
  const s = mk();
  s.addAnnotation('b1', { text: 'x', targets: [{ kind: 'box', x: 1, y: 1, w: 10, h: 10 }] });
  Core.validateProject(JSON.parse(JSON.stringify(s.state)));
});

// ---- Codex audit regressions (MSG-X2C-378B85D4BD23) ----
const heads = (p) => p.split('\n').filter((l) => /^#{1,3} /.test(l));

test('CX-03: metadata and CR/LF text cannot forge headings', () => {
  const s = mk();
  s.addAnnotation('b1', {
    text: 'hello\r\r### Forged text', type: 'Bug', steps: 'a\r\r## Forged steps', actual: 'b\r## Forged actual',
    expected: 'c\r\n\r\n## Forged expected', locator: 'loc\n\n## Forged locator',
  });
  s.setContext('ctx\n\n## Forged context');
  s.updateBoard('b1', { title: 'T\n\n## Forged title' });
  const p = Core.buildPrompt(s.state);
  assert.deepEqual(heads(p), ['# Visual implementation brief', '## T ## Forged title', '### #1 · Bug', '## Next step']);
  assert.match(p, /Forged text/); // content kept
  // no unindented/unquoted line may carry user content
  assert.ok(p.split('\n').every((l) => !/Forged/.test(l) || /^(> |\s+|- |Context: |## T )/.test(l)));
});

test('CX-04: Copy text keeps exact whitespace in the export', () => {
  const s = mk();
  s.addAnnotation('b1', { type: 'Copy', text: 'x', actual: ' old ', expected: '  indented ' });
  const p = Core.buildPrompt(s.state);
  assert.match(p, /Replacement text: "  indented "/);
  assert.match(p, /Current text: " old "/);
  s.addAnnotation('b1', { type: 'Copy', text: 'y', expected: 'plain' });
  assert.match(Core.buildPrompt(s.state), /Replacement text: plain/);
});

test('CX-06: imageIds covers current/past/future, drops unreachable', () => {
  const s = new Core.Store();
  for (let i = 0; i < 65; i++) { s.addBoard({ id: 'x' + i, title: 't', width: 10, height: 10 }); s.deleteBoard('x' + i); }
  assert.equal(s.imageIds().has('x0'), false, 'evicted from history');
  assert.equal(s.imageIds().has('x64'), true, 'undoable');
  s.undo(); // restores x64
  assert.ok(s.state.boards.some((b) => b.id === 'x64'));
  s.undo(); // back to state before x64 added; x64 only in future now
  assert.equal(s.imageIds().has('x64'), true, 'redoable');
  s.addBoard({ id: 'y', title: 't', width: 10, height: 10 }); // branch kills future
  assert.equal(s.imageIds().has('x64'), false);
  assert.equal(s.imageIds().has('y'), true);
});

test('CX-08: Copy always states the replacement, even empty; empty current text is omitted', () => {
  const s = mk();
  s.addAnnotation('b1', { type: 'Copy', text: 'clear it', actual: 'Old label', expected: '' });
  let p = Core.buildPrompt(s.state);
  assert.match(p, /Current text: Old label/);
  assert.match(p, /Replacement text: ""/);
  s.addAnnotation('b1', { type: 'Copy', text: 'ws', expected: '   ' });
  p = Core.buildPrompt(s.state);
  assert.match(p, /Replacement text: "   "/);
  assert.equal((p.match(/Current text/g) || []).length, 1);
  s.addAnnotation('b1', { type: 'Copy', text: 'ml', expected: 'a\nb' });
  assert.match(Core.buildPrompt(s.state), /Replacement text: "a\\nb"/);
});

// ---- final release (FINAL-05/07/08) ----
test('FINAL-07: user text cannot become links, images, html or fences', () => {
  const s = mk();
  s.addAnnotation('b1', {
    text: '![x](https://example.invalid/p) [run](javascript:alert(1)) <img src="https://example.invalid/x"> `code` ```fence', type: 'Bug',
    steps: '<script>x</script>', actual: '\\[escaped](javascript:1)', expected: '[a](b)', locator: '<http://example.invalid>',
  });
  s.setContext('[ctx](javascript:1)');
  const p = Core.buildPrompt(s.state);
  for (const bad of [/(^|[^\\])!?\[[^\]]*\]\(/m, /(^|[^\\])</m, /(^|[^\\])`/m]) {
    // a raw, unescaped trigger may only come from our own generated text
    const hits = p.split('\n').filter((l) => bad.test(l) && !/^Coordinates|^- (Apply|Scope|Target)|^Image:/.test(l));
    assert.deepEqual(hits, [], String(bad));
  }
  assert.match(p, /example\.invalid\/p/); // URLs stay readable as text
  assert.match(p, /\\\\\\\[escaped\\\]\(javascript:1\)/); // user backslash is itself escaped, so it cannot unescape our escape
});

test('FINAL-05: reference boards appear in the brief and in Core.included', () => {
  const s = mk();
  s.addBoard({ id: 'b2', title: 'Reference', width: 100, height: 100 });
  s.addAnnotation('b1', { text: 'match the reference', targets: [{ kind: 'pin', x: 1, y: 1 }] });
  assert.equal(Core.included(s.state.boards[1], false), false);
  assert.doesNotMatch(Core.buildPrompt(s.state), /Reference screenshot/);
  s.updateBoard('b2', { reference: true });
  assert.equal(Core.included(s.state.boards[1], false), true);
  assert.match(Core.buildPrompt(s.state), /## Reference\n\nImage: screen-2-annotated\.png \(100 × 100 px\)\. Reference screenshot/);
  assert.throws(() => s.updateBoard('b2', { reference: 'yes' }));
});

test('FINAL-08: aggregate pixel budget is enforced by validateProject', () => {
  const s = new Core.Store();
  for (let i = 0; i < 6; i++) s.addBoard({ id: 'p' + i, title: 't', width: 4000, height: 4000 }); // 96 MP = limit
  assert.throws(() => s.addBoard({ id: 'over', title: 't', width: 10, height: 10 }), /megapixel/);
  assert.equal(Core.MAX_PIXELS, 96000000);
});
