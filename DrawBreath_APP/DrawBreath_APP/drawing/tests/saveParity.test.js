const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const web = fs.readFileSync(path.join(root, 'src', 'web', 'App.jsx'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src', 'server', 'app.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations', '009_save_process_parity.sql'), 'utf8');

test('DrawBreath uses an 800 ms draft save and fixed configured snapshot cadence', () => {
  assert.match(web, /DRAWING_DRAFT_SAVE_DELAY_MS = 800/);
  assert.match(web, /const interval = Math\.max\(0, Number\(state\.task\.snapshotIntervalSeconds\) \|\| 0\)/);
  assert.match(web, /active < lastSnapshotActiveSecondsRef\.current \+ interval/);
  assert.doesNotMatch(web, /adaptiveSnapshotIntervalSeconds/);
  assert.doesNotMatch(web, /DRAWING_SNAPSHOT_JITTER_SECONDS/);
});

test('DrawBreath separates full draft PNGs from compressed process snapshots', () => {
  assert.match(web, /processSnapshot: \(\) => composite\(960, 'image\/webp', 0\.68\)/);
  assert.match(web, /baselineSnapshot: \(\) => composite\(1200\)/);
  assert.match(web, /captureSnapshot, snapshotKind/);
  assert.match(server, /const captureSnapshot = req\.body\.captureSnapshot === true/);
  assert.match(server, /if \(!captureSnapshot\) return res\.json/);
  assert.match(server, /saveSnapshotDataUrl\(req\.body\.snapshotImage \|\| req\.body\.image/);
  assert.match(migration, /snapshot_kind/);
});
