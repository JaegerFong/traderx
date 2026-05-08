import * as vscode from 'vscode';
import { getAiApiKey, readAiRuntimeConfig, validateAiRuntimeConfig } from './config';
import { AiCandidateProvider, type AiCandidateScope, type AiStockCandidate } from './candidateProvider';
import { OpenAiCompatibleClient } from './modelClient';

export interface AiStockPick {
  code: string;
  name: string;
  reason: string;
  confidence: number;
  matchedRules: string[];
  riskNotes: string[];
  source: string;
}

export interface AiStockPickResult {
  summary: string;
  picks: AiStockPick[];
  warnings: string[];
  steps: AiStockAgentStep[];
  providerLabel: string;
  model: string;
  candidateCount: number;
}

export interface AiStockAgentStep {
  stage: 'input' | 'config' | 'candidate' | 'prompt' | 'model' | 'validate' | 'done';
  title: string;
  detail: string;
  at: number;
}

export type AiStockProgress = (step: AiStockAgentStep) => void;

type ModelPickPayload = {
  summary?: unknown;
  picks?: unknown;
  warnings?: unknown;
};

function num(v: number | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(3)) : null;
}

function textArray(v: unknown): string[] {
  if (!Array.isArray(v)) {
    return [];
  }
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0)
    .slice(0, 6);
}

function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return 0.5;
  }
  if (n > 1) {
    return Math.max(0, Math.min(1, n / 100));
  }
  return Math.max(0, Math.min(1, n));
}

function requestedPickLimit(prompt: string): number {
  const m = /(?:筛|选|推荐|找|挑)?\s*(\d{1,2})\s*(?:只|支|个|条)?/.exec(prompt);
  if (!m) {
    return 8;
  }
  return Math.max(1, Math.min(20, Number(m[1])));
}

function compactCandidate(c: AiStockCandidate): Record<string, unknown> {
  return {
    code: c.code,
    name: c.name,
    source: c.source,
    price: num(c.price),
    changePct: num(c.changePct),
    mainNetInflowWan: num(c.mainNetInflowWan),
    amountYi: c.amountYuan === null ? null : num(c.amountYuan / 100_000_000),
    pnlPct: c.pnlPct === undefined ? undefined : num(c.pnlPct),
  };
}

function systemPrompt(): string {
  return [
    '你是 TraderX 的 A 股选股筛选助手。',
    '你只能基于用户给出的筛选描述和候选股票 JSON 做信息筛选，不能编造候选池之外的股票。',
    '这不是投资建议；遇到信息不足时要在 riskNotes 或 warnings 中说明。',
    '只返回 JSON，不要 Markdown，不要代码块。',
    'JSON 结构必须为：{"summary":"...","picks":[{"code":"sh600000","name":"...","reason":"...","confidence":0.72,"matchedRules":["..."],"riskNotes":["..."]}],"warnings":["..."]}',
  ].join('\n');
}

function userPrompt(prompt: string, candidates: AiStockCandidate[], pickLimit: number): string {
  return JSON.stringify({
    task: '根据自然语言描述从候选股票中筛选股票',
    userRequest: prompt,
    pickLimit,
    fields: {
      changePct: '涨跌幅，单位 %',
      mainNetInflowWan: '主力净流入，单位万元',
      amountYi: '成交额，单位亿元',
      pnlPct: '用户本地持仓浮盈亏比例，单位 %，可能为空',
    },
    candidates: candidates.map(compactCandidate),
  });
}

