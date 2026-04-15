import type { NormalizedCode } from '../stockCode';
import { toEastmoneySecid } from '../stockCode';
import { fetchText } from '../http';
import type { ConceptItem, IndexId, IndexQuote, LimitRow, MarketOverview, RankRow } from '../types';
import { fetchTencentQuotes } from './tencent';

/** 与东财 push2 接口保持一致，缺少时易被服务端拒绝或返回空 */
const UT = 'fa5fd1943c7b386f172d6893dbfba10b';
const PUSH2_HOSTS = ['push2.eastmoney.com', '82.push2.eastmoney.com', '20.push2.eastmoney.com', '16.push2.eastmoney.com'] as const;

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtTimeHHMMSS(v: unknown): string | null {
  if (v === undefined || v === null) {
    return null;
  }
  const s = String(v).trim();
  if (!s) {
    return null;
  }
  // 093000 / 93000 / 0930
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length === 6) {
    return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;
  }
  if (digits.length === 5) {
    return `0${digits[0]}:${digits.slice(1, 3)}:${digits.slice(3, 5)}`;
  }
  if (digits.length === 4) {
    return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  }
  return null;
}

type ClistDiff = Record<string, unknown>;

function isSocketHangUp(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: string }).code) : '';
  return msg.includes('socket hang up') || msg.includes('ECONNRESET') || code === 'ECONNRESET';
}

export function isLikelyPush2BlockedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    isSocketHangUp(e) ||
    msg.includes('Failure when receiving data from the peer') ||
    msg.includes('Empty reply from server')
  );
}

