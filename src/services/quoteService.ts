import * as vscode from 'vscode';
import type { NormalizedCode } from '../stockCode';
import { fetchEastmoneyMainForceOne, mapLimit } from '../providers/eastmoney';
import { fetchSinaQuotes } from '../providers/sina';
import { fetchTencentQuotes } from '../providers/tencent';
import { isCnAshareCallAuctionWindow } from '../marketHours';
import type { QuoteRow, RawQuote } from '../types';

function isQuoteUsable(q: RawQuote | undefined): boolean {
  if (!q) {
    return false;
  }
  if (q.price !== null && q.price > 0) {
    return true;
  }
  const bid = q.bidPrice;
  const ask = q.askPrice;
  return (bid !== null && bid > 0) || (ask !== null && ask > 0);
}

/**
 * 部分数据源在集合竞价/未开盘时涨跌幅字段与现价、昨收不一致（例如误为 100%），
 * 在横盘或推导值明显更合理时用 (现价-昨收)/昨收 覆盖。
 */
function sanitizeChangePct(raw: RawQuote): RawQuote {
  const { price, prevClose, changePct } = raw;
  if (price === null || prevClose === null || prevClose === 0) {
    return raw;
  }
  const computed = ((price - prevClose) / prevClose) * 100;
  if (changePct === null || Number.isNaN(changePct)) {
    return { ...raw, changePct: computed };
  }
  const diff = Math.abs(changePct - computed);
  if (diff > 0.5 && Math.abs(computed) < 0.05) {
    return { ...raw, changePct: computed };
  }
  if (diff > 10 && Math.abs(computed) < 1) {
    return { ...raw, changePct: computed };
  }
  return raw;
}

/** 9:15–9:30 集合竞价：新浪等源现价可能为 0，用竞买/竞卖价推导展示价 */
function applyCallAuctionPrice(raw: RawQuote, now: Date): RawQuote {
  if (!isCnAshareCallAuctionWindow(now)) {
    return raw;
  }
  const p = raw.price;
  if (p !== null && p > 0) {
    return raw;
  }
  const bid = raw.bidPrice;
  const ask = raw.askPrice;
  let np: number | null = null;
  if (bid !== null && bid > 0 && ask !== null && ask > 0) {
    np = (bid + ask) / 2;
  } else if (bid !== null && bid > 0) {
    np = bid;
  } else if (ask !== null && ask > 0) {
    np = ask;
  }
  if (np === null) {
    return raw;
  }
  let changePct: number | null = null;
  if (raw.prevClose !== null && raw.prevClose !== 0) {
    changePct = ((np - raw.prevClose) / raw.prevClose) * 100;
  }
  return { ...raw, price: np, changePct };
}

function mergeFromProviders(
  codes: NormalizedCode[],
  order: Array<'sina' | 'tencent'>,
  maps: { sina: Map<string, RawQuote>; tencent: Map<string, RawQuote> },
  now: Date,
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
      let r = applyCallAuctionPrice(picked, now);
      r = sanitizeChangePct(r);
      out.set(code, r);
    } else {
      out.set(code, {
        code,
        name: '—',
        price: null,
        changePct: null,
        high: null,
        low: null,
        amountYuan: null,
        bidPrice: null,
        askPrice: null,
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
  return mergeFromProviders(codes, getQuoteProviderOrder(), { sina: sinaMap, tencent: tencentMap }, new Date());
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
      bidPrice: raw.bidPrice,
      askPrice: raw.askPrice,
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
