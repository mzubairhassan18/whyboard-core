/**
 * whyboard-core — shared types.
 *
 * Everything in here is deliberately framework-free: adapters, templates and the
 * AI layer all speak these types, so a new adapter only has to satisfy
 * {@link UniversalAdapter}.
 */

/** Logical column type every adapter normalises to. */
export type ColumnType =
  | 'text'
  | 'integer'
  | 'real'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json'
  | 'unknown';

export interface ColumnInfo {
  name: string;
  type: ColumnType;
  /** The adapter's native type string, when it has one (e.g. `VARCHAR(255)`). */
  nativeType?: string;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  /**
   * Best-effort row count. Exact for SQLite/libSQL/CSV, estimated for Postgres.
   */
  rowCount?: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** `true` when the adapter capped the result set before returning it. */
  truncated?: boolean;
}

/**
 * The only contract an adapter must satisfy.
 *
 * Adapters are read-only by contract: whyboard never writes to a customer
 * database. {@link UniversalAdapter.query} may therefore reject anything that
 * is not a single `SELECT`/`WITH` statement.
 */
export interface UniversalAdapter {
  /** Identifier used in traces and errors, e.g. `csv`, `turso`, `postgres`. */
  readonly kind: string;
  /** Every table the adapter can see, with columns and (best-effort) row counts. */
  listTables(): Promise<TableInfo[]>;
  describeTable(table: string): Promise<TableInfo>;
  query(sql: string, params?: readonly unknown[]): Promise<QueryResult>;
  /** Release pooled connections / file handles. Safe to call more than once. */
  close(): Promise<void>;
}

/** Compact schema view handed to the detective model. */
export interface TableSummary {
  name: string;
  rowCount?: number;
  columns: ColumnInfo[];
}

export type Confidence = 'low' | 'medium' | 'high';

/**
 * A template is domain knowledge: the voice the storyteller writes in, the
 * "why" questions a user is likely to ask, and detection signals so whyboard can
 * pick a template automatically from the connected schema.
 */
export interface Template {
  id: string;
  name: string;
  description: string;
  /** Persona + writing rules for the storyteller model. */
  voice: string;
  /** Steers the detective: what counts as a useful "why" in this domain. */
  detectiveHints: string[];
  /** Ready-made questions to show in a UI. */
  heroQuestions: string[];
  /** Table/column name fragments used for auto-detection (lowercased, substring match). */
  signals: string[];
  /** Optional domain vocabulary, e.g. `{ MQL: 'marketing qualified lead' }`. */
  glossary?: Record<string, string>;
}

/** One tool call made by the detective, in order. */
export interface TraceEntry {
  index: number;
  tool: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  ms: number;
}

/** One SQL statement executed against the user's data. */
export interface SqlTrace {
  sql: string;
  purpose?: string;
  rowCount: number;
  ms: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelCall {
  phase: 'detective' | 'storyteller';
  provider: ProviderName;
  model: string;
  ms: number;
  usage?: Usage;
}

/** A single quantified reason. */
export interface Finding {
  /** Short name of the driver, e.g. "Salary expectations". */
  label: string;
  /** One or two sentences of explanation. */
  detail: string;
  /** Quantified share of the effect, e.g. "38% of all rejections". */
  impact?: string;
  /** The numbers behind the claim, e.g. "112 of 291 rejections". */
  evidence?: string;
}

export interface Findings {
  headline: string;
  answer: string;
  confidence: Confidence;
  drivers: Finding[];
  numbers: { label: string; value: string }[];
  caveats: string[];
  suggestedNextQuestions: string[];
}

export interface WhyboardTrace {
  provider: ProviderName;
  model: string;
  durationMs: number;
  /** Every tool call the detective made. */
  steps: TraceEntry[];
  /** Every read-only query run against the data, deduplicated. */
  queries: SqlTrace[];
  modelCalls: ModelCall[];
  usage: Usage;
}

export interface ExplainResult {
  question: string;
  /** The story, as markdown — the thing you render. */
  answer: string;
  headline: string;
  confidence: Confidence;
  findings: Findings;
  trace: WhyboardTrace;
}

export type ProviderName = 'grok' | 'openai' | 'gateway';

/** Progress events emitted by {@link Whyboard.explainStream}. */
export type ExplainEvent =
  | { type: 'thought'; text: string }
  | { type: 'tool'; tool: string; input: Record<string, unknown> }
  | { type: 'tool-result'; tool: string }
  | { type: 'answer-delta'; text: string }
  | { type: 'done'; result: ExplainResult }
  | { type: 'error'; message: string };
