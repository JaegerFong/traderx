import type { NormalizedCode } from '../stockCode';
import { toEastmoneySecid } from '../stockCode';
import { fetchTextPush2 } from './market';

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
 * - f169：多为万元（旧）
 * - f137：多为当日主力净流入（元），见东财 PC 页常用字段
 * - f62：部分场景为元，需 /10000
 * - f184、f279、f303：作备用（元→万）
 */
function pickMainNetInflowWan(data: Record<string, unknown>): number | null {
  const f169 = num(data.f169);
  const f137 = num(data.f137);
  const f62 = num(data.f62);
  const f184 = num(data.f184);
  const f279 = num(data.f279);
  const f303 = num(data.f303);

  if (f169 !== null) {
    if (Math.abs(f169) < 1e-9 && f62 !== null && Math.abs(f62) > 1e-3) {
      return f62 / 10_000;
    }
    return f169;
  }
  if (f137 !== null) {
    return f137 / 10_000;
  }
  if (f62 !== null) {
    return f62 / 10_000;
  }
  if (f184 !== null) {
    return f184 / 10_000;
  }
  if (f279 !== null) {
    return f279 / 10_000;
  }
  if (f303 !== null) {
    return f303 / 10_000;
  }
  return null;
}

export async function fetchEastmoneyMainForceOne(code: NormalizedCode): Promise<EastmoneyExtra> {
  const secid = toEastmoneySecid(code);
  if (!secid) {
    return { mainNetInflowWan: null };
  }

  const fields = ['f57', 'f58', 'f62', 'f137', 'f169', 'f170', 'f184', 'f279', 'f303'].join(',');
  const qs = new URLSearchParams({
    secid,
    ut: UT,
    invt: '2',
    fltt: '2',
    fields,
  });
  const pathAndQuery = `/api/qt/stock/get?${qs.toString()}`;

  try {
    const text = await fetchTextPush2(pathAndQuery, 22_000);
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
