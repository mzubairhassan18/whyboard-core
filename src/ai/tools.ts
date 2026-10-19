import { tool } from 'ai';
import { z } from 'zod';
import type { ColumnInfo, TableInfo, UniversalAdapter, Findings } from '../types.js';
import { assertReadOnly, quoteIdent, type SqlDialect } from '../util/sql.js';
import { compactForTrace, type Collector } from './trace.js';

/** Rows handed to the model per tool call. The full set stays in the trace. */
const MODEL_ROWS = 30;

export interface ToolContext {
  adapter: UniversalAdapter;
  /** Schema, already loaded by the detective. */
  tables: TableInfo[];
  collector: Collector;
  /** Hard cap on rows a single query may return. */
  maxRows: number;
  /** Domain hints from the active template. */
  hints: string[];
}

export const findingsSchema = z.object({
  headline: z.string().describe('One line, 6-12 words, no full stop. The single biggest reason.'),
  answer: z
    .string()
    .describe('2-4 sentences that directly answer the question, every claim carrying a number.'),
  confidence: z.enum(['low', 'medium', 'high']).describe('How well the data supports the answer.'),
  drivers: z
    .array(
      z.object({
        label: z.string().describe('Short name of the driver, 2-5 words.'),
        detail: z.string().describe('One or two sentences explaining the mechanism.'),
        impact: z.string().optional().describe('e.g. "38% of all rejections"'),
        evidence: z.string().optional().describe('The raw numbers, e.g. "112 of 291 rejections"'),
      }),
    )
    .min(1)
    .describe('Ranked reasons, biggest first.'),
  numbers: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .describe('The headline figures quoted in the answer.'),
  caveats: z.array(z.string()).describe('What the data cannot tell you. Empty array if none.'),
  suggestedNextQuestions: z
    .array(z.string())
    .min(1)
    .describe('2-3 follow-up "why" questions worth asking next.'),
});

export type InvestigationTools = ReturnType<typeof buildInvestigatorTools>;

/**
 * The detective's toolbox. Every tool is read-only and every failure comes back
 * as `{ error }` so the model can correct itself instead of the run dying.
 */
