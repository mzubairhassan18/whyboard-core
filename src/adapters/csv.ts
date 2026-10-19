import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createClient, type Client, type InArgs, type InStatement } from '@libsql/client';
import Papa from 'papaparse';
import type { QueryResult, TableInfo, UniversalAdapter } from '../types.js';
import { toIdentifier } from '../util/sql.js';
import { coerceCell, inferColumn, type InferredColumn } from '../util/values.js';
import {
  closeQuietly,
  describeSqliteTable,
  listSqliteTables,
  runQuery,
  type LibsqlAdapterOptions,
} from './libsql.js';

export type { LibsqlAdapterOptions } from './libsql.js';

export interface CsvSource {
  /** Table name for this file. Defaults to the file name. */
  name?: string;
  /** The CSV text itself. */
  content: string;
}

export interface CsvAdapterOptions extends LibsqlAdapterOptions {
  /** Raw CSV text, or one/more named files. */
  source: string | CsvSource | CsvSource[];
  /** Table name for a single unnamed CSV source. */
  tableName?: string;
  /** Override the delimiter when PapaParse's sniffing gets it wrong. */
  delimiter?: string;
  /** Mirror the parsed rows into a remote libSQL/Turso database instead of memory. */
  url?: string;
  authToken?: string;
  /** Rows imported per file. Defaults to 500,000. */
  importLimit?: number;
  /** Rows sampled for type inference. Defaults to 1,000. */
  sampleSize?: number;
}

const INSERT_CHUNK = 400;

/**
 * Loads CSV text into an in-memory (or remote) libSQL database and exposes it as
 * a normal SQL table, so every whyboard tool works on CSVs exactly as it does on
 * a live database.
 *
 * ```ts
 * const adapter = await csvAdapter({ source: csvText, tableName: 'applications' });
 * ```
 */
export class CSVAdapter implements UniversalAdapter {
  readonly kind = 'csv';

  private readonly options: CsvAdapterOptions;
  private readonly client: Client;
  private readonly maxRows: number;
  private readonly loaded: Promise<TableInfo[]>;
  /** Logical (CSV-inferred) types, which SQLite's storage classes cannot express. */
  private readonly logical = new Map<string, TableInfo>();

  constructor(options: CsvAdapterOptions) {
    this.options = options;
    this.maxRows = options.maxRows ?? 50_000;
    this.client = createClient({
      url: options.url ?? 'file::memory:',
      ...(options.authToken ? { authToken: options.authToken } : {}),
    });
    this.loaded = this.load();
    // If a caller never awaits the load, do not surface it as an unhandled rejection.
    void this.loaded.catch(() => {});
  }

  /** Convenience: load one or more CSV files straight off disk. */
  static async fromFiles(
    paths: string | string[],
    options: Omit<CsvAdapterOptions, 'source'> = {},
  ): Promise<CSVAdapter> {
    const list = Array.isArray(paths) ? paths : [paths];
    const sources: CsvSource[] = [];
    for (const path of list) {
      sources.push({
        name: basename(path, extname(path)),
        content: await readFile(path, 'utf8'),
      });
    }
    return new CSVAdapter({ ...options, source: sources });
  }

  async listTables(): Promise<TableInfo[]> {
    const created = await this.loaded;
    if (created.length === 0) return listSqliteTables(this.client, this.options);
    return created;
  }

  async describeTable(table: string): Promise<TableInfo> {
    await this.loaded;
    return this.logical.get(table) ?? describeSqliteTable(this.client, table);
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    await this.loaded;
    return runQuery(this.client, sql, params, this.maxRows);
  }

  async close(): Promise<void> {
    // Let an in-flight import finish so we never close the client mid-batch.
    await this.loaded.catch(() => undefined);
    closeLibsql(this.client);
  }

  // ---------------------------------------------------------------- internals

