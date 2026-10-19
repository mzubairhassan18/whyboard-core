import { createGateway } from '@ai-sdk/gateway';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
import type { ProviderName } from '../types.js';
import { WhyboardError } from '../util/sql.js';

export type Phase = 'detective' | 'storyteller';

/**
 * Model defaults, per provider and per phase.
 *
 * The detective needs a fast, tool-calling model; the storyteller needs one with
 * good prose. Both are overridable per instance via `Whyboard({ models })`.
 */
export const DEFAULT_MODELS: Record<ProviderName, Record<Phase, string>> = {
  grok: {
    detective: 'grok-4-1-fast-reasoning',
    storyteller: 'grok-4.6',
  },
  openai: {
    detective: 'gpt-5-mini',
    storyteller: 'gpt-5.6',
  },
  gateway: {
    detective: 'xai/grok-4-1-fast-reasoning',
    storyteller: 'xai/grok-4.6',
  },
};

const ENV_KEYS: Record<ProviderName, string> = {
  grok: 'XAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  gateway: 'AI_GATEWAY_API_KEY',
};

/**
 * Picks a provider from the environment: the first of
 * `XAI_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY` that is set.
 */
export function detectProvider(env: Record<string, string | undefined> = process.env): ProviderName {
  if (env.XAI_API_KEY) return 'grok';
  if (env.AI_GATEWAY_API_KEY) return 'gateway';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'grok';
}

/** The env var a provider reads its key from. */
export function envKeyFor(provider: ProviderName): string {
  return ENV_KEYS[provider];
}

export interface ResolvedModel {
  model: LanguageModel;
  provider: ProviderName;
  modelId: string;
}

export interface ResolveModelOptions {
  phase: Phase;
  provider?: ProviderName | undefined;
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  model?: string | undefined;
  models?: Partial<Record<Phase, string>> | undefined;
  env?: Record<string, string | undefined> | undefined;
}

/** Builds the AI SDK model object for a phase, with a helpful error when unkeyed. */
export function resolveModel(options: ResolveModelOptions): ResolvedModel {
  const env = options.env ?? process.env;
  const provider = options.provider ?? detectProvider(env);
  const envKey = ENV_KEYS[provider];
  const apiKey = options.apiKey ?? env[envKey];

  if (!apiKey) {
    throw new WhyboardError(
      `Missing API key for provider "${provider}". Set ${envKey} or pass { apiKey } to Whyboard().`,
      'MISSING_API_KEY',
    );
  }

  const modelId =
    options.model ?? options.models?.[options.phase] ?? DEFAULT_MODELS[provider][options.phase];

  let model: LanguageModel;
  if (provider === 'grok') {
    model = createXai({ apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}) })(modelId);
  } else if (provider === 'openai') {
    model = createOpenAI({ apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}) })(
      modelId,
    );
  } else {
    model = createGateway({ apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}) })(
      modelId,
    );
  }

  return { model, provider, modelId };
}
