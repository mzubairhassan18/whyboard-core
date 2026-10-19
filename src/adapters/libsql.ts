/**
 * Shared helpers for any adapter that talks the SQLite/libSQL wire protocol
 * (local CSV mirrors and remote Turso databases).
 */
import type { Client, InArgs, InStatement } from '@libsql/client';
import type { ColumnInfo, QueryResult, TableInfo, UniversalAdapter } from '../types.js';
import { assertReadOnly } from '../util/sql.js';
import { countRows, fromNativeType, toJsonSafe } from '../util/values.js';

export interface LibsqlAdapterOptions {
  /** Cap on rows returned by {@link runQuery}. */
  maxRows?: number;
  /** Only expose these tables (case-sensitive). */
  tables?: string[] | undefined;
}

export const DEFAULT_MAX_ROWS = 50_000;

export function mapLibsqlResult(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  rowCount: number,
  limit: number,
): QueryResult {
  const out = rows.slice(0, limit).map((row) => {
    const record: Record<string, unknown> = {};
    for (const column of columns) record[column] = toJsonSafe(row[column]);
    return record;
  });
  return {
    columns: [...columns],
    rows: out,
    rowCount,
    truncated: rowCount > out.length,
  };
}

/** Runs a guarded, read-only statement through a libSQL client. */
export async function runQuery(
  client: Client,
  sql: string,
  params: readonly unknown[] = [],
  maxRows = DEFAULT_MAX_ROWS,
): Promise<QueryResult> {
  const statement = assertReadOnly(sql);
  const result = await client.execute({
    sql: statement,
    args: params as InArgs,
  });
  return mapLibsqlResult(
    result.columns,
    result.rows as unknown as Record<string, unknown>[],
    result.rows.length,
    maxRows,
  );
}

export async function listSqliteTables(
  client: Client,
  options: LibsqlAdapterOptions = {},
): Promise<TableInfo[]> {
  const names = await client.execute({
    sql: "select name from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name",
    args: [],
  });
  const tables: TableInfo[] = [];
  for (const row of names.rows) {
    const name = String(row.name);
    if (options.tables && !options.tables.includes(name)) continue;
    tables.push(await describeSqliteTable(client, name));
  }
  return tables;
}

export async function describeSqliteTable(client: Client, table: string): Promise<TableInfo> {
  const info = await client.execute({
    sql: 'select * from pragma_table_info(?)',
    args: [table],
  });

  const columns: ColumnInfo[] = info.rows.map((row) => ({
    name: String(row.name),
    type: fromNativeType(isBlankSqliteType(row.type) ? undefined : String(row.type)),
    nativeType: String(row.type ?? ''),
    nullable: Number(row.notnull ?? 0) === 0,
    primaryKey: Number(row.pk ?? 0) > 0,
  }));

  let rowCount: number | undefined;
  try {
    const counted = await client.execute({
      sql: `select count(*) as n from "${table.replace(/"/g, '""')}"`,
      args: [],
    });
    rowCount = countRows(counted.rows[0]?.n);
  } catch {
    rowCount = undefined;
  }

  return { name: table, columns, ...(rowCount != null ? { rowCount } : {}) };
}

function isBlankSqliteType(type: unknown): boolean {
  const text = String(type ?? '').trim();
  return text === '' || text.toUpperCase() === 'BLOB';
}

/** Resolves a user/model supplied table name against the real schema. */
export function matchTable(tables: readonly TableInfo[], name: string): TableInfo | undefined {
  const needle = name.trim().toLowerCase();
  return (
    tables.find((table) => table.name === name.trim()) ??
    tables.find((table) => table.name.toLowerCase() === needle) ??
    tables.find((table) => table.name.toLowerCase().endsWith(needle))
  );
}

/** Resolves a column name against a table, tolerating case and spacing drift. */
export function matchColumn(table: TableInfo, name: string): ColumnInfo | undefined {
  const needle = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (
    table.columns.find((column) => column.name === name.trim()) ??
    table.columns.find((column) => column.name.toLowerCase() === needle) ??
    table.columns.find((column) => column.name.toLowerCase().replace(/[\s-]+/g, '_') === needle)
  );
}

export function closeQuietly(target: { close(): void }): void {
  try {
    target.close();
  } catch {
    // closing an already-closed client is not an error worth surfacing
  }
}

export function assertLive(adapter: UniversalAdapter): void {
  if (!adapter) throw new Error('Whyboard: no adapter configured.');
}
