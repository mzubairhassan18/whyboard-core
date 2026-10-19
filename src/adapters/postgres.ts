import type { ColumnInfo, QueryResult, TableInfo, UniversalAdapter } from '../types.js';
import { assertReadOnly } from '../util/sql.js';
import { countRows, fromNativeType, toJsonSafe } from '../util/values.js';

/**
 * `pg` is an optional peer dependency: whyboard-core stays installable without it,
 * and only users of {@link PostgresAdapter} pull in a driver.
 *
 * ```bash
 * npm i pg
 * ```
 */

interface PgQueryResult {
  rows: Record<string, unknown>[];
  fields: { name: string }[];
  rowCount: number | null;
}

interface PgClient {
  query(sql: string, params?: readonly unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

interface PgConstructor {
  new (config: {
    connectionString: string;
    ssl?: boolean | { rejectUnauthorized: boolean };
    application_name?: string;
  }): PgClient;
}

// Kept in a variable so TypeScript does not require `pg` to be installed at build time.
const PG_MODULE: string = 'pg';

export interface PostgresAdapterOptions {
  /** e.g. `postgresql://user:pass@host:5432/db` */
  connectionString: string;
  /** Schema to introspect. Defaults to `public`. */
  schema?: string;
  ssl?: boolean;
  /** Cap on rows returned by {@link PostgresAdapter.query}. */
  maxRows?: number;
}

/**
 * Any Postgres database, read-only.
 *
 * ```ts
 * const adapter = new PostgresAdapter({ connectionString: process.env.DATABASE_URL! });
 * ```
 */
export class PostgresAdapter implements UniversalAdapter {
  readonly kind = 'postgres';

  private readonly options: PostgresAdapterOptions;
  private readonly schemaName: string;
  private readonly maxRows: number;
  private client?: PgClient;
  private connecting?: Promise<PgClient>;

  constructor(options: PostgresAdapterOptions) {
    this.options = options;
    this.schemaName = options.schema ?? 'public';
    this.maxRows = options.maxRows ?? 50_000;
  }

  async ping(): Promise<void> {
    const client = await this.connection();
    await client.query('select 1');
  }

  async listTables(): Promise<TableInfo[]> {
    const client = await this.connection();
    const tables = await client.query(
      `select c.relname as name, c.reltuples::bigint as estimated_rows
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm')
        order by c.relname`,
      [this.schemaName],
    );
    const columns = await client.query(
      `select table_name, column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = $1
        order by table_name, ordinal_position`,
      [this.schemaName],
    );

    const byTable = new Map<string, ColumnInfo[]>();
    for (const row of columns.rows) {
      const table = String(row.table_name);
      const list = byTable.get(table) ?? [];
      list.push({
        name: String(row.column_name),
        type: fromNativeType(String(row.data_type)),
        nativeType: String(row.data_type),
        nullable: String(row.is_nullable).toUpperCase() === 'YES',
      });
      byTable.set(table, list);
    }

    return tables.rows.map((row) => {
      const name = String(row.name);
      const estimated = countRows(row.estimated_rows);
      return {
        name,
        columns: byTable.get(name) ?? [],
        ...(estimated != null && estimated >= 0 ? { rowCount: estimated } : {}),
      } satisfies TableInfo;
    });
  }

  async describeTable(table: string): Promise<TableInfo> {
    const client = await this.connection();
    const columns = await client.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = $1 and table_name = $2
        order by ordinal_position`,
      [this.schemaName, table],
    );
    if (columns.rows.length === 0) {
      throw new Error(`Unknown table "${table}" in schema "${this.schemaName}".`);
    }

    const primaryKeys = await client.query(
      `select kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
          and kcu.table_schema = tc.table_schema
        where tc.constraint_type = 'primary key'
          and tc.table_schema = $1 and tc.table_name = $2`,
      [this.schemaName, table],
    );
    const keys = new Set(primaryKeys.rows.map((row) => String(row.column_name)));

    return {
      name: table,
      columns: columns.rows.map((row) => ({
        name: String(row.column_name),
        type: fromNativeType(String(row.data_type)),
        nativeType: String(row.data_type),
        nullable: String(row.is_nullable).toUpperCase() === 'YES',
        primaryKey: keys.has(String(row.column_name)),
      })),
    };
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const client = await this.connection();
    const statement = assertReadOnly(sql);
    const result = await client.query(statement, params);
    const columns = result.fields.map((field) => field.name);
    const allRows = result.rows as Record<string, unknown>[];
    const rows = allRows.slice(0, this.maxRows).map((row) => {
      const record: Record<string, unknown> = {};
      for (const column of columns) record[column] = toJsonSafe(row[column]);
      return record;
    });
    return {
      columns,
      rows,
      rowCount: result.rowCount ?? allRows.length,
      truncated: allRows.length > rows.length,
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client) await client.end();
  }

  private connection(): Promise<PgClient> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      let ctor: PgConstructor;
      try {
        const mod = (await import(PG_MODULE)) as { Client?: PgConstructor; default?: { Client?: PgConstructor } };
        const resolved = mod.Client ?? mod.default?.Client;
        if (!resolved) throw new Error('pg did not export a Client');
        ctor = resolved;
      } catch (error) {
        throw new Error(
          'PostgresAdapter needs the "pg" driver. Install it with: npm i pg\n' +
            `(original error: ${error instanceof Error ? error.message : String(error)})`,
        );
      }
      const client = new ctor({
        connectionString: this.options.connectionString,
        ...(this.options.ssl != null ? { ssl: this.options.ssl } : {}),
        application_name: 'whyboard-core',
      });
      this.client = client;
      return client;
    })();
    return this.connecting;
  }
}

/** Ready-to-use Postgres adapter. */
export async function postgresAdapter(
  options: PostgresAdapterOptions,
): Promise<PostgresAdapter> {
  const adapter = new PostgresAdapter(options);
  await adapter.ping();
  return adapter;
}
