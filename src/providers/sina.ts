import * as iconv from 'iconv-lite';
import type { NormalizedCode } from '../stockCode';
import { toMarketListSymbol } from '../stockCode';
import type { RawQuote } from '../types';
import { fetchBuffer } from '../http';

function mapNormalizedFromSinaKey(key: string): NormalizedCode | null {
  const k = key.toLowerCase();
  if (k.startsWith('sh') || k.startsWith('sz') || k.startsWith('bj')) {
    return k as NormalizedCode;
  }
  return null;
}

/**
 * 解析新浪财经 hq.sinajs.cn 返回（GBK）。
 * 常见字段顺序：0名称 1开盘 2昨收 3现价 4最高 5最低 ... 8成交量(手) 9成交额(元)
 */
export function parseSinaBody(key: string, body: string): RawQuote | null {
  const code = mapNormalizedFromSinaKey(key.toLowerCase());
  if (!code) {
    return null;
  }
  if (!body || body === '') {
    return {
      code,
      name: '—',
      price: null,
      changePct: null,
      high: null,
      low: null,
      amountYuan: null,
      prevClose: null,
    };
  }

  const parts = body.split(',');
  const name = (parts[0] ?? '').trim();
  const open = num(parts[1]);
  const prevClose = num(parts[2]);
  const price = num(parts[3]);
  const high = num(parts[4]);
  const low = num(parts[5]);
  const volHands = num(parts[8]);
  const amountYuan = num(parts[9]);

  let changePct: number | null = null;
  if (price !== null && prevClose !== null && prevClose !== 0) {
    changePct = ((price - prevClose) / prevClose) * 100;
  }

  return {
    code,
    name: name || '—',
    price,
    changePct,
    high,
    low,
    amountYuan,
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

export async function fetchSinaQuotes(codes: NormalizedCode[]): Promise<Map<string, RawQuote>> {
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
    const list = chunk.map((c) => toMarketListSymbol(c)).join(',');
    const url = `https://hq.sinajs.cn/list=${list}`;
    const buf = await fetchBuffer(url, {
      headers: { Referer: 'https://finance.sina.com.cn' },
    });
    const text = iconv.decode(buf, 'gbk');
    const re = /var hq_str_(\w+)=["']([^"']*)["'];?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = m[1];
      const body = m[2];
      const q = parseSinaBody(key, body);
      if (q) {
        out.set(q.code, q);
      }
    }
  }

  return out;
}
