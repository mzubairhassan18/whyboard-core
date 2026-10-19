import { generateText, streamText, type LanguageModel } from 'ai';
import type { Findings, Template, Usage } from '../types.js';
import { toJsonSafe } from '../util/values.js';
import { streamError } from './stream-error.js';

export interface ComposeOptions {
  model: LanguageModel;
  template?: Template | null;
  question: string;
  findings: Findings;
  /** How many read-only queries backed this answer. */
  queryCount: number;
}

export interface Story {
  markdown: string;
  usage: Usage;
}

/** System prompt for the writer phase. */
export function storytellerInstructions(template?: Template | null): string {
  return [
    'You write the final answer for Whyboard: a short, plain-English data story for a busy founder who',
    'will read it on a phone. A detective has already done the analysis and handed you structured findings.',
    '',
    ...(template ? [template.voice, ''] : []),
    'Output format — markdown, nothing else:',
    '1. A bold one-line headline. No heading markdown, just **like this**.',
    '2. One short paragraph (2-3 sentences) answering the question outright.',
    "3. `### What's driving it` — a numbered list, one item per driver, ranked. Each item: the driver in bold,",
    '   one sentence of mechanism, then its numbers in parentheses.',
    '4. `### The numbers that matter` — bullets of the headline figures.',
    "5. `### What this doesn't tell you` — the caveats, then 2-3 follow-up questions as bullets.",
    '',
    'Rules:',
    '- Use only numbers that appear in the findings. Never compute or invent a figure.',
    '- Write "70% of applications" not "70 percent of applications"; keep numbers short (1 decimal max).',
    '- No preamble, no "Based on the analysis", no mention of SQL, tools, models or tables.',
    '- No hedging filler. If confidence is low, say what is missing instead of sounding unsure.',
    '- Under 250 words total.',
  ]
    .filter(Boolean)
    .join('\n');
}

function storyPrompt(options: ComposeOptions): string {
  return [
    `Question: ${options.question}`,
    '',
    `Findings from ${options.queryCount} read-only ${options.queryCount === 1 ? 'query' : 'queries'}:`,
    '```json',
    JSON.stringify(toJsonSafe(options.findings), null, 2),
    '```',
    '',
    'Write the story now.',
  ].join('\n');
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

/** Turns structured findings into the markdown story. */
export async function composeStory(options: ComposeOptions): Promise<Story> {
  const result = await generateText({
    model: options.model,
    instructions: storytellerInstructions(options.template),
    prompt: storyPrompt(options),
  });
  return { markdown: clean(result.text), usage: toUsage(result.totalUsage ?? result.usage) };
}

/**
 * Streaming variant: yields each chunk of markdown as it is written, and
 * returns the finished {@link Story} from the generator.
 */
export async function* streamStory(options: ComposeOptions): AsyncGenerator<string, Story, void> {
  const result = streamText({
    model: options.model,
    instructions: storytellerInstructions(options.template),
    prompt: storyPrompt(options),
  });

  let markdown = '';
  for await (const part of result.stream) {
    if (part.type === 'text-delta' && part.text !== '') {
      markdown += part.text;
      yield part.text;
    } else if (part.type === 'error') {
      throw streamError(part.error);
    }
  }

  const usage = await result.totalUsage;
  return { markdown: clean(markdown || (await result.text)), usage: toUsage(usage) };
}

/** Trims stray code fences a model sometimes wraps around prose. */
function clean(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}
