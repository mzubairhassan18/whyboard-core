import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { CSVAdapter } from '../src/adapters/csv.js';
import { Whyboard } from '../src/index.js';

const csv = await readFile(new URL('./fixtures/applications.csv', import.meta.url), 'utf8');

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function toolCall(toolName: string, input: unknown) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: `call-${toolName}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: usage(100, 20),
    warnings: [],
  };
}

test('Whyboard runs detective → tools → storyteller end to end', async () => {
  const detective = new MockLanguageModelV4({
    modelId: 'mock-detective',
    doGenerate: [
      toolCall('breakdown', {
        table: 'applications',
        dimension: 'source',
        limit: 10,
      }),
      toolCall('report_findings', {
        headline: 'LinkedIn is where every rejection comes from',
        answer:
          'LinkedIn accounts for 11 of 24 applications and none of them reached an interview, while referrals converted 6 of 7.',
        confidence: 'high',
        drivers: [
          {
            label: 'LinkedIn applications',
            detail: 'Every LinkedIn application was rejected or ghosted, and it is the largest channel.',
            impact: '46% of applications, 0% success',
            evidence: '0 of 11 reached interview; referrals reached 6 of 7',
          },
        ],
        numbers: [
          { label: 'Applications', value: '24' },
          { label: 'LinkedIn success rate', value: '0%' },
        ],
        caveats: ['The sample is small: 24 applications over two months.'],
        suggestedNextQuestions: ['Why does the referral channel convert six times better?'],
      }),
    ],
  });

  const storyteller = new MockLanguageModelV4({
    modelId: 'mock-storyteller',
    doGenerate: {
      content: [
        {
          type: 'text',
          text: '**LinkedIn is where every rejection comes from**\n\nYou are not being rejected everywhere — you are being rejected on LinkedIn.\n\n### What\'s driving it\n\n1. **LinkedIn applications.** All 11 were rejected or ghosted (0 of 11 reached interview).\n\n### The numbers that matter\n\n- 24 applications\n- 0% LinkedIn success rate\n\n### What this doesn\'t tell you\n\n- The sample is small.',
        },
      ],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: usage(200, 100),
      warnings: [],
    },
  });

  const adapter = new CSVAdapter({ source: { name: 'applications', content: csv } });
  const wb = new Whyboard({
    adapter,
    models: { detective, storyteller },
  });

  try {
    const result = await wb.explain('Why am I getting rejected so often?');

    // template auto-detected from the schema
    assert.equal((await wb.template())?.id, 'jobseeker');

    // findings came from report_findings, not from prose
    assert.equal(result.findings.headline, 'LinkedIn is where every rejection comes from');
    assert.equal(result.confidence, 'high');
    assert.equal(result.headline, result.findings.headline);

    // the story is the storyteller's markdown
    assert.match(result.answer, /LinkedIn is where every rejection comes from/);
    assert.doesNotMatch(result.answer, /^```/);

    // evidence trail
    assert.equal(result.trace.steps.length, 2);
    assert.equal(result.trace.steps[0]?.tool, 'breakdown');
    assert.equal(result.trace.steps[1]?.tool, 'report_findings');

    const breakdownOutput = result.trace.steps[0]?.output as {
      groups: { value: string; rows: number; pctOfRows: number }[];
    };
    const linkedin = breakdownOutput.groups.find((group) => group.value === 'LinkedIn');
    assert.equal(linkedin?.rows, 11);
    assert.equal(linkedin?.pctOfRows, 45.8);

    // both SQL statements are recorded, and read-only
    assert.equal(result.trace.queries.length, 2);
    for (const query of result.trace.queries) {
      assert.match(query.sql.trim().toLowerCase(), /^select/);
      assert.ok(query.rowCount >= 0);
    }

    // models and usage are attributed per phase
    assert.deepEqual(
      result.trace.modelCalls.map((call) => call.phase),
      ['detective', 'storyteller'],
    );
    assert.equal(result.trace.usage.inputTokens, 400);
    assert.equal(result.trace.usage.outputTokens, 140);
    assert.equal(result.trace.provider, 'grok');
  } finally {
    await wb.close();
  }
});

test('Whyboard explains without an API key by using an injected model only', async () => {
  const adapter = new CSVAdapter({ source: { name: 'applications', content: csv } });
  const wb = new Whyboard({ adapter, provider: 'openai', apiKey: '' });
  try {
    await assert.rejects(() => wb.explain('Why?'), /Missing API key/i);
  } finally {
    await wb.close();
  }
});

test('questions() uses the template hero questions without a model call', async () => {
  const adapter = new CSVAdapter({ source: { name: 'applications', content: csv } });
  const wb = new Whyboard({ adapter, template: 'jobseeker' });
  try {
    const questions = await wb.questions(2);
    assert.deepEqual(questions, [
      'Why am I getting rejected so often?',
      'Which application channel actually gets me interviews?',
    ]);
  } finally {
    await wb.close();
  }
});

test('unknown templates fail loudly', async () => {
  const adapter = new CSVAdapter({ source: { name: 'x', content: 'a\n1\n' } });
  const wb = new Whyboard({ adapter });
  try {
    await assert.rejects(() => wb.template('nope'), /Unknown template/);
  } finally {
    await wb.close();
  }
});