  private async load(): Promise<TableInfo[]> {
    const sources = normaliseSources(this.options);
    const tables: TableInfo[] = [];

    for (const source of sources) {
      const table = uniqueName(
        toIdentifier(source.name, `table_${tables.length + 1}`),
        tables.map((t) => t.name),
      );
      const parsed = Papa.parse<Record<string, string>>(source.content.replace(/^\uFEFF/, ''), {
        header: true,
        skipEmptyLines: 'greedy',
        ...(this.options.delimiter ? { delimiter: this.options.delimiter } : {}),
      });

      const rawFields = (parsed.meta.fields ?? []).filter((field) => field != null);
      const headers = dedupe(rawFields.map((field, index) => toIdentifier(field, `col_${index + 1}`)));
      const rows = (parsed.data ?? []).slice(0, this.options.importLimit ?? 500_000);

      if (headers.length === 0) {
        throw new Error(
          `CSV "${source.name}" has no header row. whyboard needs a header row to name columns.`,
        );
      }

      const sampleSize = this.options.sampleSize ?? 1_000;
      const columns: InferredColumn[] = headers.map((header, index) =>
        inferColumn(
          header,
          rows.slice(0, sampleSize).map((row) => row[rawFields[index] ?? header] ?? ''),
        ),
      );

      await this.createTable(table, columns);
      await this.insertRows(table, columns, headers, rawFields, rows);

      // PRAGMA only knows SQLite storage classes, so merge back the logical types
      // inferred from the CSV (date/boolean/real vs integer).
      const info = await describeSqliteTable(this.client, table);
      const inferred = new Map(columns.map((column) => [column.name, column]));
      const enriched: TableInfo = {
        ...info,
        columns: info.columns.map((column) => ({
          ...column,
          type: inferred.get(column.name)?.type ?? column.type,
        })),
      };
      this.logical.set(table, enriched);
      tables.push(enriched);
    }

    return tables;
  }

  private async createTable(table: string, columns: readonly InferredColumn[]): Promise<void> {
    const definition = columns
      .map((column) => `${quote(column.name)} ${sqlTypeFor(column)}`)
      .join(', ');
    await this.client.execute(`create table if not exists ${quote(table)} (${definition})`);
  }

  private async insertRows(
    table: string,
    columns: readonly InferredColumn[],
    headers: readonly string[],
    rawFields: readonly string[],
    rows: readonly Record<string, string>[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const columnList = columns.map((column) => quote(column.name)).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `insert into ${quote(table)} (${columnList}) values (${placeholders})`;

    for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
      const chunk = rows.slice(offset, offset + INSERT_CHUNK);
      const statements: InStatement[] = chunk.map((row) => ({
        sql,
        args: columns.map((column, index) =>
          coerceCell(row[rawFields[index] ?? headers[index] ?? ''] ?? '', column),
        ) as InArgs,
      }));
      await this.client.batch(statements, 'write');
    }
  }
}

/** Ready-to-use CSV adapter. */
export function csvAdapter(options: CsvAdapterOptions): Promise<CSVAdapter> {
  return (async () => new CSVAdapter(options))();
}

/** Ready-to-use CSV adapter from file paths. */
export function csvFromFiles(
  paths: string | string[],
  options: Omit<CsvAdapterOptions, 'source'> = {},
): Promise<CSVAdapter> {
  return CSVAdapter.fromFiles(paths, options);
}

// ------------------------------------------------------------------- helpers

function normaliseSources(options: CsvAdapterOptions): { name: string; content: string }[] {
  const { source } = options;
  if (typeof source === 'string') {
    return [{ name: options.tableName ?? 'data', content: source }];
  }
  if (Array.isArray(source)) {
    return source.map((entry, index) => ({
      name: entry.name ?? options.tableName ?? `table_${index + 1}`,
      content: entry.content,
    }));
  }
  return [{ name: source.name ?? options.tableName ?? 'data', content: source.content }];
}

function sqlTypeFor(column: InferredColumn): string {
  if (column.type === 'integer') return 'INTEGER';
  if (column.type === 'real') return 'REAL';
  return 'TEXT';
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function dedupe(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

function uniqueName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  let index = 2;
  while (taken.includes(`${name}_${index}`)) index += 1;
  return `${name}_${index}`;
}

function closeLibsql(client: Client): void {
  closeQuietly(client);
}
