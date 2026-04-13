import type { NormalizedCode } from '../stockCode';
import { normalizeStockInput } from '../stockCode';
import { fetchText } from '../http';

export interface SuggestItem {
  code: NormalizedCode;
  name: string;
}

function extractRows(json: unknown): Record<string, unknown>[] {
  const j = json as Record<string, unknown> | null;
  if (!j || typeof j !== 'object') {
    return [];
  }
  const table = j.QuotationCodeTable as { Data?: unknown } | undefined;
  const data = table?.Data ?? (j as { Data?: unknown }).Data;
  if (Array.isArray(data)) {
    return data.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  }
  if (data && typeof data === 'object') {
    return [data as Record<string, unknown>];
  }
  return [];
}

function codeFromUrl(u: string): NormalizedCode | null {
  const m = /\/([shbj]{2})(\d{6})\.html/i.exec(u);
  if (!m) {
    return null;
  }
  const n = normalizeStockInput(`${m[1].toLowerCase()}${m[2]}`);
  return n.ok ? n.code : null;
}

function marketToPrefix(market: unknown, code6: string): 'sh' | 'sz' | 'bj' | null {
  const m = String(market ?? '').trim();
  if (m === '1' || m.toUpperCase() === 'SH' || m === '17') {
    return 'sh';
  }
  if (m === '0' || m.toUpperCase() === 'SZ' || m === '33') {
    return 'sz';
  }
  if (m.toUpperCase() === 'BJ' || m === '43' || m === '81') {
    return 'bj';
  }
  if (code6.startsWith('6') || code6.startsWith('5')) {
    return 'sh';
  }
  if (code6.startsWith('0') || code6.startsWith('3')) {
    return 'sz';
  }
  if (code6.startsWith('8') || code6.startsWith('4') || code6.startsWith('9')) {
    return 'bj';
  }
  return null;
}

/**
 * 东方财富搜索建议：支持股票名称、拼音首字母、代码片段。
 * type=14 为证券综合建议。
 */
export async function searchStocksEastmoney(keyword: string): Promise<SuggestItem[]> {
  const q = keyword.trim();
  if (q.length < 1) {
    return [];
  }

  const url = `https://searchadapter.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&token=D43BF722C8E33BDC906FB84D85E326E8&type=14&count=20`;
  try {
    const text = await fetchText(url, {
      headers: {
        Referer: 'https://www.eastmoney.com/',
        Accept: 'application/json,text/javascript,*/*',
      },
    });
    const json = JSON.parse(text) as unknown;
    const rows = extractRows(json);
    const out: SuggestItem[] = [];

    for (const o of rows) {
      const codeStr = String(o.Code ?? o.code ?? '').trim();
      const name = String(o.Name ?? o.name ?? '').trim();
      const urlField = String(o.Url ?? o.url ?? '').trim();
      if (!/^\d{6}$/.test(codeStr) || !name) {
        continue;
      }
      let normalized: NormalizedCode | null = codeFromUrl(urlField);
      if (!normalized) {
        const prefix = marketToPrefix(o.Market ?? o.MktNum ?? o.SecurityType, codeStr);
        if (!prefix) {
          continue;
        }
        const n = normalizeStockInput(`${prefix}${codeStr}`);
        normalized = n.ok ? n.code : null;
      }
      if (normalized) {
        out.push({ code: normalized, name });
      }
    }
    return dedupe(out.length > 0 ? out : tryDirectCode(q));
  } catch {
    return tryDirectCode(q);
  }
}

/** 用户直接输入 6 位或带前缀代码时，不依赖搜索接口 */
function tryDirectCode(q: string): SuggestItem[] {
  const n = normalizeStockInput(q);
  if (!n.ok) {
    return [];
  }
  return [{ code: n.code, name: n.code }];
}

function dedupe(items: SuggestItem[]): SuggestItem[] {
  const seen = new Set<string>();
  const out: SuggestItem[] = [];
  for (const it of items) {
    if (!seen.has(it.code)) {
      seen.add(it.code);
      out.push(it);
    }
  }
  return out;
}
