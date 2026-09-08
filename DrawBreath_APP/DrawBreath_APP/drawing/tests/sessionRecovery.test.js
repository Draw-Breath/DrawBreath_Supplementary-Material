const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const web = fs.readFileSync(path.join(root, 'src', 'web', 'App.jsx'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'web', 'main.jsx'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src', 'server', 'app.js'), 'utf8');

test('DrawBreath does not let stale student restoration override a selected login mode', () => {
  assert.match(web, /if \(!studentToken \|\| studentState \|\| role\) return undefined/);
  assert.match(web, /let active = true/);
  assert.match(web, /if \(!active\) return/);
  assert.match(web, /return \(\) => \{ active = false; \}/);
});

test('DrawBreath validates restored state and repairs legacy participants without a workspace', () => {
  assert.match(web, /const isStudentStudioState/);
  assert.match(web, /state\?\.task && state\?\.workspace/);
  assert.match(web, /Incomplete drawing workspace state/);
  assert.match(server, /WHERE NOT EXISTS \(SELECT 1 FROM workspaces WHERE participant_id = \$2\)/);
});

test('DrawBreath has a recoverable page-level rendering fallback', () => {
  assert.match(main, /class AppErrorBoundary/);
  assert.match(main, /getDerivedStateFromError/);
  assert.match(main, /window\.location\.reload\(\)/);
});

test('DrawBreath resumes the same participant for repeated and legacy student logins', () => {
  const join = server.slice(server.indexOf("app.post('/api/student/join'"), server.indexOf("app.get('/api/student/me'"));
  assert.match(server, /task-platform-participant:\$\{taskId\}:\$\{studentKey\(name\)\}/);
  assert.match(server, /p\.student_account_id IS NULL/);
  assert.match(server, /regexp_replace\(btrim\(p\.student_number\), '\[\[:space:\]\]\+', ' ', 'g'\)/);
  assert.match(server, /UPDATE participants SET student_account_id = \$1/);
  assert.match(join, /const existing = await participantForStudent\(client, task\.id, account, name\)/);
  assert.match(join, /if \(existing\)/);
  assert.match(join, /session_version=session_version\+1/);
  assert.match(join, /if \(task\.status !== 'active'\).*This task is no longer open/);
});
