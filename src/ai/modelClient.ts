export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

export interface ChatJsonOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: unknown;
    type?: unknown;
  };
};

function completionUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('AI Base URL 不能为空');
  }
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function extractJsonObject(text: string): unknown {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  try {
    return JSON.parse(s) as unknown;
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1)) as unknown;
    }
    throw new Error('模型返回不是有效 JSON');
  }
}

function errorMessageFromPayload(payload: unknown): string | undefined {
  const p = payload as ChatCompletionResponse | null;
  const msg = p?.error?.message;
  if (typeof msg === 'string' && msg.trim()) {
    return msg.trim();
  }
  return undefined;
}

export class OpenAiCompatibleClient {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  async completeJson(opts: ChatJsonOptions): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.options.timeoutMs);
    try {
      const res = await fetch(completionUrl(this.options.baseUrl), {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 1600,
          response_format: { type: 'json_object' },
        }),
      });

      const text = await res.text();
      let payload: unknown;
      try {
        payload = text ? (JSON.parse(text) as unknown) : {};
      } catch {
        payload = text;
      }

      if (!res.ok) {
        const detail = errorMessageFromPayload(payload);
        throw new Error(detail ? `AI 请求失败：HTTP ${res.status}，${detail}` : `AI 请求失败：HTTP ${res.status}`);
      }

      const content = (payload as ChatCompletionResponse).choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('模型没有返回可解析内容');
      }
      return extractJsonObject(content);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error('AI 请求超时，请稍后重试或调大 traderx.ai.timeoutMs');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
