import type { NormalizedCode } from '../stockCode';
import { toMarketListSymbol } from '../stockCode';
import type { RawQuote } from '../types';
import { fetchText } from '../http';

function mapKeyToNormalized(key: string): NormalizedCode | null {
  const k = key.toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(k)) {
    return k as NormalizedCode;
  }
  return null;
}

/**
 * 腾讯 qt.gtimg.cn：v_sh600519="~" 分隔。
 * 参考字段：3现价 4昨收 5开盘；9 买一价 19 卖一价；31涨跌额 32涨跌幅 33最高 34最低；35 常含 现价/量/额
 */
export function parseTencentLine(key: string, body: string): RawQuote | null {
  const code = mapKeyToNormalized(key);
  if (!code) {
    return null;
  }
  if (!body) {
    return {
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
    };
  }

  const p = body.split('~');
  const name = (p[1] ?? '').trim();
  const price = num(p[3]);
  const prevClose = num(p[4]);
  const changePct = num(p[32]);
  const high = num(p[33]);
  const low = num(p[34]);
  const bidPrice = num(p[9]);
  const askPrice = num(p[19]);

  let amountYuan: number | null = null;
  const combo = p[35];
  if (combo && combo.includes('/')) {
    const segs = combo.split('/');
    const last = segs[segs.length - 1];
    amountYuan = num(last);
  }

  let changePctFinal = changePct;
  if (changePctFinal === null && price !== null && prevClose !== null && prevClose !== 0) {
    changePctFinal = ((price - prevClose) / prevClose) * 100;
  }

  return {
    code,
    name: name || '—',
    price,
    changePct: changePctFinal,
    high,
    low,
    amountYuan,
    bidPrice,
    askPrice,
    prevClose,
  };
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === '') {
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export async function fetchTencentQuotes(codes: NormalizedCode[]): Promise<Map<string, RawQuote>> {
  const out = new Map<string, RawQuote>();
  if (codes.length === 0) {
    return out;
  }

  const chunks: NormalizedCode[][] = [];
  const size = 40;
  for (let i = 0; i < codes.length; i += size) {
    chunks.push(codes.slice(i, i + size));
  }

  for (const chunk of chunks) {
    const q = chunk.map((c) => toMarketListSymbol(c)).join(',');
    const url = `https://qt.gtimg.cn/q=${q}`;
    const text = await fetchText(url, {
      headers: { Referer: 'https://finance.qq.com' },
    });
    const re = /v_(sh\d{6}|sz\d{6}|bj\d{6})="([^"]*)";/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = m[1];
      const body = m[2];
      const row = parseTencentLine(key, body);
      if (row) {
        out.set(row.code, row);
      }
    }
  }

  return out;
}
