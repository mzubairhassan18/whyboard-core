import type { TableInfo, TableSummary } from '../types.js';
import { toJsonSafe } from './values.js';

/** Single-line preview of a cell, so markdown tables never explode. */
export function cell(value: unknown, max = 60): string {
  const json = toJsonSafe(value);
  if (json == null) return '';
  const text = typeof json === 'string' ? json : JSON.stringify(json);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Renders a result set as a GitHub-flavoured markdown table. */
export function rowsToMarkdown(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  maxRows = 25,
): string {
  if (columns.length === 0) return '_(no columns)_';
  if (rows.length === 0) return '_(no rows)_';
  const shown = rows.slice(0, maxRows);
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = shown
    .map((row) => `| ${columns.map((column) => cell(row[column]).replace(/\|/g, '\\|')).join(' | ')} |`)
    .join('\n');
  const more = rows.length > shown.length ? `\n\n_… ${rows.length - shown.length} more rows_` : '';
  return `${header}\n${divider}\n${body}${more}`;
}

/** Compact, model-friendly schema description. */
export function renderSchema(tables: readonly (TableInfo | TableSummary)[]): string {
  if (tables.length === 0) return '(no tables found)';
  return tables
    .map((table) => {
      const rows = table.rowCount != null ? ` — ${table.rowCount.toLocaleString('en-US')} rows` : '';
      const columns = table.columns
        .map((column) => `${column.name}(${column.type})`)
        .join(', ');
      return `- ${table.name}${rows}\n  ${columns}`;
    })
    .join('\n');
}

export function titleCase(input: string): string {
  return input
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Extracts the first fenced SQL block, or the raw text, from a model reply. */
export function extractSql(text: string): string | undefined {
  const fenced = /```(?:sql)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  if (!/^(select|with)\b/i.test(candidate)) return undefined;
  return candidate;
}
