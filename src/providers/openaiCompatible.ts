import { postJson } from './http.js';
import type { GenerateRequest, GenerateResult, Provider } from './types.js';

type ChatResponse = {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// Works with OpenAI, Ollama, Groq, Together, OpenRouter, LM Studio, vLLM...
// anything that exposes POST {baseUrl}/chat/completions
export class OpenAICompatibleProvider implements Provider {
  private baseUrl: string;

  constructor(
    baseUrl: string,
    private apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });

    const body: Record<string, unknown> = { model: req.model, messages };
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.maxTokens != null) body.max_tokens = req.maxTokens;

    const { json, latencyMs } = await postJson(
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      body,
    );

    const data = json as ChatResponse;
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0, // some local servers omit usage
      outputTokens: data.usage?.completion_tokens ?? 0,
      latencyMs,
    };
  }
}
