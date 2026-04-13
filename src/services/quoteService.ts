import * as vscode from 'vscode';
import type { NormalizedCode } from '../stockCode';
import { fetchEastmoneyMainForceOne, mapLimit } from '../providers/eastmoney';
import { fetchSinaQuotes } from '../providers/sina';
import { fetchTencentQuotes } from '../providers/tencent';
import type { QuoteRow, RawQuote } from '../types';

function isQuoteUsable(q: RawQuote | undefined): boolean {
  return !!q && q.price !== null;
}

function mergeFromProviders(
  codes: NormalizedCode[],
  order: Array<'sina' | 'tencent'>,
  maps: { sina: Map<string, RawQuote>; tencent: Map<string, RawQuote> },
): Map<string, RawQuote> {
  const out = new Map<string, RawQuote>();
  for (const code of codes) {
    let picked: RawQuote | undefined;
    for (const p of order) {
      const m = p === 'sina' ? maps.sina : maps.tencent;
      const q = m.get(code);
      if (isQuoteUsable(q)) {
        picked = q;
        break;
      }
    }
    if (!picked) {
      for (const p of order) {
        const m = p === 'sina' ? maps.sina : maps.tencent;
        const q = m.get(code);
        if (q) {
          picked = q;
          break;
        }
      }
    }
    if (picked) {
      out.set(code, picked);
    } else {
      out.set(code, {
        code,
        name: '—',
        price: null,
        changePct: null,
        high: null,
        low: null,
        amountYuan: null,
        prevClose: null,
      });
    }
  }
  return out;
}

function getQuoteProviderOrder(): Array<'sina' | 'tencent'> {
  const cfg = vscode.workspace.getConfiguration('traderx');
  const order = (cfg.get<string[]>('quoteProviderOrder') ?? ['sina', 'tencent']).filter(
    (x): x is 'sina' | 'tencent' => x === 'sina' || x === 'tencent',
  );
  if (order.length === 0) {
    order.push('sina', 'tencent');
  }
  return order;
}

async function fetchMergedBaseQuotes(codes: NormalizedCode[]): Promise<Map<string, RawQuote>> {
  const [sinaRes, tencentRes] = await Promise.allSettled([fetchSinaQuotes(codes), fetchTencentQuotes(codes)]);
  const sinaMap = sinaRes.status === 'fulfilled' ? sinaRes.value : new Map<string, RawQuote>();
  const tencentMap = tencentRes.status === 'fulfilled' ? tencentRes.value : new Map<string, RawQuote>();
  return mergeFromProviders(codes, getQuoteProviderOrder(), { sina: sinaMap, tencent: tencentMap });
}

function buildQuoteRows(
  codes: NormalizedCode[],
  positions: Record<string, { cost?: number; shares?: number }>,
  base: Map<string, RawQuote>,
  extras: Array<{ mainNetInflowWan: number | null }>,
  mainForceKnown: boolean,
): QuoteRow[] {
  const rows: QuoteRow[] = [];
  codes.forEach((code, idx) => {
    const raw = base.get(code)!;
    const em = extras[idx]!;
    const pos = positions[code];
    const cost = pos?.cost;
    const shares = pos?.shares;

    let pnlYuan: number | null = null;
    let pnlPct: number | null = null;
    if (raw.price !== null && cost !== undefined && shares !== undefined && shares > 0) {
      pnlYuan = (raw.price - cost) * shares;
      if (cost !== 0) {
        pnlPct = ((raw.price - cost) / cost) * 100;
      }
    }

    const errors: string[] = [];
    if (!isQuoteUsable(raw)) {
      errors.push('基础行情暂不可用');
    }
    if (mainForceKnown && em.mainNetInflowWan === null) {
      errors.push('主力净流入暂不可用');
    }

    rows.push({
      code,
      name: raw.name,
      price: raw.price,
      changePct: raw.changePct,
      mainNetInflowWan: em.mainNetInflowWan,
      high: raw.high,
      low: raw.low,
      amountYuan: raw.amountYuan,
      prevClose: raw.prevClose,
      cost,
      shares,
      pnlYuan,
      pnlPct,
      errors: errors.length ? errors : undefined,
    });
  });
  return rows;
}

export class QuoteService {
  /** 仅新浪+腾讯合并行情，不含东方财富主力（用于首屏快速展示） */
  async fetchRowsBasic(codes: NormalizedCode[], positions: Record<string, { cost?: number; shares?: number }>): Promise<QuoteRow[]> {
    if (codes.length === 0) {
      return [];
    }
    const base = await fetchMergedBaseQuotes(codes);
    const pending = codes.map(() => ({ mainNetInflowWan: null as number | null }));
    return buildQuoteRows(codes, positions, base, pending, false);
  }

  /** 在 fetchRowsBasic 结果上补全主力净流入 */
  async enrichMainForce(codes: NormalizedCode[], rows: QuoteRow[]): Promise<QuoteRow[]> {
    if (codes.length === 0) {
      return rows;
    }
    const extras = await mapLimit(codes, 8, async (code) => fetchEastmoneyMainForceOne(code));
    return codes.map((_code, idx) => {
      const prev = rows[idx]!;
      const em = extras[idx]!;
      const errors = [...(prev.errors ?? [])];
      const filtered = errors.filter((e) => e !== '主力净流入暂不可用');
      if (em.mainNetInflowWan === null) {
        filtered.push('主力净流入暂不可用');
      }
      return {
        ...prev,
        mainNetInflowWan: em.mainNetInflowWan,
        errors: filtered.length ? filtered : undefined,
      };
    });
  }

  async fetchRows(codes: NormalizedCode[], positions: Record<string, { cost?: number; shares?: number }>): Promise<QuoteRow[]> {
    if (codes.length === 0) {
      return [];
    }
    const base = await fetchMergedBaseQuotes(codes);
    const extras = await mapLimit(codes, 8, async (code) => fetchEastmoneyMainForceOne(code));
    return buildQuoteRows(codes, positions, base, extras, true);
  }
}