export class AiStockAgentService {
  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly candidateProvider: AiCandidateProvider,
  ) {}

  async selectStocks(prompt: string, scope: AiCandidateScope, onProgress?: AiStockProgress): Promise<AiStockPickResult> {
    const steps: AiStockAgentStep[] = [];
    const progress = (stage: AiStockAgentStep['stage'], title: string, detail: string): void => {
      const step = { stage, title, detail, at: Date.now() };
      steps.push(step);
      onProgress?.(step);
    };

    progress('input', '读取输入', `候选池范围：${scopeLabel(scope)}`);
    const query = prompt.trim();
    if (!query) {
      throw new Error('请输入一句选股描述');
    }

    progress('config', '读取模型配置', '正在读取 provider、baseUrl、model、timeout 与本机密钥状态');
    const config = await readAiRuntimeConfig(this.ctx);
    const apiKey = await getAiApiKey(this.ctx, config.provider);
    validateAiRuntimeConfig(config, apiKey);
    progress('config', '模型配置有效', `使用 ${config.providerLabel} / ${config.model}，超时 ${config.timeoutMs}ms`);

    const maxCandidates = this.getMaxCandidates();
    progress('candidate', '构建候选股票池', `最多收集 ${maxCandidates} 只，先按候选池范围拉取并补齐行情/资金字段`);
    const candidateResult = await this.candidateProvider.build(scope, maxCandidates);
    if (candidateResult.candidates.length === 0) {
      throw new Error(candidateResult.warnings[0] ?? '没有可供筛选的候选股票');
    }
    progress(
      'candidate',
      '候选池准备完成',
      `实际候选 ${candidateResult.candidates.length} 只；数据来源包含 ${sourceSummary(candidateResult.candidates)}`,
    );

    const client = new OpenAiCompatibleClient({
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: apiKey!,
      timeoutMs: config.timeoutMs,
    });
    const pickLimit = requestedPickLimit(query);
    progress('prompt', '生成筛选提示词', `目标返回最多 ${pickLimit} 只；只允许模型从候选池中选择，并要求输出严格 JSON`);
    progress('model', '调用 AI 模型', '正在等待模型基于候选池给出推荐理由、匹配规则和风险提示');
    const payload = (await client.completeJson({
      temperature: 0.15,
      maxTokens: 1800,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPrompt(query, candidateResult.candidates, pickLimit) },
      ],
    })) as ModelPickPayload;

    progress('validate', '校验模型输出', '正在过滤候选池之外的代码、重复项和无效字段');
    const picks = this.validatePicks(payload, candidateResult.candidates).slice(0, pickLimit);
    progress('done', '筛选完成', `有效结果 ${picks.length} 只，已附带匹配规则和风险说明`);
    return {
      summary: typeof payload.summary === 'string' && payload.summary.trim() ? payload.summary.trim() : '已完成筛选',
      picks,
      warnings: [...candidateResult.warnings, ...textArray(payload.warnings)],
      steps,
      providerLabel: config.providerLabel,
      model: config.model,
      candidateCount: candidateResult.candidates.length,
    };
  }

  async testConnection(): Promise<string> {
    const config = await readAiRuntimeConfig(this.ctx);
    const apiKey = await getAiApiKey(this.ctx, config.provider);
    validateAiRuntimeConfig(config, apiKey);
    const client = new OpenAiCompatibleClient({
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: apiKey!,
      timeoutMs: Math.min(config.timeoutMs, 20_000),
    });
    await client.completeJson({
      temperature: 0,
      maxTokens: 80,
      messages: [
        { role: 'system', content: '只返回 JSON：{"ok":true}' },
        { role: 'user', content: '测试连接' },
      ],
    });
    return `${config.providerLabel} / ${config.model} 连接成功`;
  }

  private getMaxCandidates(): number {
    const raw = vscode.workspace.getConfiguration('traderx').get<number>('ai.maxCandidates');
    return Math.max(10, Math.min(120, typeof raw === 'number' ? raw : 60));
  }

  private validatePicks(payload: ModelPickPayload, candidates: AiStockCandidate[]): AiStockPick[] {
    const byCode = new Map(candidates.map((c) => [c.code, c]));
    const raw = Array.isArray(payload.picks) ? payload.picks : [];
    const out: AiStockPick[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const obj = item as Record<string, unknown> | null;
      if (!obj || typeof obj !== 'object') {
        continue;
      }
      const code = typeof obj.code === 'string' ? obj.code.trim().toLowerCase() : '';
      const candidate = byCode.get(code);
      if (!candidate || seen.has(code)) {
        continue;
      }
      seen.add(code);
      const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : '符合本次筛选条件';
      out.push({
        code,
        name: candidate.name,
        source: candidate.source,
        reason,
        confidence: clampConfidence(obj.confidence),
        matchedRules: textArray(obj.matchedRules),
        riskNotes: textArray(obj.riskNotes),
      });
    }
    return out;
  }
}

function scopeLabel(scope: AiCandidateScope): string {
  switch (scope) {
    case 'activeGroup':
      return '当前分组';
    case 'allWatchlist':
      return '全部自选';
    case 'hotMarket':
      return '市场热门';
    case 'mixed':
      return '自选 + 市场热门';
    default:
      return scope;
  }
}

function sourceSummary(candidates: AiStockCandidate[]): string {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    counts.set(c.source, (counts.get(c.source) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([source, count]) => `${source} ${count} 只`)
    .join('、');
}
