/**
 * Run with:
 *   npm run build
 *   XAI_API_KEY=xai-... npx tsx examples/quickstart.ts
 *
 * Uses the fixture shipped with the tests, so it works offline apart from the model call.
 */
import { readFile } from 'node:fs/promises';
import { Whyboard, csvAdapter } from 'whyboard-core';

const csv = await readFile(new URL('../test/fixtures/applications.csv', import.meta.url), 'utf8');

const adapter = await csvAdapter({ source: { name: 'applications', content: csv } });
const whyboard = new Whyboard({ adapter, template: 'jobseeker' });

try {
  console.log('Template:', (await whyboard.template())?.name);
  console.log('Questions:', await whyboard.questions(3));
  console.log('Schema:\n' + (await whyboard.describeSchema()));

  const result = await whyboard.explain('Why am I getting rejected so often?');

  console.log('\n--- answer ---\n');
  console.log(result.answer);

  console.log(`\n--- evidence (${result.trace.queries.length} queries) ---`);
  for (const query of result.trace.queries) {
    console.log(`\n[${query.rowCount} rows, ${query.ms}ms] ${query.purpose ?? ''}`);
    console.log(query.sql);
  }

  console.log(`\nConfidence: ${result.confidence}`);
  console.log(`Tokens: ${JSON.stringify(result.trace.usage)}`);
} finally {
  await whyboard.close();
}
