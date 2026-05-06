import * as vscode from 'vscode';

export type AiProvider = 'openai' | 'deepseek' | 'custom';

export interface AiRuntimeConfig {
  provider: AiProvider;
  providerLabel: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  hasApiKey: boolean;
}

const SECRET_PREFIX = 'traderx.ai.apiKey';

const PROVIDER_DEFAULTS: Record<Exclude<AiProvider, 'custom'>, { label: string; baseUrl: string; model: string }> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
};

function normalizeProvider(raw: unknown): AiProvider {
  if (raw === 'openai' || raw === 'deepseek' || raw === 'custom') {
    return raw;
  }
  return 'deepseek';
}

function providerLabel(provider: AiProvider): string {
  if (provider === 'custom') {
    return '自定义';
  }
  return PROVIDER_DEFAULTS[provider].label;
}

function defaultBaseUrl(provider: AiProvider): string {
  if (provider === 'custom') {
    return '';
  }
  return PROVIDER_DEFAULTS[provider].baseUrl;
}

function defaultModel(provider: AiProvider): string {
  if (provider === 'custom') {
    return '';
  }
  return PROVIDER_DEFAULTS[provider].model;
}

export function aiSecretKey(provider: AiProvider): string {
  return `${SECRET_PREFIX}.${provider}`;
}

export async function getAiApiKey(ctx: vscode.ExtensionContext, provider: AiProvider): Promise<string | undefined> {
  const providerKey = await ctx.secrets.get(aiSecretKey(provider));
  if (providerKey) {
    return providerKey;
  }
  if (provider !== 'custom') {
    return undefined;
  }
  return ctx.secrets.get(aiSecretKey('deepseek'));
}

export async function saveAiApiKey(ctx: vscode.ExtensionContext, provider: AiProvider, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error('API Key 不能为空');
  }
  await ctx.secrets.store(aiSecretKey(provider), trimmed);
}

export async function clearAiApiKey(ctx: vscode.ExtensionContext, provider: AiProvider): Promise<void> {
  await ctx.secrets.delete(aiSecretKey(provider));
}

export async function readAiRuntimeConfig(ctx: vscode.ExtensionContext): Promise<AiRuntimeConfig> {
  const cfg = vscode.workspace.getConfiguration('traderx');
  const provider = normalizeProvider(cfg.get<string>('ai.provider'));
  const rawBaseUrl = (cfg.get<string>('ai.baseUrl') ?? '').trim();
  const rawModel = (cfg.get<string>('ai.model') ?? '').trim();
  const rawTimeout = cfg.get<number>('ai.timeoutMs');
  const timeoutMs = Math.max(5_000, Math.min(180_000, typeof rawTimeout === 'number' ? rawTimeout : 45_000));
  const apiKey = await getAiApiKey(ctx, provider);

  return {
    provider,
    providerLabel: providerLabel(provider),
    baseUrl: rawBaseUrl || defaultBaseUrl(provider),
    model: rawModel || defaultModel(provider),
    timeoutMs,
    hasApiKey: Boolean(apiKey),
  };
}

export function validateAiRuntimeConfig(config: AiRuntimeConfig, apiKey: string | undefined): void {
  if (!config.baseUrl) {
    throw new Error('请先配置 AI Base URL');
  }
  if (!config.model) {
    throw new Error('请先配置 AI 模型名称');
  }
  if (!apiKey) {
    throw new Error(`请先配置 ${config.providerLabel} API Key`);
  }
}
