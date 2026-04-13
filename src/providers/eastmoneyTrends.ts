import { fetchText } from '../http';

/** 与行情接口保持一致，缺少时易被服务端拒绝或返回空 */
const UT = 'fa5fd1943c7b386f172d6893dbfba10b';

export interface TrendPoint {
  timeLabel: string;
  price: number;
}

export interface TrendsResult {
  name: string;
  preClose: number;
  points: TrendPoint[];
}

/**
 * 东方财富分时 trends2：data.trends 为字符串数组，
 * 每行形如 `2026-04-13 09:30,1444.00,1444.00,1444.00,1444.00,...`
 * 取第二列为价格绘制分时线。
 */
export async function fetchTrends2(secid: string): Promise<TrendsResult> {
  const fields1 = 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13';
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58';
  const qs = new URLSearchParams({
    secid,
    ut: UT,
    invt: '2',
    fields1,
    fields2,
    iscr: '0',
    ndays: '1',
  });
  const url = `https://push2.eastmoney.com/api/qt/stock/trends2/get?${qs.toString()}`;
  const text = await fetchText(url, {
    headers: {
      Referer: 'https://quote.eastmoney.com/',
      Origin: 'https://quote.eastmoney.com',
    },
    timeoutMs: 25000,
  });
  const json = JSON.parse(text) as {
    rc?: number;
    data?: {
      name?: string;
      preClose?: number;
      trends?: string[];
    } | null;
  };
  if (json.rc !== 0 || !json.data || !json.data.trends) {
    throw new Error('分时数据不可用');
  }
  const name = json.data.name ?? '—';
  const preClose = Number(json.data.preClose ?? 0);
  const points: TrendPoint[] = [];
  for (const line of json.data.trends) {
    const parts = line.split(',');
    if (parts.length < 2) {
      continue;
    }
    const timeLabel = (parts[0] ?? '').trim();
    const price = Number(parts[1]);
    if (!Number.isFinite(price)) {
      continue;
    }
    points.push({ timeLabel, price });
  }
  if (points.length === 0) {
    throw new Error('分时数据解析为空');
  }
  return { name, preClose: Number.isFinite(preClose) ? preClose : 0, points };
}
