import { fetchConceptTopStocks, fetchLimitUp, fetchTopConcepts } from '../providers/market';
import type { QuoteService } from '../services/quoteService';
import { normalizeStockInput, type NormalizedCode } from '../stockCode';
import type { WatchlistStore } from '../storage/watchlistStore';
import type { QuoteRow, RankRow } from '../types';

export type AiCandidateScope = 'activeGroup' | 'allWatchlist' | 'hotMarket' | 'mixed';

export interface AiStockCandidate {
  code: NormalizedCode;
  name: string;
  source: string;
  price: number | null;
  changePct: number | null;
  mainNetInflowWan: number | null;
  amountYuan: number | null;
  pnlPct?: number | null;
}

export interface CandidateBuildResult {
  scope: AiCandidateScope;
  candidates: AiStockCandidate[];
  warnings: string[];
}

function normalizeRankCode(code: string): NormalizedCode | null {
  const n = normalizeStockInput(code);
  return n.ok ? n.code : null;
}

function uniqueCodes(codes: NormalizedCode[], max: number): NormalizedCode[] {
  const seen = new Set<NormalizedCode>();
  const out: NormalizedCode[] = [];
  for (const code of codes) {
    if (seen.has(code)) {
      continue;
    }
    seen.add(code);
    out.push(code);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

function quoteToCandidate(row: QuoteRow, source: string, fallbackName?: string): AiStockCandidate {
  return {
    code: row.code,
    name: row.name && row.name !== '—' && row.name !== '…' ? row.name : fallbackName ?? row.code,
    source,
    price: row.price,
    changePct: row.changePct,
    mainNetInflowWan: row.mainNetInflowWan,
    amountYuan: row.amountYuan,
    pnlPct: row.pnlPct,
  };
}

function rankRowsToCodes(rows: RankRow[]): Array<{ code: NormalizedCode; name: string }> {
  const out: Array<{ code: NormalizedCode; name: string }> = [];
  for (const row of rows) {
    const code = normalizeRankCode(row.code);
    if (code) {
      out.push({ code, name: row.name });
    }
  }
  return out;
}

export class AiCandidateProvider {
  constructor(
    private readonly store: WatchlistStore,
    private readonly quoteService: QuoteService,
  ) {}

  async build(scope: AiCandidateScope, maxCandidates: number): Promise<CandidateBuildResult> {
    const max = Math.max(5, Math.min(120, maxCandidates));
    const warnings: string[] = [];
    const watchlistCodes = this.getWatchlistCodes(scope);
    const hot = scope === 'hotMarket' || scope === 'mixed' ? await this.fetchHotMarketCodes(warnings) : [];
    const codes = uniqueCodes([...watchlistCodes, ...hot.map((x) => x.code)], max);

    if (codes.length === 0) {
      return { scope, candidates: [], warnings: [...warnings, '没有可供筛选的候选股票'] };
    }

    const hotNameByCode = new Map(hot.map((x) => [x.code, x.name]));
    const rows = await this.quoteService.fetchRows(codes, this.store.getPositions());
    const candidates = rows.map((row) => {
      const source = watchlistCodes.includes(row.code) ? '自选' : '市场热门';
      return quoteToCandidate(row, source, hotNameByCode.get(row.code));
    });

    return { scope, candidates, warnings };
  }

  private getWatchlistCodes(scope: AiCandidateScope): NormalizedCode[] {
    if (scope === 'activeGroup') {
      return this.store.getCodesForActiveGroup();
    }
    if (scope === 'allWatchlist' || scope === 'mixed') {
      return uniqueCodes(
        this.store.getGroups().flatMap((g) => g.codes),
        120,
      );
    }
    return [];
  }

  private async fetchHotMarketCodes(warnings: string[]): Promise<Array<{ code: NormalizedCode; name: string }>> {
    const out: Array<{ code: NormalizedCode; name: string }> = [];
    try {
      out.push(...rankRowsToCodes(await fetchLimitUp()));
    } catch (e) {
      warnings.push(`涨停候选获取失败：${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const concepts = await fetchTopConcepts();
      for (const concept of concepts.slice(0, 4)) {
        try {
          out.push(...rankRowsToCodes(await fetchConceptTopStocks(concept.code)));
        } catch {
          // 单个概念失败不影响整体候选池。
        }
      }
    } catch (e) {
      warnings.push(`概念候选获取失败：${e instanceof Error ? e.message : String(e)}`);
    }

    return uniqueCodes(
      out.map((x) => x.code),
      120,
    ).map((code) => out.find((x) => x.code === code)!);
  }
}
