import type { TableInfo, Template } from '../types.js';
import { EcommerceTemplate } from './ecommerce.js';
import { JobSeekerTemplate } from './jobseeker.js';
import { SaaSTemplate } from './saas.js';

export { EcommerceTemplate } from './ecommerce.js';
export { JobSeekerTemplate } from './jobseeker.js';
export { SaaSTemplate } from './saas.js';

/** Every built-in template, in detection order. */
export const templates: readonly Template[] = [
  JobSeekerTemplate,
  EcommerceTemplate,
  SaaSTemplate,
];

/** Looks a template up by id (case-insensitive). */
export function getTemplate(id: string): Template | undefined {
  const needle = id.trim().toLowerCase();
  return templates.find((template) => template.id === needle);
}

export interface DetectTemplateOptions {
  /** Minimum number of signal hits required. Defaults to 2. */
  minScore?: number;
}

/**
 * Picks the template that best matches a connected schema, by counting signal
 * hits across table and column names. Returns `undefined` when nothing fits,
 * which is the right answer for an arbitrary dataset.
 */
export function detectTemplate(
  tables: readonly TableInfo[],
  options: DetectTemplateOptions = {},
): Template | undefined {
  const haystack = tables
    .flatMap((table) => [table.name, ...table.columns.map((column) => column.name)])
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');

  const minScore = options.minScore ?? 2;
  let best: { template: Template; score: number } | undefined;

  for (const template of templates) {
    let score = 0;
    for (const signal of template.signals) {
      if (haystack.includes(signal.toLowerCase())) score += 1;
    }
    if (score >= minScore && (!best || score > best.score)) best = { template, score };
  }

  return best?.template;
}
