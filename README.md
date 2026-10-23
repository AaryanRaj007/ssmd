# SSMD: screenshot markup

Local, no-server tool. Drop or paste screenshots, mark pins/areas/groups/moves/arrows, write instructions, then download a handoff zip (`feedback.md`, `feedback.json`, annotated PNGs) for a developer or AI coding agent.

- Run: open `index.html` in a browser. No build, no dependencies.
- Autosaves to this browser (IndexedDB). Use Project > Save editable project for a portable copy.
- Privacy: the Redact tool (R) permanently blacks out an area of the screenshot itself (workspace, saved projects, every export). Undo cannot restore it. Without redaction, handoff PNGs and project files contain the full screenshot pixels. Nothing is uploaded; there is no network code.
- Copy instructions: `Replacement text:` is always exported (empty means delete the text, written as `""`). `Current text:` is omitted when left blank, meaning unknown.
- Tabs: ＋ New adds screenshots, × closes a tab (Undo restores it). “Include as reference” sends a screenshot with no instructions.
- Redaction scope: it masks that screenshot, identical copies in the open workspace, the stored workspace, and every export or project saved afterwards. Already-downloaded files, other tabs (told to reload), original image files, clipboard contents and typed text are not changed. Saving is confirmed before the app says it is saved; if it cannot be, the status says an older copy remains.
- Undo/redo: ⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z, Ctrl+Y; the last 60 steps of this session (not kept across reload). Undo never throws away an unsaved draft. Redaction is the one thing Undo cannot restore.
- Limits: 16,000 px per side, 48 MP per screenshot, 96 MP across the workspace (about 384 MB decoded), 30 screenshots, 20 MB per file.
- Markdown export treats your text as data: `[ ] < `` are escaped so links, images, HTML and code fences stay literal.
- Mark without a pointer: Instruction editor > Target details > Add by coordinates (pin, area, arrow, move), then edit the numeric fields.
- Several tabs: the first tab to save wins. A stale tab stops autosaving, says so, and can still Save editable project; reload it to continue.
- Touch: use two fingers to pan a zoomed screenshot.
- Test (Node 20+, run in `ssmd/`): `node --test test/core.test.mjs` for core logic (no deps). `SSMD_PW=<dir with node_modules/patchright> node --test test/app.test.mjs` for browser regressions (uses playwright if installed; skips without a browser lib). Pass file paths, not the `test/` directory.
