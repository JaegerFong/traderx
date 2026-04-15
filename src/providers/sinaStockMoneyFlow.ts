import { fetchText } from '../http';
import type { StockMoneyRankPayload, StockMoneyRankRow, StockMoneyTrendPayload, StockMoneyTrendRow } from './marketTypes';

const SINA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 Edg/117.0.2045.60';

function pickStr(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

/** 个股资金净流入榜，sort 默认 netamount */
export async function fetchSinaStockMoneyRank(sort: string, timeoutMs: number): Promise<StockMoneyRankPayload> {
  const s = sort.trim() || 'netamount';
  const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_ssggzj?page=1&num=20&sort=${encodeURIComponent(
    s,
  )}&asc=0&bankuai=&shichang=`;
  const text = await fetchText(url, {
    timeoutMs,
    headers: {
      Referer: 'https://finance.sina.com.cn',
      'User-Agent': SINA_UA,
    },
  });
  const arr = JSON.parse(text) as unknown;
  if (!Array.isArray(arr)) {
    throw new Error('个股资金榜：返回格式异常');
  }
  const rows: StockMoneyRankRow[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const x = item as Record<string, unknown>;
    rows.push({
      symbol: pickStr(x.symbol),
      name: pickStr(x.name),
      trade: pickStr(x.trade),
      changeratio: pickStr(x.changeratio),
      netamount: pickStr(x.netamount),
      turnover: pickStr(x.turnover),
      amount: pickStr(x.amount),
      inamount: pickStr(x.inamount),
      outamount: pickStr(x.outamount),
      ratioamount: pickStr(x.ratioamount),
      r0In: pickStr(x.r0_in),
      r0Out: pickStr(x.r0_out),
      r0Net: pickStr(x.r0_net),
      r0Ratio: pickStr(x.r0_ratio),
      r3In: pickStr(x.r3_in),
      r3Out: pickStr(x.r3_out),
      r3Net: pickStr(x.r3_net),
      r3Ratio: pickStr(x.r3_ratio),
    });
  }
  return { rows, sort: s, fetchedAt: Date.now() };
}

/** daima：新浪格式如 sh600519 */
export async function fetchSinaStockMoneyTrend(
  daima: string,
  days: number,
  timeoutMs: number,
): Promise<StockMoneyTrendPayload> {
  const code = daima.trim().toLowerCase();
  if (!code) {
    throw new Error('请输入股票代码');
  }
  const n = Math.max(5, Math.min(120, days));
  const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=${n}&sort=opendate&asc=0&daima=${encodeURIComponent(
    code,
  )}`;
  const text = await fetchText(url, {
    timeoutMs,
    headers: {
      Referer: 'https://finance.sina.com.cn',
      'User-Agent': SINA_UA,
    },
  });
  const arr = JSON.parse(text) as unknown;
  if (!Array.isArray(arr)) {
    throw new Error('资金流向按日：返回格式异常');
  }
  const rows: StockMoneyTrendRow[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const x = item as Record<string, unknown>;
    rows.push({
      opendate: pickStr(x.opendate),
      trade: pickStr(x.trade),
      changeratio: pickStr(x.changeratio),
      netamount: pickStr(x.netamount),
      ratioamount: pickStr(x.ratioamount),
      r0Net: pickStr(x.r0_net),
    });
  }
  return { code, rows, fetchedAt: Date.now() };
}
