import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertReadOnly, ensureLimit, hasLimit, toIdentifier } from '../src/util/sql.js';
import { inferColumn, parseNumber, toJsonSafe } from '../src/util/values.js';
import { renderSchema, rowsToMarkdown } from '../src/util/format.js';
import { detectTemplate, getTemplate, templates } from '../src/templates/index.js';

test('read-only guard accepts SELECT and WITH', () => {
  assert.equal(assertReadOnly('select * from t'), 'select * from t');
  assert.equal(
    assertReadOnly('with x as (select 1) select * from x'),
    'with x as (select 1) select * from x',
  );
  assert.equal(assertReadOnly('  select 1;  '), 'select 1');
});

test('read-only guard rejects writes and stacked statements', () => {
  assert.throws(() => assertReadOnly('delete from t'), /read-only/i);
  assert.throws(() => assertReadOnly('drop table t'), /read-only/i);
  assert.throws(() => assertReadOnly('select 1; delete from t'), /one statement/i);
  assert.throws(() => assertReadOnly('select * into copy from t'), /read-only/i);
  assert.throws(() => assertReadOnly(''), /empty/i);
});

test('read-only guard is not fooled by data values or column names', () => {
  assert.doesNotThrow(() =>
    assertReadOnly("select * from t where status = 'deleted' and note = 'drop table x'"),
  );
  assert.doesNotThrow(() => assertReadOnly('select created_at, updated_at from t'));
  assert.doesNotThrow(() => assertReadOnly('select 1 -- delete from t'));
  assert.doesNotThrow(() => assertReadOnly('select 1 /* drop table t */'));
});

test('limit helpers', () => {
  assert.equal(hasLimit('select * from t limit 5'), true);
  assert.equal(hasLimit('select * from t'), false);
  assert.equal(ensureLimit('select * from t', 10), 'select * from t\nLIMIT 10');
  assert.equal(ensureLimit('select * from t limit 3', 10), 'select * from t limit 3');
});

test('toIdentifier normalises headers', () => {
  assert.equal(toIdentifier('Salary Expectation'), 'Salary_Expectation');
  assert.equal(toIdentifier('  $$$  '), 'value');
  assert.equal(toIdentifier('2025 total'), '_2025_total');
});

test('parseNumber handles currency, thousands and negatives', () => {
  assert.equal(parseNumber('$1,234.50'), 1234.5);
  assert.equal(parseNumber('(42)'), -42);
  assert.equal(parseNumber('12%'), 12);
  assert.equal(parseNumber('1.2k'), 1200);
  assert.equal(parseNumber('n/a'), undefined);
  assert.equal(parseNumber(''), undefined);
});

test('inferColumn detects types from samples', () => {
  assert.equal(inferColumn('salary', ['90000', '95000', '$105,000']).type, 'integer');
  assert.equal(inferColumn('rate', ['1.5', '2.25']).type, 'real');
  assert.equal(inferColumn('applied_at', ['2025-01-06', '2025-02-28']).type, 'date');
  assert.equal(
    inferColumn('created_at', ['2025-01-06T10:00:00Z', '2025-02-28T11:30:00Z']).type,
    'datetime',
  );
  assert.equal(inferColumn('outcome', ['rejected', 'offer']).type, 'text');
});

test('toJsonSafe keeps values JSON-safe', () => {
  assert.equal(toJsonSafe(10n), 10);
  assert.equal(toJsonSafe(12n ** 20n), (12n ** 20n).toString());
  assert.equal(toJsonSafe(Number.NaN), null);
  assert.equal(toJsonSafe(new Uint8Array([1, 2, 3])), '<3 bytes>');
});

test('rowsToMarkdown renders a table', () => {
  const markdown = rowsToMarkdown(['source', 'n'], [{ source: 'LinkedIn', n: 3 }]);
  assert.match(markdown, /\| source \| n \|/);
  assert.match(markdown, /\| LinkedIn \| 3 \|/);
});

test('renderSchema includes tables, rows and columns', () => {
  const schema = renderSchema([
    { name: 'orders', rowCount: 1200, columns: [{ name: 'id', type: 'integer' }] },
  ]);
  assert.match(schema, /orders — 1,200 rows/);
  assert.match(schema, /id\(integer\)/);
});

test('template registry resolves by id and detects from schema', () => {
  assert.equal(getTemplate('jobseeker')?.id, 'jobseeker');
  assert.equal(getTemplate('ECOMMERCE')?.id, 'ecommerce');
  assert.equal(getTemplate('nope'), undefined);
  assert.equal(templates.length, 3);

  const jobSeekerSchema = [
    {
      name: 'applications',
      columns: [
        { name: 'application_id', type: 'integer' as const },
        { name: 'source', type: 'text' as const },
        { name: 'stage', type: 'text' as const },
      ],
    },
  ];
  assert.equal(detectTemplate(jobSeekerSchema)?.id, 'jobseeker');

  const shopSchema = [
    {
      name: 'orders',
      columns: [
        { name: 'order_id', type: 'integer' as const },
        { name: 'sku', type: 'text' as const },
        { name: 'gmv', type: 'real' as const },
      ],
    },
  ];
  assert.equal(detectTemplate(shopSchema)?.id, 'ecommerce');

  const unrelated = [
    { name: 'sensor_readings', columns: [{ name: 'celsius', type: 'real' as const }] },
  ];
  assert.equal(detectTemplate(unrelated), undefined);
});
