# whyboard-core

**Bring any database, get an AI storyteller.**

Point whyboard at a CSV, a Turso/SQLite database or Postgres, ask *why*, and get a
quantified answer with the queries that prove it.

```ts
import { Whyboard, csvAdapter } from 'whyboard-core';

const adapter = await csvAdapter({ source: csvText, tableName: 'applications' });
const whyboard = new Whyboard({ adapter, template: 'jobseeker' });

const { answer, trace } = await whyboard.explain('Why am I getting rejected so often?');

console.log(answer);              // markdown story
console.log(trace.queries.length); // 4 read-only queries behind it
```

- **Read-only by design.** Every adapter refuses anything that is not a single `SELECT`/`WITH`.
- **Two-phase AI.** A *detective* tests hypotheses with SQL; a *storyteller* turns the
  findings into prose. No hallucinated numbers — the writer only sees the findings.
- **Traceable.** Each answer ships with every tool call, every query, timings and token usage.
- **Typed end to end.** TypeScript, ESM, tree-shakeable subpath exports, Zod schemas.
- **Bring your own key** (Grok, OpenAI, or the Vercel AI Gateway) or inject any AI SDK model.

Built on the [AI SDK](https://ai-sdk.dev) 7, libSQL, PapaParse and Zod.

---

## Install

```bash
npm i whyboard-core
```

For Postgres, add the driver:

```bash
npm i pg
```

## Quick start

```ts
import { readFile } from 'node:fs/promises';
import { Whyboard, csvAdapter } from 'whyboard-core';

const adapter = await csvAdapter({
  source: await readFile('applications.csv', 'utf8'),
  tableName: 'applications',
});

const whyboard = new Whyboard({
  adapter,
  apiKey: process.env.XAI_API_KEY, // or omit and set XAI_API_KEY
  template: 'jobseeker',
});

const result = await whyboard.explain('Why am I getting rejected so often?');

console.log(result.answer);        // markdown
console.log(result.confidence);    // 'low' | 'medium' | 'high'
console.log(result.findings);      // structured drivers, numbers, caveats
console.log(result.trace.queries); // the SQL that backs the answer

await whyboard.close();
```

`explain()` returns:

```ts
interface ExplainResult {
  question: string;
  answer: string;        // markdown story
  headline: string;
  confidence: 'low' | 'medium' | 'high';
  findings: {
    headline: string;
    answer: string;
    confidence: 'low' | 'medium' | 'high';
    drivers: { label: string; detail: string; impact?: string; evidence?: string }[];
    numbers: { label: string; value: string }[];
    caveats: string[];
    suggestedNextQuestions: string[];
  };
  trace: {
    provider: 'grok' | 'openai' | 'gateway';
    model: string;
    durationMs: number;
    steps: { index: number; tool: string; input: unknown; output?: unknown; error?: string; ms: number }[];
    queries: { sql: string; purpose?: string; rowCount: number; ms: number }[];
    modelCalls: { phase: 'detective' | 'storyteller'; provider: string; model: string; ms: number; usage?: Usage }[];
    usage: Usage;
  };
}
```

## Adapters

### CSV

CSVs are parsed, type-inferred (currency, thousands separators, ISO dates, booleans)
and loaded into an in-memory libSQL database, so every tool works on them like a real table.

```ts
import { CSVAdapter, csvAdapter, csvFromFiles } from 'whyboard-core';

// raw text
const a = await csvAdapter({ source: csvText, tableName: 'orders' });

// one or more files
const b = await CSVAdapter.fromFiles(['orders.csv', 'customers.csv']);

// several sources at once
const c = new CSVAdapter({
  source: [
    { name: 'orders', content: ordersCsv },
    { name: 'customers', content: customersCsv },
  ],
});
```

Pass `url` + `authToken` to mirror the import into a remote Turso database instead of memory.

### Turso / libSQL / SQLite

```ts
import { TursoAdapter } from 'whyboard-core';

const adapter = await TursoAdapter.open({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
  tables: ['orders', 'customers'], // optional allow-list
});
```

### Postgres

```ts
import { PostgresAdapter } from 'whyboard-core/adapters/postgres';

const adapter = new PostgresAdapter({
  connectionString: process.env.DATABASE_URL!,
  schema: 'public',
});
```

### Your own source

Implement four methods:

```ts
interface UniversalAdapter {
  readonly kind: string;
  listTables(): Promise<TableInfo[]>;
  describeTable(table: string): Promise<TableInfo>;
  query(sql: string, params?: readonly unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}
```

## Templates

A template is domain knowledge: the writer's voice, the "why" questions worth asking,
and hints that steer the detective.

```ts
import { JobSeekerTemplate, EcommerceTemplate, SaaSTemplate, detectTemplate } from 'whyboard-core';

const whyboard = new Whyboard({ adapter, template: JobSeekerTemplate });
```

| Template | For | Example questions |
| --- | --- | --- |
| `jobseeker` | application trackers | "Why am I getting rejected so often?" |
| `ecommerce` | orders, products, revenue | "Why did sales drop last month?" |
| `saas` | subscriptions, MRR, churn | "Why are customers churning?" |

Pass `template: null` to disable templates, or let whyboard pick one from the schema
(`autoDetectTemplate` is on by default).

A custom template is just an object:

```ts
const template = {
  id: 'support',
  name: 'Support tickets',
  description: 'Tickets, agents, priorities and resolution times.',
  voice: 'You write for a support lead. Be concrete about queues and staffing.',
  detectiveHints: ['Compare resolution time by priority and agent, not overall.'],
  heroQuestions: ['Why is first response time rising?'],
  signals: ['ticket', 'agent', 'priority', 'resolved_at'],
};
```

## Providers

| Provider | `provider` | Env var | Default detective / storyteller |
| --- | --- | --- | --- |
| xAI Grok | `'grok'` (default) | `XAI_API_KEY` | `grok-4-1-fast-reasoning` / `grok-4.6` |
| Vercel AI Gateway | `'gateway'` | `AI_GATEWAY_API_KEY` | `xai/grok-4-1-fast-reasoning` / `xai/grok-4.6` |
| OpenAI | `'openai'` | `OPENAI_API_KEY` | `gpt-5-mini` / `gpt-5.6` |

```ts
const whyboard = new Whyboard({
  adapter,
  provider: 'gateway',
  models: { detective: 'xai/grok-4-1-fast-reasoning', storyteller: 'xai/grok-4.6' },
  maxSteps: 12,   // detective turns
  maxRows: 500,   // rows per ad-hoc query
});

// or inject any AI SDK model (tests, custom providers, different model per phase)
const whyboard = new Whyboard({
  adapter,
  models: { detective: myModel, storyteller: myWriter },
});
```

The provider is auto-detected from whichever key is set, in the order
`XAI_API_KEY` → `AI_GATEWAY_API_KEY` → `OPENAI_API_KEY`.

## Streaming

Same pipeline, with progress while it works:

```ts
for await (const event of whyboard.explainStream('Why did sales drop?')) {
  switch (event.type) {
    case 'thought':       console.log('thinking:', event.text); break;
    case 'tool':          console.log('querying:', event.tool); break;
    case 'answer-delta':  process.stdout.write(event.text); break;
    case 'done':          await save(event.result); break;
    case 'error':         console.error(event.message); break;
  }
}
```

Events: `thought`, `tool`, `tool-result`, `answer-delta`, `done`, `error`.
The final `done` event carries the full `ExplainResult`.

## Heroes and suggestions

```ts
await whyboard.questions(3);   // template questions, or generated from the schema
await whyboard.heroInsight();  // first question, answered
await whyboard.describeSchema(); // compact schema summary for a "connected data" panel
await whyboard.info();         // provider, models, template, tables
```

## How it works

```
        ┌─────────────┐     ┌──────────────────────────────┐
data ──▶│  adapter    │────▶│  detective (tool-calling LLM)│
        │ read-only   │◀────│  list_tables / describe_table│
        └─────────────┘     │  run_sql / breakdown / trend │
                            │  value_counts / correlate    │
                            └──────────────┬───────────────┘
                                           │ report_findings (Zod-validated)
                                           ▼
                            ┌──────────────────────────────┐
                            │  storyteller (LLM)           │
                            │  findings → markdown story   │
                            └──────────────────────────────┘
```

The detective is given the schema and a handful of purpose-built analytics tools that
compute totals and shares for it, so it does not have to hand-write `GROUP BY` arithmetic.
It must end by calling `report_findings`, whose Zod schema is the contract between the
two phases. Anything the writer states must come from those findings.

### Safety

- `assertReadOnly()` masks string literals, strips comments, then rejects anything that is
  not a single `SELECT`/`WITH` statement, including stacked statements and write keywords.
- Every ad-hoc query gets a `LIMIT` when it does not already have one.
- Adapters enforce the same rule at their boundary, so a bug in the tool layer cannot write.
- Column and table names are validated against the real schema before interpolation, and
  identifiers are quoted.

whyboard is a read-only analytics tool. Use a read-only database user anyway.

## API

### `new Whyboard(options)`

| Option | Type | Default |
| --- | --- | --- |
| `adapter` | `UniversalAdapter` | required |
| `apiKey` | `string` | provider env var |
| `provider` | `'grok' \| 'openai' \| 'gateway'` | auto-detected |
| `baseURL` | `string` | provider default |
| `model` | `string \| LanguageModel` | — |
| `models` | `{ detective?, storyteller? }` | provider defaults |
| `template` | `Template \| string \| null` | auto-detected |
| `autoDetectTemplate` | `boolean` | `true` |
| `maxSteps` | `number` | `12` |
| `maxRows` | `number` | `500` |
| `onTrace` | `(entry) => void` | — |

### Methods

| Method | Returns |
| --- | --- |
| `explain(question, options?)` | `Promise<ExplainResult>` |
| `explainStream(question, options?)` | `AsyncGenerator<ExplainEvent, ExplainResult>` |
| `heroInsight(options?)` | `Promise<ExplainResult>` |
| `questions(limit?)` | `Promise<string[]>` |
| `suggestQuestions(limit?)` | `Promise<string[]>` |
| `schema(refresh?)` | `Promise<TableInfo[]>` |
| `describeSchema()` | `Promise<string>` |
| `template(override?)` | `Promise<Template \| null>` |
| `info()` | `WhyboardInfo` |
| `close()` | `Promise<void>` |

### Errors

All whyboard errors are `WhyboardError` with a `code`:
`MISSING_API_KEY`, `MISSING_ADAPTER`, `UNKNOWN_TEMPLATE`, `SQL_NOT_READ_ONLY`,
`SQL_MULTIPLE_STATEMENTS`, `SQL_EMPTY`.

## Subpath exports

```ts
import { Whyboard } from 'whyboard-core';
import { JobSeekerTemplate } from 'whyboard-core/templates/jobseeker';
import { EcommerceTemplate } from 'whyboard-core/templates/ecommerce';
import { SaaSTemplate } from 'whyboard-core/templates/saas';
import { CSVAdapter } from 'whyboard-core/adapters/csv';
import { TursoAdapter } from 'whyboard-core/adapters/turso';
import { PostgresAdapter } from 'whyboard-core/adapters/postgres';
```

## Roadmap

- Google Sheets adapter
- DuckDB / BigQuery adapters
- Persisted story library (save, share, re-run)
- Scheduled "watch this metric" runs

## License

MIT
