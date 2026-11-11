// The models this provider serves: Claude Code's current models in pi-ai's
// Model shape. The thinking-level maps are pi-ai 1.5.2's for the same Anthropic models, so pi offers the same levels.
import type { Model } from '@earendil-works/pi-ai';
import { API_ID, PROVIDER_ID } from './env.ts';

type Entry = { id: string; name: string; thinkingLevelMap: Model<string>['thinkingLevelMap'] };

const ENTRIES: Entry[] = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' } },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', thinkingLevelMap: { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
  { id: 'claude-fable-5', name: 'Claude Fable 5', thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' } },
  { id: 'claude-opus-5', name: 'Claude Opus 5', thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } },
];

/**
 * The subscription is billed by plan, not per token, so every cost is 0 and pi shows tokens without a price. No
 * `promptCache` is declared: pi would otherwise send cache-warming requests, each a real turn on the plan.
 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const MODELS: Model<string>[] = ENTRIES.map((e) => ({
  id: e.id,
  name: e.name,
  api: API_ID,
  provider: PROVIDER_ID,
  // No HTTP endpoint: the pinned Claude Code binary is the transport.
  baseUrl: '',
  reasoning: true,
  thinkingLevelMap: e.thinkingLevelMap,
  input: ['text', 'image'],
  cost: NO_COST,
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}));

export const claudeModel = (id: string): Model<string> | undefined => MODELS.find((m) => m.id === id);
