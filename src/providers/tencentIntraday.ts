import type { NormalizedCode } from '../stockCode';
import { toMarketListSymbol } from '../stockCode';
import type { TrendsResult } from './eastmoneyTrends';
import { fetchText } from '../http';

/**
 * 腾讯 ifzq 分时（JSON），作东方财富失败时的备用。
 * @see https://ifzq.gtimg.cn/appstock/app/minute/query?code=sh600519
 */
export async function fetchTrendsTencent(code: NormalizedCode): Promise<TrendsResult> {
  const sym = toMarketListSymbol(code);
  const url = `https://ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(sym)}`;
  const text = await fetchText(url, {
    headers: {
      Referer: 'https://finance.qq.com/',
    },
    timeoutMs: 25000,
  });

  const json = JSON.parse(text) as {
    code?: number;
    data?: Record<string, { data?: { data?: string[] }; qt?: Record<string, string[]> }>;
  };
  if (json.code !== 0 || !json.data) {
    throw new Error('腾讯分时不可用');
  }

  const block = json.data[sym];
  if (!block?.data?.data || block.data.data.length === 0) {
    throw new Error('腾讯分时数据为空');
  }

  const qtArr = block.qt?.[sym];
  let preClose = 0;
  let name = '—';
  if (qtArr && qtArr.length > 4) {
    name = String(qtArr[1] ?? '—');
    preClose = Number(qtArr[4]);
    if (!Number.isFinite(preClose)) {
      preClose = 0;
    }
  }

  const points: { timeLabel: string; price: number; avgPrice?: number; volume?: number; amountYuan?: number }[] = [];
  for (const line of block.data.data) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) {
      continue;
    }
    const hm = parts[0] ?? '';
    const price = Number(parts[1]);
    if (!/^\d{4}$/.test(hm) || !Number.isFinite(price)) {
      continue;
    }
    const timeLabel = `${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
    points.push({ timeLabel, price });
  }

  if (points.length === 0) {
    throw new Error('腾讯分时解析为空');
  }

  if (preClose === 0 && points.length > 0) {
    preClose = points[0]!.price;
  }

  return { name, preClose, points };
}
