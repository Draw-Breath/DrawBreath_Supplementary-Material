const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drawing-task-create-'));
process.env.UPLOAD_DIR = uploadRoot;
process.env.JWT_SECRET = 'drawing-task-test-secret-at-least-32-characters';

let insertQuery;
let failInsert = false;
const pool = {
  query: async (sql, params = []) => {
    if (String(sql).startsWith('SELECT 1 FROM staff_users')) return { rowCount: 1, rows: [{}] };
    if (String(sql).includes('INSERT INTO tasks')) {
      insertQuery = { sql: String(sql), params };
      if (failInsert) throw Object.assign(new Error('simulated database failure'), { code: 'XX000' });
      return {
        rowCount: 1,
        rows: [{
          id: params[0], owner_id: params[1], title: params[2], join_code: params[3],
          background_path: params[5], time_limit_seconds: params[6], ai_policy: params[18],
          student_exit_enabled: params[8], student_whitelist_enabled: params[9], voice_enabled: params[10]
        }]
      };
    }
    throw new Error(`Unexpected query in task creation test: ${String(sql).slice(0, 80)}`);
  }
};

const dbPath = require.resolve('../src/server/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };
const { tokenFor } = require('../src/server/auth');
const app = require('../src/server/app');

async function requestTask(server) {
  const form = new FormData();
  form.append('title', 'Independent drawing');
  form.append('timeLimitMinutes', '15');
  form.append('newAttemptsAllowed', 'false');
  const pngHeader = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(pngHeader);
  pngHeader.writeUInt32BE(1200, 16);
  pngHeader.writeUInt32BE(800, 20);
  form.append('background', new Blob([pngHeader], { type: 'image/png' }), 'background.png');
  return fetch(`http://127.0.0.1:${server.address().port}/api/teacher/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor('00000000-0000-4000-8000-000000000001', 'teacher')}` },
    body: form
  });
}

async function listen() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server;
}

test('drawing task creation uses the paper task prompt independently from the title', { concurrency: false }, async (t) => {
  const server = await listen();
  t.after(() => server.close());
  const response = await requestTask(server);
  assert.equal(response.status, 201);
  assert.match(insertQuery.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5,/);
  assert.equal(insertQuery.params.length, 33);
  assert.equal(insertQuery.params[2], 'Independent drawing');
  assert.equal(insertQuery.params[4], 'Create an original drawing by incorporating, extending, or reinterpreting the provided shape.');
  assert.deepEqual(insertQuery.params.slice(-5), [1200, 800, false, 'background.png', 'image/png']);
});

test('drawing task creation removes the uploaded background after a database failure', { concurrency: false }, async (t) => {
  failInsert = true;
  const server = await listen();
  t.after(() => { failInsert = false; server.close(); });
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalConsoleError; });
  const backgroundDirectory = path.join(uploadRoot, 'backgrounds');
  const before = fs.readdirSync(backgroundDirectory).sort();
  const response = await requestTask(server);
  assert.equal(response.status, 500);
  assert.deepEqual(fs.readdirSync(backgroundDirectory).sort(), before);
});

test.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
