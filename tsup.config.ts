import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'templates/index': 'src/templates/index.ts',
    'templates/ecommerce': 'src/templates/ecommerce.ts',
    'templates/jobseeker': 'src/templates/jobseeker.ts',
    'templates/saas': 'src/templates/saas.ts',
    'adapters/csv': 'src/adapters/csv.ts',
    'adapters/turso': 'src/adapters/turso.ts',
    'adapters/postgres': 'src/adapters/postgres.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  // Keep peer-ish/runtime packages external so consumers resolve a single copy.
  external: [
    'ai',
    '@ai-sdk/openai',
    '@ai-sdk/xai',
    '@ai-sdk/gateway',
    '@libsql/client',
    'papaparse',
    'pg',
    'zod',
  ],
});
