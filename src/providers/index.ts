import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import { ProviderError, type Provider } from './types.js';

export function getProvider(cfg: {
  provider: string;
  baseUrl: string | null;
  apiKey: string;
}): Provider {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicProvider(cfg.apiKey);
    case 'openai-compatible':
      if (!cfg.baseUrl) throw new ProviderError('This credential has no baseUrl');
      return new OpenAICompatibleProvider(cfg.baseUrl, cfg.apiKey);
    default:
      throw new ProviderError(`Unknown provider: ${cfg.provider}`);
  }
}

export * from './types.js';