/** 东财 push2 拉取（多域名回退、短连接），供 `eastmoney.ts` 等复用 */
export async function fetchTextPush2(pathAndQuery: string, timeoutMs: number): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < PUSH2_HOSTS.length; i++) {
    const host = PUSH2_HOSTS[i]!;
    const url = `https://${host}${pathAndQuery}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fetchText(url, {
          headers: {
            Referer: 'https://quote.eastmoney.com/',
            Origin: 'https://quote.eastmoney.com',
            // 市场行情接口更容易被对端断开：强制短连接
            Connection: 'close',
          },
          timeoutMs,
        });
      } catch (e) {
        lastErr = e;
        // 非断连：不要重试/回退，直接失败
        if (!isSocketHangUp(e)) {
          throw e instanceof Error ? e : new Error(String(e));
        }
        // 断连：同 host 轻微退避重试；最后一次再回退 host
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchClist(fs: string, opts: { pn?: number; pz?: number; fid?: string; po?: 0 | 1; fields: string[] }): Promise<ClistDiff[]> {
  const qs = new URLSearchParams({
    pn: String(opts.pn ?? 1),
    pz: String(opts.pz ?? 10),
    po: String(opts.po ?? 1),
    np: '1',
    fltt: '2',
    invt: '2',
    ut: UT,
    fs,
    fields: opts.fields.join(','),
  });
  if (opts.fid) {
    qs.set('fid', opts.fid);
  }
  const text = await fetchTextPush2(`/api/qt/clist/get?${qs.toString()}`, 25000);
  const json = JSON.parse(text) as { rc?: number; data?: { diff?: ClistDiff[] } | null };
  if (json.rc !== 0 || !json.data || !Array.isArray(json.data.diff)) {
    return [];
  }
  return json.data.diff;
}

async function fetchStockGet(secid: string, fields: string[]): Promise<Record<string, unknown> | null> {
  const qs = new URLSearchParams({
    secid,
    ut: UT,
    invt: '2',
    fltt: '2',
    fields: fields.join(','),
  });
  const text = await fetchTextPush2(`/api/qt/stock/get?${qs.toString()}`, 20000);
  const json = JSON.parse(text) as { rc?: number; data?: Record<string, unknown> | null };
  if (json.rc !== 0 || !json.data) {
    return null;
  }
  return json.data;
}

/** 沪深北A股（尽量覆盖）：主板/科创/创业/北交所 */
const FS_ALL_A =
  'm:1+t:2,m:1+t:23,m:0+t:6,m:0+t:13,m:0+t:80';

export async function fetchMarketOverview(): Promise<MarketOverview> {
  // 用 clist/get 做统计：请求量过大时易被对端断开（socket hang up），因此尽量分页更小、页数更少。
  const fields = ['f3', 'f6'];
  // 这里用“抽样统计”换取稳定性与速度：只取前 1000~2000 条，足够做概况展示（不追求严丝合缝）。
  // 若你希望绝对精确的涨跌家数/总额，需要拉全市场列表，会显著增加断开概率。
  const page1 = await fetchClist(FS_ALL_A, { pn: 1, pz: 1000, fid: 'f3', po: 1, fields });
  const page2 = await fetchClist(FS_ALL_A, { pn: 2, pz: 1000, fid: 'f3', po: 1, fields });
  const all = [...page1, ...page2];

  let up = 0;
  let down = 0;
  let flat = 0;
  let turnover = 0;
  let turnoverKnown = false;

  for (const it of all) {
    const pct = num(it.f3);
    if (pct === null) {
      continue;
    }
    if (pct > 0) up++;
    else if (pct < 0) down++;
    else flat++;

    const amt = num(it.f6);
    if (amt !== null) {
      turnover += amt;
      turnoverKnown = true;
    }
  }

  return {
    upCount: all.length > 0 ? up : null,
    downCount: all.length > 0 ? down : null,
    flatCount: all.length > 0 ? flat : null,
    turnoverYuan: turnoverKnown ? turnover : null,
  };
}

export async function fetchIndexQuotes(): Promise<IndexQuote[]> {
  const indices: Array<{ id: IndexId; name: string }> = [
    { id: 'sh000001', name: '上证指数' },
    { id: 'sz399001', name: '深证成指' },
    { id: 'sz399006', name: '创业板指' },
    { id: 'sh000688', name: '科创50' },
  ];

  const tasks = indices.map(async (idx) => {
    const secid = toEastmoneySecid(idx.id as unknown as NormalizedCode);
    if (!secid) {
      return { id: idx.id, name: idx.name, price: null, changePct: null, amountYuan: null } satisfies IndexQuote;
    }
    const data = await fetchStockGet(secid, ['f58', 'f2', 'f3', 'f6']);
    return {
      id: idx.id,
      name: (data?.f58 ? String(data.f58) : idx.name) || idx.name,
      price: num(data?.f2),
      changePct: num(data?.f3),
      amountYuan: num(data?.f6),
    } satisfies IndexQuote;
  });

  const res = await Promise.allSettled(tasks);
  const out = res.map((r, i) => {
    const fallback = indices[i]!;
    if (r.status === 'fulfilled') {
      return r.value;
    }
    return { id: fallback.id, name: fallback.name, price: null, changePct: null, amountYuan: null };
  });

  // 若 push2 全部不可用，降级到腾讯指数行情（可用性优先）
  const hasAny = out.some((x) => x.price !== null || x.changePct !== null);
  if (hasAny) {
    return out;
  }

  try {
    const codes = ['sh000001', 'sz399001', 'sz399006', 'sh000688'] as NormalizedCode[];
    const tq = await fetchTencentQuotes(codes);
    return indices.map((idx) => {
      const q = tq.get(idx.id as NormalizedCode);
      return {
        id: idx.id,
        name: q?.name || idx.name,
        price: q?.price ?? null,
        changePct: q?.changePct ?? null,
        amountYuan: q?.amountYuan ?? null,
      };
    });
  } catch {
    return out;
  }
}

function mapRankRow(it: ClistDiff): RankRow {
  return {
    code: String(it.f12 ?? it.f13 ?? '—'),
    name: String(it.f14 ?? '—'),
    price: num(it.f2),
    changePct: num(it.f3),
    amountYuan: num(it.f6),
  };
}

function mapLimitRow(it: ClistDiff): LimitRow {
  const base = mapRankRow(it);
  // 时间字段不稳定：尽量从常见字段里猜测（拿不到则返回 null）
  const t =
    fmtTimeHHMMSS(it.f124) ??
    fmtTimeHHMMSS(it.f128) ??
    fmtTimeHHMMSS(it.f22) ??
    fmtTimeHHMMSS(it.f23) ??
    null;
  return { ...base, limitTime: t };
}

export async function fetchTopConcepts(): Promise<RankRow[]> {
  // 东财板块（概念）常见：m:90+t:3
  const diff = await fetchClist('m:90+t:3', {
    pn: 1,
    pz: 10,
    fid: 'f3',
    po: 1,
    fields: ['f12', 'f14', 'f2', 'f3', 'f6'],
  });
  return diff.map(mapRankRow);
}

export async function fetchTopIndustries(): Promise<RankRow[]> {
  // 行业板块常见：m:90+t:2
  const diff = await fetchClist('m:90+t:2', {
    pn: 1,
    pz: 10,
    fid: 'f3',
    po: 1,
    fields: ['f12', 'f14', 'f2', 'f3', 'f6'],
  });
  return diff.map(mapRankRow);
}

export async function fetchLimitUp(): Promise<LimitRow[]> {
  // 先取涨幅靠前的一批，再做“涨停”阈值过滤（不同板块 10%/20%）
  const diff = await fetchClist(FS_ALL_A, {
    pn: 1,
    pz: 300,
    fid: 'f3',
    po: 1,
    fields: ['f12', 'f14', 'f2', 'f3', 'f6', 'f124', 'f128', 'f22', 'f23'],
  });
  const rows = diff.map(mapLimitRow).filter((r) => (r.changePct ?? -999) >= 9.8);
  return rows;
}

export async function fetchLimitDown(): Promise<LimitRow[]> {
  const diff = await fetchClist(FS_ALL_A, {
    pn: 1,
    pz: 300,
    fid: 'f3',
    po: 0,
    fields: ['f12', 'f14', 'f2', 'f3', 'f6', 'f124', 'f128', 'f22', 'f23'],
  });
  const rows = diff.map(mapLimitRow).filter((r) => (r.changePct ?? 999) <= -9.8);
  return rows;
}

export async function searchConcepts(keyword: string): Promise<ConceptItem[]> {
  const q = keyword.trim();
  if (!q) {
    return [];
  }
  // 简化实现：在概念板块列表里按名称过滤。调用方应做缓存与 debounce。
  const diff = await fetchClist('m:90+t:3', {
    pn: 1,
    pz: 200,
    fid: 'f3',
    po: 1,
    fields: ['f12', 'f14'],
  });
  const items = diff
    .map((it) => ({ code: String(it.f12 ?? ''), name: String(it.f14 ?? '') }))
    .filter((it) => it.code && it.name && it.name.includes(q))
    .slice(0, 50);
  return items;
}

export async function fetchConceptTopStocks(conceptCode: string): Promise<RankRow[]> {
  const code = conceptCode.trim();
  if (!code) {
    return [];
  }
  // 东财常见：fs=b:BKxxxx（板块成分）
  const diff = await fetchClist(`b:${code}`, {
    pn: 1,
    pz: 10,
    fid: 'f3',
    po: 1,
    fields: ['f12', 'f14', 'f2', 'f3', 'f6'],
  });
  return diff.map(mapRankRow);
}

