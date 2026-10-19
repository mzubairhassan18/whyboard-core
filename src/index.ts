import { generateText, type LanguageModel } from 'ai';
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_QUERY_ROWS,
  investigate,
  investigateStream,
  type Investigation,
} from './ai/detective.js';
import { DEFAULT_MODELS, detectProvider, resolveModel, type Phase } from './ai/provider.js';
import { composeStory, streamStory, type Story } from './ai/storyteller.js';
import { Collector } from './ai/trace.js';
import { detectTemplate, getTemplate } from './templates/index.js';
import type {
  ExplainEvent,
  ExplainResult,
  ModelCall,
  ProviderName,
  TableInfo,
  Template,
  TraceEntry,
  UniversalAdapter,
  Usage,
  WhyboardTrace,
} from './types.js';
import { renderSchema } from './util/format.js';
import { WhyboardError } from './util/sql.js';

export interface WhyboardOptions {
  /** Where the data lives: CSVAdapter, TursoAdapter, PostgresAdapter, or your own. */
  adapter: UniversalAdapter;
  /**
   * Provider API key. Falls back to the provider's env var
   * (`XAI_API_KEY`, `AI_GATEWAY_API_KEY` or `OPENAI_API_KEY`).
   */
  apiKey?: string;
  /** `grok` (default), `openai`, or `gateway`. Auto-detected from env when omitted. */
  provider?: ProviderName;
  /** Override the provider base URL (proxies, self-hosted gateways). */
  baseURL?: string;
  /** Use one model for both phases. Accepts a model id or an AI SDK model object. */
  model?: string | LanguageModel;
  /** Per-phase overrides. Accepts model ids or AI SDK model objects. */
  models?: { detective?: string | LanguageModel; storyteller?: string | LanguageModel };
  /** A built-in template id, a Template object, or `null` to disable templates. */
  template?: Template | string | null;
  /** Set false to stop whyboard picking a template from the schema. Defaults to true. */
  autoDetectTemplate?: boolean;
  /** Max model turns for the detective. Defaults to 12. */
  maxSteps?: number;
  /** Rows a single ad-hoc query may return. Defaults to 500. */
  maxRows?: number;
  /** Called after every detective tool call, for live trace UIs. */
  onTrace?: (entry: TraceEntry) => void;
}

export interface ExplainOptions {
  /** Override the template for this question only. */
  template?: Template | string | null;
  /** Override the detective's max turns for this question. */
  maxSteps?: number;
  /** Override the detective model for this question. */
  model?: string | LanguageModel;
  /** Per-question trace hook. */
  onTrace?: (entry: TraceEntry) => void;
}

export interface WhyboardInfo {
  provider: ProviderName;
  detectiveModel: string;
  storytellerModel: string;
  template: string | null;
  tables: string[];
}

/**
 * The whole product in one object: point it at an adapter, ask a "why" question,
 * get a quantified story plus the trail of queries that produced it.
 *
 * ```ts
 * const wb = new Whyboard({ adapter, template: 'jobseeker' });
 * const { answer, trace } = await wb.explain('Why am I getting rejected so often?');
 * console.log(answer);
 * console.log(trace.queries.length, 'queries');
 * ```
 */
export class Whyboard {
  readonly adapter: UniversalAdapter;
  private readonly options: WhyboardOptions;
  private schemaCache?: TableInfo[];
  private templateCache?: Template | null;

  constructor(options: WhyboardOptions) {
    if (!options || !options.adapter) {
      throw new WhyboardError(
        'Whyboard needs an adapter. Pass { adapter: await csvAdapter({ source }) } or any UniversalAdapter.',
        'MISSING_ADAPTER',
      );
    }
    this.options = options;
    this.adapter = options.adapter;
  }

  /** Schema for the connected data, cached after the first call. */
  async schema(refresh = false): Promise<TableInfo[]> {
    if (!this.schemaCache || refresh) {
      this.schemaCache = await this.adapter.listTables();
    }
    return this.schemaCache;
  }

  /** A compact, model-friendly schema description you can show in a UI. */
  async describeSchema(): Promise<string> {
    return renderSchema(await this.schema());
  }

  /** The active template: explicit, auto-detected, or `null`. */
  async template(override?: Template | string | null): Promise<Template | null> {
    if (override !== undefined) return normaliseTemplate(override);
    if (this.templateCache !== undefined) return this.templateCache;

    const configured = this.options.template;
    if (configured !== undefined) {
      this.templateCache = normaliseTemplate(configured);
    } else if (this.options.autoDetectTemplate === false) {
      this.templateCache = null;
    } else {
      this.templateCache = detectTemplate(await this.schema()) ?? null;
    }
    return this.templateCache;
  }

