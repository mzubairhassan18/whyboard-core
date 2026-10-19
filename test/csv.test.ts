import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CSVAdapter } from '../src/adapters/csv.js';
import { detectTemplate } from '../src/templates/index.js';

const csv = await readFile(new URL('./fixtures/applications.csv', import.meta.url), 'utf8');

function adapter(): CSVAdapter {
  return new CSVAdapter({ source: { name: 'applications', content: csv } });
}

test('CSVAdapter mirrors a CSV into a queryable table', async () => {
  const db = adapter();
  try {
    const tables = await db.listTables();
    assert.equal(tables.length, 1);
    assert.equal(tables[0]?.name, 'applications');
    assert.equal(tables[0]?.rowCount, 24);

    const columns = tables[0]?.columns ?? [];
    const byName = new Map(columns.map((column) => [column.name, column]));
    assert.equal(byName.get('applied_at')?.type, 'date');
    assert.equal(byName.get('salary_expectation')?.type, 'integer');
    assert.equal(byName.get('days_to_response')?.type, 'integer');
    assert.equal(byName.get('source')?.type, 'text');
  } finally {
    await db.close();
  }
});

test('CSVAdapter supports aggregate SQL', async () => {
  const db = adapter();
  try {
    const result = await db.query(
      `select source, count(*) as applications, sum(case when outcome = 'rejected' then 1 else 0 end) as rejections
         from applications group by source order by applications desc`,
    );
    assert.equal(result.columns.join(','), 'source,applications,rejections');
    assert.equal(result.rowCount, 3);
    assert.deepEqual(result.rows[0], { source: 'LinkedIn', applications: 11, rejections: 8 });
    assert.deepEqual(result.rows[1], { source: 'Referral', applications: 7, rejections: 1 });
    assert.deepEqual(result.rows[2], { source: 'Job board', applications: 6, rejections: 5 });
  } finally {
    await db.close();
  }
});

test('CSVAdapter refuses writes and multiple statements', async () => {
  const db = adapter();
  try {
    await assert.rejects(() => db.query('delete from applications'), /read-only/i);
    await assert.rejects(() => db.query('select 1; drop table applications'), /one statement/i);
  } finally {
    await db.close();
  }
});

test('CSVAdapter can load several files at once', async () => {
  const db = new CSVAdapter({
    source: [
      { name: 'applications', content: csv },
      { name: 'notes', content: 'id,note\n1,hello\n2,world\n' },
    ],
  });
  try {
    const tables = await db.listTables();
    assert.deepEqual(
      tables.map((table) => table.name),
      ['applications', 'notes'],
    );
    const notes = await db.query('select count(*) as n from notes');
    assert.equal(notes.rows[0]?.n, 2);
  } finally {
    await db.close();
  }
});

test('schema auto-detects the job seeker template', async () => {
  const db = adapter();
  try {
    const template = detectTemplate(await db.listTables());
    assert.equal(template?.id, 'jobseeker');
  } finally {
    await db.close();
  }
});
