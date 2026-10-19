import type { SqlTrace, TraceEntry } from '../types.js';

/** Accumulates the evidence trail for one question. */
export class Collector {
  readonly steps: TraceEntry[] = [];
  readonly queries: SqlTrace[] = [];

  constructor(private readonly onTrace?: ((entry: TraceEntry) => void) | undefined) {}

  record(entry: Omit<TraceEntry, 'index'>): TraceEntry {
    const full: TraceEntry = { index: this.steps.length, ...entry };
    this.steps.push(full);
    this.onTrace?.(full);
    return full;
  }

  recordQuery(query: SqlTrace): void {
    this.queries.push(query);
  }
}

/** Shrinks a value so traces stay small enough to store or render in a UI. */
export function compactForTrace(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 5).map((entry) => compactForTrace(entry, depth + 1));
    return value.length > 5 ? [...head, `…${value.length - 5} more`] : head;
  }
  if (typeof value === 'object') {
    if (depth > 4) return '[deep]';
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = compactForTrace(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}
