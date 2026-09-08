const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { groupTeacherAttempts } = require('../src/server/teacherDetail');
const { buildXlsx } = require('../src/server/excel');
const { buildDrawingWorkbook } = require('../src/server/teacherExport');
const { CANVAS_EXPORT_CONTRACT } = require('../src/server/exportContract');
const { buildDrawingDecisionWorkbook, decisionColumns, evaluationColumns } = require('../src/server/decisionLog');

async function workbookContract(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1]);
  const sheets = [];
  for (let index = 0; index < names.length; index += 1) {
    const xml = await zip.file(`xl/worksheets/sheet${index + 1}.xml`).async('string');
    const header = xml.match(/<row r="1">([\s\S]*?)<\/row>/)?.[1] || '';
    sheets.push([names[index], [...header.matchAll(/<t xml:space="preserve">([\s\S]*?)<\/t>/g)].map((match) => match[1])]);
  }
  return sheets;
}

test('teacher detail counts one student with two attempts as one joined participant', () => {
  const rows = [
    { participant_id: 'student-1', display_name: 'Alex', student_number: 'Alex', created_at: '2026-01-01', workspace_id: 'attempt-2', attempt_number: 2, status: 'draft' },
    { participant_id: 'student-1', display_name: 'Alex', student_number: 'Alex', created_at: '2026-01-01', workspace_id: 'attempt-1', attempt_number: 1, status: 'submitted' }
  ];
  const detail = groupTeacherAttempts(rows, (row) => ({ id: row.workspace_id, status: row.status, attemptNumber: row.attempt_number }));
  assert.equal(detail.summary.joinedCount, 1);
  assert.equal(detail.summary.submittedCount, 1);
  assert.equal(detail.summary.attemptCount, 2);
  assert.equal(detail.summary.submittedAttemptCount, 1);
  assert.deepEqual(detail.participants[0].attempts.map((attempt) => attempt.attemptNumber), [2, 1]);
});

test('Excel builder emits a valid workbook with named sheets', async () => {
  const buffer = await buildXlsx([{ name: 'canvas_operations', columns: [{ key: 'id', label: 'id' }], rows: [{ id: 'one' }] }]);
  const zip = await JSZip.loadAsync(buffer);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  assert.match(workbook, /name="canvas_operations"/);
  assert.ok(zip.file('xl/worksheets/sheet1.xml'));
});

test('DrawBreath research workbook keeps the Chinese-system sheet contract', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const buffer = await buildDrawingWorkbook(pool, { id: 'task-1', title: 'Task', created_at: new Date(), updated_at: new Date() });
  assert.deepEqual(await workbookContract(buffer), CANVAS_EXPORT_CONTRACT);
});

test('DrawBreath AI decision workbook keeps its two English audit sheets and fields', async () => {
  const buffer = await buildDrawingDecisionWorkbook({ decisions: [], evaluations: [] });
  assert.deepEqual(await workbookContract(buffer), [
    ['ai_decisions', decisionColumns.map((column) => column.label)],
    ['review_evaluations', evaluationColumns.map((column) => column.label)]
  ]);
});
