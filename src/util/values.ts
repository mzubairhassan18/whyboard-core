import type { ColumnType } from '../types.js';

/** Maps a native column type string to whyboard's logical type. */
export function fromNativeType(nativeType: string | undefined): ColumnType {
  const t = (nativeType ?? '').toLowerCase();
  if (t === '') return 'unknown';
  if (t.includes('bool')) return 'boolean';
  if (t.includes('int')) return 'integer';
  if (/(real|float|double|numeric|decimal|money)/.test(t)) return 'real';
  if (/(timestamp|datetime|timestamptz)/.test(t)) return 'datetime';
  if (t === 'date' || t.endsWith(' date')) return 'date';
  if (/(json|jsonb)/.test(t)) return 'json';
  if (/(char|text|clob|uuid|enum|name)/.test(t)) return 'text';
  return 'unknown';
}

/**
 * Parses a human-formatted number (`$1,234.50`, `(42)`, `12%`, `1.2k`) into a
 * JS number. Returns `undefined` when the value is not a number.
 */
export function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'string') return undefined;

  const raw = value.trim();
  if (raw === '') return undefined;
  if (/^(nan|null|n\/a|na|-|—|none)$/i.test(raw)) return undefined;

  let text = raw;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  const suffix = /([kmb])$/i.exec(text.replace(/[%\s]/g, ''));
  text = text.replace(/[^0-9eE+\-.,]/g, '');
  // `1.234,56` (EU) vs `1,234.56` (US)
  if (/,\d{1,2}$/.test(text) && text.includes('.')) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else {
    text = text.replace(/,/g, '');
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return undefined;

  const scaled = suffix
    ? parsed * ({ k: 1e3, m: 1e6, b: 1e9 }[suffix[1]!.toLowerCase()] ?? 1)
    : parsed;
  return negative ? -scaled : scaled;
}

const BOOLEANS: Record<string, boolean> = {
  true: true,
  false: false,
  t: true,
  f: false,
  yes: true,
  no: false,
  y: true,
  n: false,
};

export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 0 ? false : value === 1 ? true : undefined;
  if (typeof value !== 'string') return undefined;
  return BOOLEANS[value.trim().toLowerCase()];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

export function looksLikeDate(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!DATE_RE.test(raw) && !SLASH_DATE_RE.test(raw)) return false;
  const stamp = Date.parse(raw.replace(' ', 'T'));
  return Number.isFinite(stamp);
}

export interface InferredColumn {
  name: string;
  /** Logical type stored in the mirror table. */
  type: ColumnType;
  /** `true` when the column is numeric and values were coerced. */
  numeric: boolean;
}

/**
 * Infers a column's logical type from a sample of raw CSV values. Currency,
 * thousands separators and percentages are treated as numbers; anything that
 * looks like a date stays TEXT but is reported as `date`/`datetime` so the
 * detective knows it can bucket on it.
 */
export function inferColumn(name: string, samples: readonly string[]): InferredColumn {
  const filled = samples.filter((v) => v != null && String(v).trim() !== '');
  if (filled.length === 0) return { name, type: 'text', numeric: false };

  let numbers = 0;
  let integers = 0;
  let booleans = 0;
  let dates = 0;
  let datetimes = 0;
  let json = 0;

  for (const raw of filled) {
    const text = String(raw).trim();
    const num = parseNumber(text);
    if (num !== undefined) {
      numbers += 1;
      if (Number.isInteger(num)) integers += 1;
      continue;
    }
    const bool = parseBoolean(text);
    if (bool !== undefined && text.length <= 5) {
      booleans += 1;
      continue;
    }
    if (looksLikeDate(text)) {
      dates += 1;
      if (text.length > 10) datetimes += 1;
      continue;
    }
    if (/^[[{]/.test(text) && /[\]}]$/.test(text)) json += 1;
  }

  const total = filled.length;
  const ratio = (n: number) => n / total;

  if (ratio(numbers) >= 0.95) {
    return { name, type: integers === numbers ? 'integer' : 'real', numeric: true };
  }
  if (ratio(dates) >= 0.9) {
    return { name, type: datetimes > dates / 2 ? 'datetime' : 'date', numeric: false };
  }
  if (ratio(booleans) >= 0.9) return { name, type: 'boolean', numeric: false };
  if (ratio(json) >= 0.9) return { name, type: 'json', numeric: false };
  return { name, type: 'text', numeric: false };
}

/** Normalises a raw CSV cell into the value bound to a SQLite parameter. */
export function coerceCell(raw: unknown, column: InferredColumn): unknown {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (text === '') return null;

  if (column.numeric) {
    const num = parseNumber(text);
    return num === undefined ? null : num;
  }
  if (column.type === 'boolean') {
    const bool = parseBoolean(text);
    return bool === undefined ? null : bool ? 1 : 0;
  }
  return text;
}

/** Makes a value safe to pass through JSON (BigInt, blobs, dates). */
export function toJsonSafe<T>(value: T): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function countRows(value: unknown): number | undefined {
  if (value == null) return undefined;
  const num = parseNumber(value as string | number);
  return num === undefined ? undefined : Math.trunc(num);
}
