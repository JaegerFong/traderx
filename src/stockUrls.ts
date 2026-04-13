import type { NormalizedCode } from './stockCode';

/**
 * 行情页站点（仅东方财富两种，与韭菜盒子 LeekFund 同源域名 `quote.eastmoney.com`）。
 * - `eastmoney_full`：PC 完整个股页
 * - `eastmoney_discreet`：`basic/h5chart-iframe.html` 分时页（LeekFund 沪深股票在 K 线开关下使用）
 */
export type IntradayPageProvider = 'eastmoney_full' | 'eastmoney_discreet';

function normalizeProvider(raw: string): IntradayPageProvider {
  if (raw === 'eastmoney_discreet') {
    return 'eastmoney_discreet';
  }
  return 'eastmoney_full';
}

/** LeekFund：沪深 `market` 沪 1 / 深 0，`code` 为 6 位数字 */
export function getEastmoneyH5IntradayUrl(code: NormalizedCode): string {
  const m = /^(sh|sz|bj)(\d{6})$/.exec(code);
  if (!m) {
    return 'https://quote.eastmoney.com/';
  }
  const [, mk, num] = m;
  const market = mk === 'sh' ? '1' : '0';
  return `https://quote.eastmoney.com/basic/h5chart-iframe.html?code=${num}&market=${market}`;
}

/**
 * 生成分时/个股浏览 URL。
 */
export function getIntradayQuoteUrl(code: NormalizedCode, provider: string): string {
  const p = normalizeProvider(provider);
  const m = /^(sh|sz|bj)(\d{6})$/.exec(code);
  if (!m) {
    return 'https://www.eastmoney.com/';
  }
  const [, market, num] = m;

  if (p === 'eastmoney_discreet') {
    return getEastmoneyH5IntradayUrl(code);
  }
  return `https://quote.eastmoney.com/${market}${num}.html`;
}
