import type { NormalizedCode } from '../stockCode';
import { toEastmoneySecid } from '../stockCode';
import { fetchText } from '../http';

export interface EastmoneyExtra {
  mainNetInflowWan: number | null;
}

/** 东方财富 push2 常见 ut，缺少时接口可能不返回资金字段 */
const UT = 'fa5fd1943c7b386f172d6893dbfba10b';

function num(v: unknown): number | null {
  if (v === undefined || v === null) {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从 stock/get 的 data 中解析主力净流入（万元）。
 * f169 常为万元；部分环境 f62 为元，需 /10000；f184 可作备用。
 */
function pickMainNetInflowWan(data: Record<string, unknown>): number | null {
  const f169 = num(data.f169);
  const f62 = num(data.f62);
  const f184 = num(data.f184);

  if (f169 !== null) {
    // f169 一般为万元；若异常为 0 而 f62 有显著值，则改用 f62（元→万）
    if (Math.abs(f169) < 1e-9 && f62 !== null && Math.abs(f62) > 1e-3) {
      return f62 / 10_000;
    }
    return f169;
  }
  if (f62 !== null) {
    return f62 / 10_000;
  }
  if (f184 !== null) {
    return f184 / 10_000;
  }
  return null;
}

export async function fetchEastmoneyMainForceOne(code: NormalizedCode): Promise<EastmoneyExtra> {
  const secid = toEastmoneySecid(code);
  if (!secid) {
    return { mainNetInflowWan: null };
  }

  const fields = ['f57', 'f58', 'f62', 'f169', 'f170', 'f184'].join(',');
  const qs = new URLSearchParams({
    secid,
    ut: UT,
    invt: '2',
    fltt: '2',
    fields,
  });
  const url = `https://push2.eastmoney.com/api/qt/stock/get?${qs.toString()}`;

  try {
    const text = await fetchText(url, {
      headers: {
        Referer: 'https://quote.eastmoney.com/',
        Accept: 'application/json,text/plain,*/*',
      },
    });
    const json = JSON.parse(text) as {
      rc?: number;
      data?: Record<string, unknown> | null;
    };
    if (json.rc !== 0 || !json.data) {
      return { mainNetInflowWan: null };
    }
    const wan = pickMainNetInflowWan(json.data);
    return { mainNetInflowWan: wan };
  } catch {
    return { mainNetInflowWan: null };
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= items.length) {
        return;
      }
      results[idx] = await fn(items[idx]!);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
