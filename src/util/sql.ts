/**
 * SQL hygiene: whyboard only ever reads. These helpers make that a guarantee
 * rather than a promise.
 */

export class WhyboardError extends Error {
  readonly code: string;

  constructor(message: string, code = 'WHYBOARD_ERROR') {
    super(message);
    this.name = 'WhyboardError';
    this.code = code;
  }
}

export type SqlDialect = 'sqlite' | 'postgres';

const READ_ONLY_START = /^(select|with)\b/i;

/**
 * Keywords that must never appear outside a string literal. `create` is matched
 * with word boundaries so columns like `created_at` are unaffected, and string
 * literals are masked before the scan so `where status = 'deleted'` still works.
 */
const WRITE_KEYWORDS =
  /\b(pragma|attach|detach|insert|update|delete|drop|alter|create|replace|vacuum|reindex|truncate|grant|revoke|begin|commit|rollback|savepoint|analyze|copy)\b/i;

/**
 * Single pass over the statement that removes comments while honouring string
 * literals, and produces a parallel "masked" copy where literal contents are
 * replaced with `x` so keyword scanning cannot be fooled by data values.
 */
function scrub(sql: string): { clean: string; masked: string } {
  let clean = '';
  let masked = '';
  let i = 0;

  while (i < sql.length) {
    const char = sql[i]!;
    const next = sql[i + 1];

    // line comment
    if (char === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      clean += ' ';
      masked += ' ';
      continue;
    }

    // block comment
    if (char === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      clean += ' ';
      masked += ' ';
      continue;
    }

    // single-quoted string literal ('' is an escaped quote)
    if (char === "'") {
      clean += char;
      masked += char;
      i += 1;
      while (i < sql.length) {
        const inner = sql[i]!;
        if (inner === "'" && sql[i + 1] === "'") {
          clean += "''";
          masked += 'xx';
          i += 2;
          continue;
        }
        if (inner === "'") {
          clean += "'";
          masked += "'";
          i += 1;
          break;
        }
        clean += inner;
        masked += 'x';
        i += 1;
      }
      continue;
    }

    // double-quoted / backticked / bracketed identifier
    if (char === '"' || char === '`') {
      const closing = char;
      clean += char;
      masked += char;
      i += 1;
      while (i < sql.length) {
        const inner = sql[i]!;
        clean += inner;
        masked += inner;
        i += 1;
        if (inner === closing) break;
      }
      continue;
    }

    clean += char;
    masked += char;
    i += 1;
  }

  return { clean, masked };
}

/** Cheap preview for error messages. */
export function previewSql(sql: string, max = 160): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Throws unless `sql` is a single read-only `SELECT`/`WITH` statement, and
 * returns the statement with comments removed and any trailing `;` stripped.
 */
export function assertReadOnly(sql: string): string {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new WhyboardError('Empty SQL statement.', 'SQL_EMPTY');
  }

  const { clean, masked } = scrub(sql);
  const trimmed = masked.trim();

  if (!READ_ONLY_START.test(trimmed)) {
    throw new WhyboardError(
      `whyboard is read-only: only SELECT/WITH statements are allowed (got: ${previewSql(sql)}).`,
      'SQL_NOT_READ_ONLY',
    );
  }

  if (trimmed.replace(/;+$/, '').includes(';')) {
    throw new WhyboardError(
      `Only one statement per query is allowed (got: ${previewSql(sql)}).`,
      'SQL_MULTIPLE_STATEMENTS',
    );
  }

  const keyword = WRITE_KEYWORDS.exec(trimmed);
  if (keyword) {
    throw new WhyboardError(
      `whyboard is read-only: "${keyword[1]}" is not allowed inside a query (got: ${previewSql(sql)}).`,
      'SQL_NOT_READ_ONLY',
    );
  }

  return clean.trim().replace(/;+\s*$/, '');
}

/** True when the statement already caps its own result set. */
export function hasLimit(sql: string): boolean {
  return /\blimit\b/i.test(scrub(sql).masked);
}

/**
 * Appends a `LIMIT` when the statement does not already have one, so the
 * detective cannot accidentally stream a million rows into a prompt.
 */
export function ensureLimit(sql: string, maxRows: number): string {
  const statement = assertReadOnly(sql);
  if (hasLimit(statement)) return statement;
  return `${statement}\nLIMIT ${Math.max(1, Math.floor(maxRows))}`;
}

/** Quotes an identifier for SQLite and Postgres (both use ANSI double quotes). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Turns arbitrary text into a safe, lowercase-ish SQL identifier. */
export function toIdentifier(input: string, fallback = 'value'): string {
  const cleaned = input
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned === '') return fallback;
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** `date(...)` works on ISO strings in SQLite; this keeps templates portable. */
export function isoDayOf(value: string): string {
  return `date(${value})`;
}
