import { generateText, hasToolCall, isStepCount, streamText, type LanguageModel } from 'ai';
import type {
  ExplainEvent,
  Findings,
  TableInfo,
  Template,
  UniversalAdapter,
  Usage,
} from '../types.js';
import { renderSchema } from '../util/format.js';
import { compactForTrace, Collector } from './trace.js';
import { buildInvestigatorTools, findingsSchema, type InvestigationTools } from './tools.js';

export interface InvestigateOptions {
  model: LanguageModel;
  adapter: UniversalAdapter;
  tables: TableInfo[];
  question: string;
  template?: Template | null;
  /** Max model turns. Defaults to 12. */
  maxSteps?: number;
  /** Rows a single query may return. Defaults to 500. */
  maxRows?: number;
  collector?: Collector;
  /** Set false to keep the schema out of the prompt (advanced). */
  includeSchema?: boolean;
}

export interface Investigation {
  findings: Findings;
  /** The detective's last free-text message, before it reported findings. */
  text: string;
  usage: Usage;
  steps: number;
}

export const DEFAULT_MAX_STEPS = 12;
export const DEFAULT_QUERY_ROWS = 500;

/** System prompt for the hypothesis-testing phase. */
export function detectiveInstructions(options: {
  tables: TableInfo[];
  template?: Template | null;
  maxRows: number;
}): string {
  const { tables, template, maxRows } = options;
  const lines = [
    `You are Whyboard's data detective. You answer "why" questions about a dataset by testing hypotheses with SQL and reporting only what the numbers support.`,
    '',
    'Dataset schema:',
    renderSchema(tables),
    '',
    `Every query is capped at ${maxRows} rows and must be read-only SELECT/WITH.`,
  ];

  if (template) {
    lines.push(
      '',
      `Domain templates: ${template.name} — ${template.description}`,
      ...(template.detectiveHints.length
        ? ['Method notes for this domain:', ...template.detectiveHints.map((hint) => `- ${hint}`)]
        : []),
      ...(template.glossary && Object.keys(template.glossary).length
        ? [
            'Vocabulary:',
            ...Object.entries(template.glossary).map(([term, meaning]) => `- ${term}: ${meaning}`),
          ]
        : []),
    );
  }

  lines.push(
    '',
    'Method:',
    '1. Restate the question as a measurable target (a rate, a total, a gap between two groups).',
    '2. Measure the target for the whole dataset, then split it by the dimensions that could explain it.',
    '3. Find the segment with the biggest gap versus the rest. That is your candidate driver.',
    '4. Quantify it: how much of the total outcome does that segment account for, and what would the target be without it?',
    '5. Check one alternative explanation before you commit. If a second factor explains it just as well, say so.',
    '',
    'When to stop: as soon as you can quantify the top driver(s) and their contribution. Three to six well-chosen',
    'queries usually beats twenty random ones. Then call report_findings exactly once.',
    '',
    'Hard rules:',
    '- Read-only. Never attempt to write, and never run PRAGMA.',
    '- Use table and column names exactly as they appear in the schema; the tools will tell you the real names if you guess wrong.',
    '- Never invent a number or a column. If the data cannot answer the question, say so in caveats and lower the confidence.',
    '- Prefer breakdown, trend and value_counts over hand-written SQL — they compute totals and shares correctly.',
    '- Percentages in your findings must come from the tools, not from mental arithmetic on truncated results.',
  );

  return lines.join('\n');
}

function toUsage(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}): Usage {
  return {
    ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens != null ? { totalTokens: usage.totalTokens } : {}),
  };
}

function userPrompt(question: string): string {
  return [
    `Question: ${question}`,
    '',
    'Investigate this with the tools, then call report_findings with your quantified answer.',
  ].join('\n');
}

function extractFindings(
  toolCalls: readonly { toolName: string; input: unknown }[],
  text: string,
  question: string,
): Findings {
  const call = [...toolCalls].reverse().find((entry) => entry.toolName === 'report_findings');
  const parsed = call ? findingsSchema.safeParse(call.input) : undefined;
  if (parsed?.success) {
    return {
      ...parsed.data,
      caveats: parsed.data.caveats ?? [],
      numbers: parsed.data.numbers ?? [],
    };
  }
  return fallbackFindings(text, question);
}

export function fallbackFindings(text: string, question: string): Findings {
  return {
    headline: question.replace(/\?+$/, ''),
    answer:
      text.trim() ||
      'The investigation ended before whyboard could quantify an answer. Try a more specific question, or connect a table with more rows.',
    confidence: 'low',
    drivers: [],
    numbers: [],
    caveats: ['The detective stopped before reporting structured findings.'],
    suggestedNextQuestions: [],
  };
}

/** Runs the full hypothesis-testing phase once. */
export async function investigate(options: InvestigateOptions): Promise<Investigation> {
  const collector = options.collector ?? new Collector();
  const tools = buildInvestigatorTools({
    adapter: options.adapter,
    tables: options.tables,
    collector,
    maxRows: options.maxRows ?? DEFAULT_QUERY_ROWS,
    hints: options.template?.detectiveHints ?? [],
  });

  const result = await generateText({
    model: options.model,
    instructions: detectiveInstructions({
      tables: options.tables,
      template: options.template,
      maxRows: options.maxRows ?? DEFAULT_QUERY_ROWS,
    }),
    prompt: userPrompt(options.question),
    tools,
    stopWhen: [hasToolCall('report_findings'), isStepCount(options.maxSteps ?? DEFAULT_MAX_STEPS)],
  });

  return {
    findings: extractFindings(result.toolCalls, result.text, options.question),
    text: result.text,
    usage: toUsage(result.totalUsage ?? result.usage),
    steps: result.steps.length,
  };
}

/**
 * Same as {@link investigate}, but yields progress events while it works.
 * The generator's return value is the {@link Investigation}.
 */
export async function* investigateStream(
  options: InvestigateOptions,
): AsyncGenerator<ExplainEvent, Investigation, void> {
  const collector = options.collector ?? new Collector();
  const tools: InvestigationTools = buildInvestigatorTools({
    adapter: options.adapter,
    tables: options.tables,
    collector,
    maxRows: options.maxRows ?? DEFAULT_QUERY_ROWS,
    hints: options.template?.detectiveHints ?? [],
  });

  const result = streamText({
    model: options.model,
    instructions: detectiveInstructions({
      tables: options.tables,
      template: options.template,
      maxRows: options.maxRows ?? DEFAULT_QUERY_ROWS,
    }),
    prompt: userPrompt(options.question),
    tools,
    stopWhen: [hasToolCall('report_findings'), isStepCount(options.maxSteps ?? DEFAULT_MAX_STEPS)],
  });

  for await (const part of result.stream) {
    if (part.type === 'text-delta' && part.text.trim() !== '') {
      yield { type: 'thought', text: part.text };
    } else if (part.type === 'tool-call') {
      yield {
        type: 'tool',
        tool: part.toolName,
        input: compactForTrace(part.input) as Record<string, unknown>,
      };
    } else if (part.type === 'tool-result') {
      yield { type: 'tool-result', tool: part.toolName };
    }
  }

  const [toolCalls, text, usage, steps] = await Promise.all([
    result.toolCalls,
    result.text,
    result.totalUsage,
    result.steps,
  ]);

  return {
    findings: extractFindings(toolCalls, text, options.question),
    text,
    usage: toUsage(usage),
    steps: steps.length,
  };
}