  /** Provider/models in use — handy for a trace pill. */
  info(): WhyboardInfo {
    const provider = this.options.provider ?? detectProvider();
    return {
      provider,
      detectiveModel: this.modelIdFor('detective', provider),
      storytellerModel: this.modelIdFor('storyteller', provider),
      template: this.templateCache?.id ?? null,
      tables: (this.schemaCache ?? []).map((table) => table.name),
    };
  }

  private modelIdFor(phase: Phase, provider: ProviderName): string {
    const override = this.options.models?.[phase] ?? this.options.model;
    if (typeof override === 'string') return override;
    if (override) return override.modelId;
    return DEFAULT_MODELS[provider][phase];
  }

  /**
   * Ready-made "why" questions. Uses the template's questions when there is one,
   * otherwise asks the model to propose questions from the schema.
   */
  async questions(limit = 3): Promise<string[]> {
    const template = await this.template();
    if (template && template.heroQuestions.length > 0) {
      return template.heroQuestions.slice(0, limit);
    }
    return this.suggestQuestions(limit);
  }

  /** Generates questions from the schema, without a template. */
  async suggestQuestions(limit = 3): Promise<string[]> {
    const tables = await this.schema();
    if (tables.length === 0) return [];

    try {
      const { model } = this.model('detective');
      const { text } = await generateText({
        model,
        instructions:
          'You propose the most valuable "why" questions for a dataset. Reply with a numbered list, one question per line, nothing else. Each question must be answerable from the tables given and must start with "Why" or "Which".',
        prompt: `Schema:\n${renderSchema(tables)}\n\nPropose ${Math.max(1, limit)} questions.`,
      });
      const parsed = parseQuestions(text).slice(0, limit);
      if (parsed.length > 0) return parsed;
    } catch {
      // fall through to the schema-derived question
    }

    const biggest = [...tables].sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0))[0];
    return [
      `Why do the numbers in ${biggest?.name ?? 'this dataset'} look the way they do?`,
    ];
  }

  /** The first suggested question, answered — the "hero insight" of a demo. */
  async heroInsight(options: ExplainOptions = {}): Promise<ExplainResult> {
    const [question] = await this.questions(1);
    return this.explain(question ?? 'What stands out in this data?', options);
  }

  /** Runs the detective, then the storyteller. */
  async explain(question: string, options: ExplainOptions = {}): Promise<ExplainResult> {
    const started = Date.now();
    const tables = await this.schema();
    const template = await this.template(options.template);
    const collector = new Collector(options.onTrace ?? this.options.onTrace);
    const calls: ModelCall[] = [];

    const detective = this.model('detective', options.model);
    const detectiveStarted = Date.now();
    const investigation = await investigate({
      model: detective.model,
      adapter: this.adapter,
      tables,
      question,
      template,
      maxSteps: options.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS,
      maxRows: this.options.maxRows ?? DEFAULT_QUERY_ROWS,
      collector,
    });
    calls.push({
      phase: 'detective',
      provider: detective.provider,
      model: detective.modelId,
      ms: Date.now() - detectiveStarted,
      usage: investigation.usage,
    });

    const storyteller = this.model('storyteller');
    const storyStarted = Date.now();
    const story = await composeStory({
      model: storyteller.model,
      template,
      question,
      findings: investigation.findings,
      queryCount: collector.queries.length,
    });
    calls.push({
      phase: 'storyteller',
      provider: storyteller.provider,
      model: storyteller.modelId,
      ms: Date.now() - storyStarted,
      usage: story.usage,
    });

    return buildResult({
      question,
      answer: story.markdown,
      investigation,
      collector,
      calls,
      durationMs: Date.now() - started,
    });
  }

  /**
   * Same as {@link explain}, but streams progress while it works and ends with a
   * `done` event carrying the full result.
   *
   * ```ts
   * for await (const event of wb.explainStream('Why did sales drop?')) {
   *   if (event.type === 'answer-delta') process.stdout.write(event.text);
   *   if (event.type === 'done') save(event.result);
   * }
   * ```
   */
  async *explainStream(
    question: string,
    options: ExplainOptions = {},
  ): AsyncGenerator<ExplainEvent, ExplainResult, void> {
    const started = Date.now();
    try {
      const tables = await this.schema();
      const template = await this.template(options.template);
      const collector = new Collector(options.onTrace ?? this.options.onTrace);
      const calls: ModelCall[] = [];

      const detective = this.model('detective', options.model);
      const detectiveStarted = Date.now();
      const investigation: Investigation = yield* investigateStream({
        model: detective.model,
        adapter: this.adapter,
        tables,
        question,
        template,
        maxSteps: options.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS,
        maxRows: this.options.maxRows ?? DEFAULT_QUERY_ROWS,
        collector,
      });
      calls.push({
        phase: 'detective',
        provider: detective.provider,
        model: detective.modelId,
        ms: Date.now() - detectiveStarted,
        usage: investigation.usage,
      });

      const storyteller = this.model('storyteller');
      const storyStarted = Date.now();
      const writer = streamStory({
        model: storyteller.model,
        template,
        question,
        findings: investigation.findings,
        queryCount: collector.queries.length,
      });

      let story: Story | undefined;
      while (true) {
        const next = await writer.next();
        if (next.done) {
          story = next.value;
          break;
        }
        yield { type: 'answer-delta', text: next.value };
      }
      calls.push({
        phase: 'storyteller',
        provider: storyteller.provider,
        model: storyteller.modelId,
        ms: Date.now() - storyStarted,
        usage: story.usage,
      });

      const result = buildResult({
        question,
        answer: story.markdown,
        investigation,
        collector,
        calls,
        durationMs: Date.now() - started,
      });
      yield { type: 'done', result };
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', message };
      throw error;
    }
  }

  /** Releases the adapter's connections. */
  async close(): Promise<void> {
    await this.adapter.close();
  }

  private model(phase: Phase, modelOverride?: string | LanguageModel) {
    const configured = this.options.models;
    const perPhase = configured?.[phase];
    const injected =
      modelOverride && typeof modelOverride !== 'string'
        ? modelOverride
        : perPhase && typeof perPhase !== 'string'
          ? perPhase
          : undefined;

    if (injected) {
      return {
        model: injected,
        provider: this.options.provider ?? detectProvider(),
        modelId: injected.modelId,
      };
    }

    const single = this.options.model;
    if (single && typeof single !== 'string') {
      return {
        model: single,
        provider: this.options.provider ?? detectProvider(),
        modelId: single.modelId,
      };
    }

    const stringModels = configured
      ? {
          ...(typeof configured.detective === 'string' ? { detective: configured.detective } : {}),
          ...(typeof configured.storyteller === 'string'
            ? { storyteller: configured.storyteller }
            : {}),
        }
      : undefined;

    return resolveModel({
      phase,
      provider: this.options.provider,
      apiKey: this.options.apiKey,
      baseURL: this.options.baseURL,
      model: typeof modelOverride === 'string' ? modelOverride : undefined,
      models: stringModels,
    });
  }
}