export function buildInvestigatorTools(ctx: ToolContext) {
  const dialect: SqlDialect = ctx.adapter.kind === 'postgres' ? 'postgres' : 'sqlite';

  return {
    list_tables: tool({
      description:
        'List every table with its row count and columns. Call this first if you are unsure of the schema.',
      inputSchema: z.object({}),
      execute: async () =>
        exec(ctx, 'list_tables', {}, async () => ({
          tables: ctx.tables.map((table) => ({
            name: table.name,
            rowCount: table.rowCount ?? null,
            columns: table.columns.map((column) => `${column.name}:${column.type}`),
          })),
        })),
    }),

    describe_table: tool({
      description:
        'Column-by-column detail for one table, including null counts and min/max/average for numeric columns. Use it before writing non-trivial SQL.',
      inputSchema: z.object({ table: z.string().describe('Table name exactly as listed.') }),
      execute: async ({ table }) =>
        exec(ctx, 'describe_table', { table }, async () => {
          const target = requireTable(ctx, table);
          const stats = await columnStats(ctx, target, dialect);
          return {
            table: target.name,
            rowCount: target.rowCount ?? null,
            columns: target.columns.map((column) => ({
              name: column.name,
              type: column.type,
              ...(stats[column.name] ?? {}),
            })),
          };
        }),
    }),

    run_sql: tool({
      description:
        'Run a read-only SELECT/WITH query and see the first rows. Use for anything the purpose-built tools do not cover. Only SELECT is allowed.',
      inputSchema: z.object({
        sql: z.string().describe('A single SELECT statement.'),
        purpose: z.string().describe('What this query is meant to prove, in a few words.'),
      }),
      execute: async ({ sql, purpose }) =>
        exec(ctx, 'run_sql', { sql, purpose }, async () => {
          const result = await runSafe(ctx, sql, purpose);
          return {
            sql: result.sql,
            rowCount: result.rowCount,
            truncated: result.truncated ?? false,
            columns: result.columns,
            rows: result.rows.slice(0, MODEL_ROWS),
          };
        }),
    }),

    value_counts: tool({
      description:
        'Distinct values of a column with counts and shares. Use it to find the categories behind an outcome (e.g. which statuses exist and how often).',
      inputSchema: z.object({
        table: z.string(),
        column: z.string(),
        where: z.string().optional().describe('SQL boolean expression, no WHERE keyword.'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ table, column, where, limit }) =>
        exec(ctx, 'value_counts', { table, column, where, limit }, async () => {
          const target = requireTable(ctx, table);
          const target_column = requireColumn(target, column);
          const filter = sanitizeWhere(where, target.name);
          const k = limit ?? 15;
          const rows = await runSafe(
            ctx,
            `select ${quoteIdent(target_column.name)} as value, count(*) as rows
               from ${quoteIdent(target.name)}
               ${filter ? `where ${filter}` : ''}
               group by 1
               order by rows desc
               limit ${k}`,
            'value counts',
          );
          const totals = await runSafe(
            ctx,
            `select count(*) as rows, count(distinct ${quoteIdent(target_column.name)}) as distinct_values
               from ${quoteIdent(target.name)} ${filter ? `where ${filter}` : ''}`,
            'value counts totals',
          );
          const total = num(totals.rows[0]?.rows) ?? 0;
          return {
            table: target.name,
            column: target_column.name,
            total,
            distinctValues: num(totals.rows[0]?.distinct_values) ?? null,
            values: rows.rows.map((row) => ({
              value: row.value,
              rows: num(row.rows) ?? 0,
              pct: pct(num(row.rows) ?? 0, total),
            })),
            note: `Showing the top ${k} values by frequency.`,
          };
        }),
    }),

    breakdown: tool({
      description:
        'Group by one dimension and aggregate a metric — the fastest way to find WHICH segment drives an outcome. Answer questions like "why is the rejection rate 70%?" with the segment that causes it.',
      inputSchema: z.object({
        table: z.string(),
        dimension: z.string().describe('Column to group by, e.g. "source" or "stage".'),
        metric: z
          .string()
          .optional()
          .describe('Numeric column to aggregate. Omit to compare row counts.'),
        agg: z.enum(['sum', 'avg', 'min', 'max', 'count']).optional(),
        where: z.string().optional().describe('SQL boolean expression, no WHERE keyword.'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ table, dimension, metric, agg, where, limit }) =>
        exec(ctx, 'breakdown', { table, dimension, metric, agg, where, limit }, async () => {
          const target = requireTable(ctx, table);
          const dimensionColumn = requireColumn(target, dimension);
          const metricColumn = metric ? requireColumn(target, metric) : undefined;
          const method = (agg ?? (metricColumn ? 'sum' : 'count')).toUpperCase();
          if (method !== 'COUNT' && !metricColumn) {
            throw new Error(
              `breakdown with agg="${method}" needs a numeric "metric" column. Pass metric or use agg="count".`,
            );
          }
          const filter = sanitizeWhere(where, target.name);
          const k = limit ?? 20;
          const metricExpr = metricColumn ? `${method}(${quoteIdent(metricColumn.name)})` : 'count(*)';
          const aggregateLabel = metricColumn
            ? `${method.toLowerCase()}(${metricColumn.name})`
            : 'count of rows';

          const grouped = await runSafe(
            ctx,
            `select ${quoteIdent(dimensionColumn.name)} as value, count(*) as rows, ${metricExpr} as metric
               from ${quoteIdent(target.name)} ${filter ? `where ${filter}` : ''}
               group by 1 order by rows desc limit ${k}`,
            'breakdown by dimension',
          );
          const totals = await runSafe(
            ctx,
            `select count(*) as rows, ${metricColumn ? `${metricExpr} as metric` : 'null as metric'}
               from ${quoteIdent(target.name)} ${filter ? `where ${filter}` : ''}`,
            'breakdown totals',
          );

          const totalRows = num(totals.rows[0]?.rows) ?? 0;
          const totalMetric = num(totals.rows[0]?.metric);
          const groups = grouped.rows.map((row) => {
            const rowsCount = num(row.rows) ?? 0;
            const metricValue = num(row.metric);
            return {
              value: row.value,
              rows: rowsCount,
              metric: metricValue,
              pctOfRows: pct(rowsCount, totalRows),
              pctOfMetric: pct(metricValue ?? 0, totalMetric ?? 0),
            };
          });
          const shownRows = groups.reduce((sum, group) => sum + group.rows, 0);
          const shownMetric = groups.reduce((sum, group) => sum + (group.metric ?? 0), 0);
          const remainingRows = totalRows - shownRows;

          return {
            table: target.name,
            dimension: dimensionColumn.name,
            aggregate: aggregateLabel,
            total: { rows: totalRows, metric: totalMetric },
            groups,
            other:
              remainingRows > 0
                ? {
                    rows: remainingRows,
                    metric: totalMetric != null ? round(totalMetric - shownMetric) : null,
                    pctOfRows: pct(remainingRows, totalRows),
                    pctOfMetric: totalMetric ? pct(round(totalMetric - shownMetric), totalMetric) : null,
                    note: `${remainingRows} rows fall outside the top ${k} values.`,
                  }
                : null,
          };
        }),
    }),

    trend: tool({
      description:
        'Bucket a table over time and aggregate a metric. Use it to find WHEN something changed and what happened before/after the change.',
      inputSchema: z.object({
        table: z.string(),
        dateColumn: z.string().describe('Date or timestamp column.'),
        metric: z.string().optional().describe('Numeric column to aggregate.'),
        agg: z.enum(['sum', 'avg', 'min', 'max', 'count']).optional(),
        granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
        where: z.string().optional().describe('SQL boolean expression, no WHERE keyword.'),
      }),
      execute: async ({ table, dateColumn, metric, agg, granularity, where }) =>
        exec(
          ctx,
          'trend',
          { table, dateColumn, metric, agg, granularity, where },
          async () => {
            const target = requireTable(ctx, table);
            const date = requireColumn(target, dateColumn);
            const metricColumn = metric ? requireColumn(target, metric) : undefined;
            const method = (agg ?? (metricColumn ? 'sum' : 'count')).toUpperCase();
            const filter = sanitizeWhere(where, target.name);
            const bucket = bucketExpr(quoteIdent(date.name), granularity ?? 'month', dialect);
            const metricExpr = metricColumn ? `${method}(${quoteIdent(metricColumn.name)})` : 'count(*)';

            const result = await runSafe(
              ctx,
              `select ${bucket} as bucket, count(*) as rows, ${metricExpr} as metric
                 from ${quoteIdent(target.name)}
                 where ${quoteIdent(date.name)} is not null ${filter ? `and (${filter})` : ''}
                 group by 1 order by 1`,
              'trend over time',
            );

            const buckets = result.rows.map((row) => ({
              bucket: row.bucket,
              rows: num(row.rows) ?? 0,
              metric: num(row.metric) ?? null,
            }));
            const first = buckets[0];
            const last = buckets[buckets.length - 1];
            let peak: { bucket: unknown; metric: number | null; rows: number } | undefined;
            let trough: { bucket: unknown; metric: number | null; rows: number } | undefined;
            for (const point of buckets) {
              const value = point.metric ?? point.rows;
              if (!peak || value > (peak.metric ?? peak.rows)) peak = point;
              if (!trough || value < (trough.metric ?? trough.rows)) trough = point;
            }

            return {
              table: target.name,
              dateColumn: date.name,
              granularity: granularity ?? 'month',
              aggregate: metricColumn ? `${method.toLowerCase()}(${metricColumn.name})` : 'count of rows',
              buckets,
              firstBucket: first ?? null,
              lastBucket: last ?? null,
              peak: peak ?? null,
              trough: trough ?? null,
              change: change(first?.metric ?? first?.rows ?? 0, last?.metric ?? last?.rows ?? 0),
            };
          },
        ),
    }),

    correlate: tool({
      description:
        'Pearson correlation between two numeric columns across all rows. Use it to check whether two numbers move together before claiming a relationship.',
      inputSchema: z.object({
        table: z.string(),
        columnA: z.string(),
        columnB: z.string(),
        where: z.string().optional().describe('SQL boolean expression, no WHERE keyword.'),
      }),
      execute: async ({ table, columnA, columnB, where }) =>
        exec(ctx, 'correlate', { table, columnA, columnB, where }, async () => {
          const target = requireTable(ctx, table);
          const a = requireColumn(target, columnA);
          const b = requireColumn(target, columnB);
          const filter = sanitizeWhere(where, target.name);
          const result = await runSafe(
            ctx,
            `select ${quoteIdent(a.name)} as a, ${quoteIdent(b.name)} as b
               from ${quoteIdent(target.name)}
               where ${quoteIdent(a.name)} is not null and ${quoteIdent(b.name)} is not null
               ${filter ? `and (${filter})` : ''}
               limit 20000`,
            'correlation',
          );
          const pairs: [number, number][] = [];
          for (const row of result.rows) {
            const x = num(row.a);
            const y = num(row.b);
            if (x != null && y != null) pairs.push([x, y]);
          }
          const r = pearson(pairs);
          return {
            table: target.name,
            columns: [a.name, b.name],
            n: pairs.length,
            r: r == null ? null : round(r, 4),
            interpretation:
              r == null
                ? 'Not enough numeric pairs to correlate.'
                : `${Math.abs(r) < 0.2 ? 'Almost no' : Math.abs(r) < 0.5 ? 'A weak' : Math.abs(r) < 0.8 ? 'A moderate' : 'A strong'} ${r < 0 ? 'negative' : 'positive'} relationship. Correlation is not causation.`,
          };
        }),
    }),

    sample_rows: tool({
      description: 'A few raw rows, to see the shape of the data.',
      inputSchema: z.object({
        table: z.string(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ table, limit }) =>
        exec(ctx, 'sample_rows', { table, limit }, async () => {
          const target = requireTable(ctx, table);
          const result = await runSafe(
            ctx,
            `select * from ${quoteIdent(target.name)} limit ${limit ?? 5}`,
            'sample rows',
          );
          return { table: target.name, rows: result.rows.slice(0, limit ?? 5) };
        }),
    }),

    report_findings: tool({
      description:
        'Call this exactly once, when you have quantified the answer. It ends the investigation.',
      inputSchema: findingsSchema,
      execute: async (findings) =>
        exec(ctx, 'report_findings', findings as Record<string, unknown>, async () => ({
          received: true,
        })),
    }),
  };
}

// ------------------------------------------------------------------ internals

interface RunOutcome {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated?: boolean;
}

async function runSafe(
  ctx: ToolContext,
  sql: string,
  purpose: string,
): Promise<RunOutcome> {
  const statement = assertReadOnly(sql);
  const limited = /\blimit\b/i.test(statement) ? statement : `${statement}\nlimit ${ctx.maxRows}`;
  const started = Date.now();
  const result = await ctx.adapter.query(limited);
  ctx.collector.recordQuery({
    sql: limited,
    purpose,
    rowCount: result.rowCount,
    ms: Date.now() - started,
  });
  return {
    sql: limited,
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    truncated: result.truncated,
  };
}

async function exec<T>(
  ctx: ToolContext,
  toolName: string,
  input: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T | { error: string }> {
  const started = Date.now();
  try {
    const output = await run();
    ctx.collector.record({
      tool: toolName,
      input,
      output: compactForTrace(output),
      ms: Date.now() - started,
    });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.collector.record({ tool: toolName, input, error: message, ms: Date.now() - started });
    return { error: message };
  }
}

function requireTable(ctx: ToolContext, name: string): TableInfo {
  const needle = name.trim().toLowerCase();
  const found =
    ctx.tables.find((table) => table.name === name.trim()) ??
    ctx.tables.find((table) => table.name.toLowerCase() === needle) ??
    ctx.tables.find((table) => table.name.toLowerCase().endsWith(needle));
  if (!found) {
    throw new Error(
      `Unknown table "${name}". Available tables: ${ctx.tables.map((table) => table.name).join(', ') || '(none)'}.`,
    );
  }
  return found;
}

function requireColumn(table: TableInfo, name: string): ColumnInfo {
  const needle = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const normalize = (value: string) => value.toLowerCase().replace(/[\s-]+/g, '_');
  const found =
    table.columns.find((column) => column.name === name.trim()) ??
    table.columns.find((column) => normalize(column.name) === needle);
  if (!found) {
    throw new Error(
      `Unknown column "${name}" on table "${table.name}". Available columns: ${table.columns
        .map((column) => column.name)
        .join(', ')}.`,
    );
  }
  return found;
}

/** Validates a model-supplied WHERE fragment by compiling a probe statement. */
function sanitizeWhere(where: string | undefined, table: string): string | undefined {
  if (where == null || where.trim() === '') return undefined;
  assertReadOnly(`select 1 from ${quoteIdent(table)} where ${where}`);
  return where.trim();
}

async function columnStats(
  ctx: ToolContext,
  table: TableInfo,
  dialect: SqlDialect,
): Promise<Record<string, Record<string, unknown>>> {
  if (table.columns.length === 0) return {};
  const parts: string[] = ['count(*) as __rows'];
  const wanted: string[] = [];
  for (const column of table.columns.slice(0, 40)) {
    const alias = quoteIdent(column.name);
    const key = column.name.replace(/[^A-Za-z0-9_]/g, '_');
    wanted.push(column.name);
    parts.push(`count(${alias}) as cnt_${key}`);
    parts.push(`count(distinct ${alias}) as dst_${key}`);
    if (['integer', 'real', 'date', 'datetime'].includes(column.type)) {
      parts.push(`min(${alias}) as min_${key}`);
      parts.push(`max(${alias}) as max_${key}`);
    }
    if (['integer', 'real'].includes(column.type)) {
      parts.push(`avg(${alias}) as avg_${key}`);
    }
  }
  try {
    const result = await runSafe(
      ctx,
      `select ${parts.join(', ')} from ${quoteIdent(table.name)}`,
      `statistics for ${table.name} (${dialect})`,
    );
    const row = result.rows[0] ?? {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const name of wanted) {
      const key = name.replace(/[^A-Za-z0-9_]/g, '_');
      const rows = num(row[`cnt_${key}`]);
      const total = num(row.__rows) ?? 0;
      out[name] = {
        nonNull: rows,
        nulls: zone(total - (rows ?? 0)),
        distinct: num(row[`dst_${key}`]) ?? null,
        min: row[`min_${key}`] ?? null,
        max: row[`max_${key}`] ?? null,
        avg: row[`avg_${key}`] == null ? null : round(num(row[`avg_${key}`]) ?? 0, 3),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function bucketExpr(column: string, granularity: string, dialect: SqlDialect): string {
  if (dialect === 'postgres') {
    const cast = `${column}::timestamp`;
    switch (granularity) {
      case 'day':
        return `to_char(${cast}, 'YYYY-MM-DD')`;
      case 'week':
        return `to_char(${cast}, 'IYYY-"W"IW')`;
      case 'quarter':
        return `to_char(${cast}, 'YYYY-"Q"Q')`;
      case 'year':
        return `to_char(${cast}, 'YYYY')`;
      default:
        return `to_char(${cast}, 'YYYY-MM')`;
    }
  }
  switch (granularity) {
    case 'day':
      return `date(${column})`;
    case 'week':
      return `strftime('%Y-W%W', ${column})`;
    case 'quarter':
      return `(strftime('%Y', ${column}) || '-Q' || ((cast(strftime('%m', ${column}) as integer) + 2) / 3))`;
    case 'year':
      return `strftime('%Y', ${column})`;
    default:
      return `strftime('%Y-%m', ${column})`;
  }
}

function pearson(pairs: readonly [number, number][]): number | undefined {
  const n = pairs.length;
  if (n < 3) return undefined;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denominator === 0) return undefined;
  return numerator / denominator;
}

function change(from: number, to: number): { from: number; to: number; delta: number; pct: number | null } {
  const delta = round(to - from);
  return { from, to, delta, pct: from === 0 ? null : round((delta / Math.abs(from)) * 100, 1) };
}

function num(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function pct(part: number, total: number): number | null {
  if (!total) return null;
  return round((part / total) * 100, 1);
}

function zone(value: number): number {
  return value < 0 ? 0 : value;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export type { Findings };
