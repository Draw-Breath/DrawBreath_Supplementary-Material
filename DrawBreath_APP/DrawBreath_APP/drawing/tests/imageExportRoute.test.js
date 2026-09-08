const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');

const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drawing-image-route-'));
process.env.UPLOAD_DIR = uploadRoot;
process.env.JWT_SECRET = 'drawing-image-route-test-secret-32-characters';
process.env.APP_DISPLAY_NAME = 'Renamed Drawing';
fs.mkdirSync(path.join(uploadRoot, 'backgrounds'));
fs.mkdirSync(path.join(uploadRoot, 'workspaces'));
fs.writeFileSync(path.join(uploadRoot, 'backgrounds', 'task.png'), Buffer.from('background'));
fs.writeFileSync(path.join(uploadRoot, 'workspaces', 'final.png'), Buffer.from('final'));
fs.writeFileSync(path.join(uploadRoot, 'workspaces', 'snapshot.png'), Buffer.from('snapshot'));

const teacherId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const participantId = '00000000-0000-4000-8000-000000000003';
const queries = [];
const pool = {
  query: async (sql, params = []) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).startsWith('SELECT 1 FROM staff_users')) return { rowCount: 1, rows: [{}] };
    if (String(sql).startsWith('SELECT * FROM tasks')) return { rowCount: 1, rows: [{ id: taskId, owner_id: teacherId, title: 'Route test', background_path: 'backgrounds/task.png' }] };
    if (String(sql).includes('FROM participants p JOIN workspaces')) return { rowCount: 1, rows: [{ participant_id: participantId, workspace_id: '00000000-0000-4000-8000-000000000004', attempt_number: 1, display_name: 'Ada', student_number: 'Ada', status: 'submitted', draft_image_path: null, final_image_path: 'workspaces/final.png', submitted_at: new Date('2026-08-12T00:00:00Z') }] };
    if (String(sql).includes('FROM canvas_snapshots s')) return { rowCount: 1, rows: [{ id: 1, image_path: 'workspaces/snapshot.png', active_seconds: 30, operation_count: 4, created_at: new Date('2026-08-12T00:00:00Z'), participant_id: participantId, workspace_id: '00000000-0000-4000-8000-000000000004', attempt_number: 1, student_number: 'Ada', sequence: 1 }] };
    throw new Error(`Unexpected query in image export route test: ${String(sql).slice(0, 100)}`);
  }
};

const dbPath = require.resolve('../src/server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };
const { tokenFor } = require('../src/server/auth');
const app = require('../src/server/app');

test('teacher image export endpoint returns an owned task as a ZIP archive', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/teacher/tasks/${taskId}/images.zip`, {
    headers: { Authorization: `Bearer ${tokenFor(teacherId, 'teacher')}` }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /Renamed%20Drawing-.*-canvas-images\.zip/);
  assert.equal(response.headers.get('x-canvas-snapshot-count'), '1');
  assert.deepEqual(queries[1].params, [taskId, teacherId]);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  assert.ok(zip.file('templates/practice.png'));
  assert.ok(zip.file('Ada/practice/attempt-001/snapshots/000001_legacy.png'));
  assert.ok(zip.file('manifest.json'));
});

test.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
