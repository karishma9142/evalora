export interface GenerateRequest {
  model: string;
  system?: string | null;
  prompt: string;
  temperature?: number | null;
  maxTokens?: number | null;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

// Every AI provider implements this one interface.
// Adding a new provider = adding one file that implements generate().
export interface Provider {
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export class ProviderError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}
