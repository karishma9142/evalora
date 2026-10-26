import { postJson } from './http.js';
import type { GenerateRequest, GenerateResult, Provider } from './types.js';

type AnthropicResponse = {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

export class AnthropicProvider implements Provider {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.anthropic.com',
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024, // Anthropic requires this field
      messages: [{ role: 'user', content: req.prompt }],
    };
    if (req.system) body.system = req.system;
    if (req.temperature != null) body.temperature = req.temperature;

    const { json, latencyMs } = await postJson(
      `${this.baseUrl}/v1/messages`,
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body,
    );

    const data = json as AnthropicResponse;
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      text,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      latencyMs,
    };
  }
}
