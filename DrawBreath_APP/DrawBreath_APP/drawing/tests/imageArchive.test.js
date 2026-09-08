const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');
const { buildTaskImageArchive } = require('../src/server/imageArchive');

test('drawing image archive groups artwork and snapshots by student and records missing files', async (t) => {
  const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drawing-image-archive-'));
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(uploadRoot, 'backgrounds'));
  fs.mkdirSync(path.join(uploadRoot, 'workspaces'));
  fs.writeFileSync(path.join(uploadRoot, 'backgrounds', 'task.png'), Buffer.from('background'));
  fs.writeFileSync(path.join(uploadRoot, 'workspaces', 'final.png'), Buffer.from('final'));
  fs.writeFileSync(path.join(uploadRoot, 'workspaces', 'snapshot.png'), Buffer.from('snapshot'));

  const archive = await buildTaskImageArchive({
    uploadRoot,
    task: { id: 'task-1', title: 'Drawing task', background_path: 'backgrounds/task.png' },
    participants: [{ participant_id: 'participant-12345678', workspace_id: 'workspace-1', attempt_number: 1, display_name: 'Ada', student_number: 'Class/01', status: 'submitted', final_image_path: 'workspaces/final.png', draft_image_path: null, submitted_at: '2026-08-12T00:00:00.000Z' }],
    snapshots: [
      { id: 1, sequence: 1, participant_id: 'participant-12345678', workspace_id: 'workspace-1', attempt_number: 1, student_number: 'Class/01', image_path: 'workspaces/snapshot.png', active_seconds: 30, operation_count: 4, created_at: '2026-08-12T00:00:00.000Z' },
      { id: 2, sequence: 2, participant_id: 'participant-12345678', workspace_id: 'workspace-1', attempt_number: 1, student_number: 'Class/01', image_path: 'workspaces/missing.png', active_seconds: 60, operation_count: 8, created_at: '2026-08-12T00:01:00.000Z' }
    ]
  });
  const zip = await JSZip.loadAsync(archive);
  assert.ok(zip.file('templates/practice.png'));
  assert.ok(zip.file('Class-01/practice/attempt-001/snapshots/000001_legacy.png'));
  assert.ok(zip.file('manifest.json'));
  assert.ok(zip.file('missing-files.json'));
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.templateFileCount, 1);
  assert.equal(manifest.snapshotFileCount, 1);
  assert.equal(manifest.missingFileCount, 1);
  assert.equal(manifest.missingFiles[0].reason, 'file_not_found');
  assert.deepEqual(Object.keys(manifest), ['experimentId', 'title', 'generatedAt', 'fileCount', 'snapshotFileCount', 'templateFileCount', 'missingFileCount', 'files', 'missingFiles']);
  const template = manifest.files.find((item) => item.type === 'template');
  const snapshot = manifest.files.find((item) => item.type === 'snapshot');
  assert.deepEqual(Object.keys(template).sort(), ['filename', 'originalName', 'phase', 'sha256', 'type'].sort());
  assert.deepEqual(Object.keys(snapshot).sort(), ['type', 'snapshotId', 'sessionId', 'studentCode', 'phase', 'attemptNumber', 'snapshotKind', 'sampleIndex', 'activeSeconds', 'operationSeq', 'visualVersion', 'snapshotReason', 'mimeType', 'fileSize', 'filename', 'sha256'].sort());
});

test('drawing image archive rejects stored paths outside the upload directory', async (t) => {
  const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drawing-image-archive-'));
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
  const archive = await buildTaskImageArchive({
    uploadRoot,
    task: { id: 'task-2', title: 'Drawing task', background_path: '../outside.png' },
    participants: [], snapshots: []
  });
  const zip = await JSZip.loadAsync(archive);
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.fileCount, 0);
  assert.equal(manifest.missingFiles[0].reason, 'invalid_path');
});