// ------------------------------------------------------------------ internals

function normaliseTemplate(value: Template | string | null | undefined): Template | null {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const template = getTemplate(value);
  if (!template) {
    throw new WhyboardError(
      `Unknown template "${value}". Try "jobseeker", "ecommerce" or "saas", or pass a Template object.`,
      'UNKNOWN_TEMPLATE',
    );
  }
  return template;
}

function buildResult(args: {
  question: string;
  answer: string;
  investigation: Investigation;
  collector: Collector;
  calls: ModelCall[];
  durationMs: number;
}): ExplainResult {
  const { investigation, collector, calls } = args;
  const detective = calls.find((call) => call.phase === 'detective');
  const trace: WhyboardTrace = {
    provider: detective?.provider ?? 'grok',
    model: detective?.model ?? '',
    durationMs: args.durationMs,
    steps: collector.steps,
    queries: collector.queries,
    modelCalls: calls,
    usage: sumUsage(
      calls.map((call) => call.usage).filter((usage): usage is Usage => usage != null),
    ),
  };

  return {
    question: args.question,
    answer: args.answer,
    headline: investigation.findings.headline,
    confidence: investigation.findings.confidence,
    findings: investigation.findings,
    trace,
  };
}

function sumUsage(usages: readonly Usage[]): Usage {
  const input = usages.map((usage) => usage.inputTokens);
  const output = usages.map((usage) => usage.outputTokens);
  const total = usages.map((usage) => usage.totalTokens);
  const add = (values: (number | undefined)[]): number | undefined =>
    values.some((value) => value != null)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : undefined;

  const inputTokens = add(input);
  const outputTokens = add(output);
  const totalTokens = add(total);
  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(totalTokens != null ? { totalTokens } : {}),
  };
}

function parseQuestions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .replace(/^["'`]|["'`]$/g, '')
        .trim(),
    )
    .filter((line) => line.length > 8 && line.includes('?'))
    .map((line) => (line.endsWith('?') ? line : `${line}?`));
}

// -------------------------------------------------------------------- exports

export { CSVAdapter, csvAdapter, csvFromFiles, type CsvAdapterOptions, type CsvSource } from './adapters/csv.js';
export { TursoAdapter, tursoAdapter, type TursoAdapterOptions } from './adapters/turso.js';
export { PostgresAdapter, postgresAdapter, type PostgresAdapterOptions } from './adapters/postgres.js';
export {
  EcommerceTemplate,
  JobSeekerTemplate,
  SaaSTemplate,
  detectTemplate,
  getTemplate,
  templates,
} from './templates/index.js';
export { DEFAULT_MODELS, detectProvider } from './ai/provider.js';
export { findingsSchema } from './ai/tools.js';
export { WhyboardError } from './util/sql.js';
export { rowsToMarkdown, renderSchema } from './util/format.js';
export type * from './types.js';
