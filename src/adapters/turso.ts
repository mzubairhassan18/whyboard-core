import { createClient, type Client } from '@libsql/client';
import type { QueryResult, TableInfo, UniversalAdapter } from '../types.js';
import { closeQuietly, listSqliteTables, describeSqliteTable, runQuery, type LibsqlAdapterOptions } from './libsql.js';

export type { LibsqlAdapterOptions } from './libsql.js';

export interface TursoAdapterOptions extends LibsqlAdapterOptions {
  /**
   * `libsql://…`, `https://…`, `file:local.db` or `file::memory:` —
   * anything `@libsql/client` accepts.
   */
  url: string;
  authToken?: string;
}

/**
 * Any libSQL/Turso/SQLite database, local or remote.
 *
 * ```ts
 * const adapter = new TursoAdapter({
 *   url: process.env.TURSO_DATABASE_URL!,
 *   authToken: process.env.TURSO_AUTH_TOKEN,
 * });
 * ```
 */
export class TursoAdapter implements UniversalAdapter {
  readonly kind = 'turso';

  private readonly client: Client;
  private readonly options: LibsqlAdapterOptions;
  private readonly maxRows: number;

  constructor(options: TursoAdapterOptions) {
    this.options = { maxRows: options.maxRows, tables: options.tables };
    this.maxRows = options.maxRows ?? 50_000;
    this.client = createClient({
      url: options.url,
      ...(options.authToken ? { authToken: options.authToken } : {}),
    });
  }

  /** Opens the adapter and verifies connectivity up-front. */
  static async open(options: TursoAdapterOptions): Promise<TursoAdapter> {
    const adapter = new TursoAdapter(options);
    await adapter.ping();
    return adapter;
  }

  async ping(): Promise<void> {
    await this.client.execute('select 1');
  }

  async listTables(): Promise<TableInfo[]> {
    return listSqliteTables(this.client, this.options);
  }

  async describeTable(table: string): Promise<TableInfo> {
    return describeSqliteTable(this.client, table);
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    return runQuery(this.client, sql, params, this.maxRows);
  }

  async close(): Promise<void> {
    closeQuietly(this.client);
  }
}

/** Alias that reads better in a config file: `await whyboardSqlite({ url })`. */
export function tursoAdapter(options: TursoAdapterOptions): Promise<TursoAdapter> {
  return TursoAdapter.open(options);
}
