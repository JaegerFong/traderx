import type { NormalizedCode } from '../stockCode';
import { toEastmoneySecid } from '../stockCode';
import { fetchTrends2, type TrendsResult } from './eastmoneyTrends';
import { fetchTrendsTencent } from './tencentIntraday';

/**
 * 分时序列：优先东方财富，失败则尝试腾讯（避免单一站点 socket / 限频）。
 */
export async function fetchIntradaySeries(code: NormalizedCode): Promise<TrendsResult> {
  const secid = toEastmoneySecid(code);
  if (secid) {
    try {
      return await fetchTrends2(secid);
    } catch {
      // fall through
    }
  }
  return fetchTrendsTencent(code);
}
