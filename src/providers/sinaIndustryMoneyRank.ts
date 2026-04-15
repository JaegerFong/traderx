import { fetchText } from '../http';
import type { IndustryMoneyRankPayload, IndustryMoneyRow } from './marketTypes';

const SINA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 Edg/117.0.2045.60';

function pickStr(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

/** fenlei：0 行业 1 概念 2 证监会 */
export async function fetchIndustryMoneyRankSina(
  fenlei: string,
  sort: string,
  timeoutMs: number,
): Promise<IndustryMoneyRankPayload> {
  const f = fenlei.trim() || '0';
  const s = sort.trim() || 'netamount';
  const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk?page=1&num=30&sort=${encodeURIComponent(
    s,
  )}&asc=0&fenlei=${encodeURIComponent(f)}`;
  const text = await fetchText(url, {
    timeoutMs,
    headers: {
      Referer: 'https://finance.sina.com.cn',
      'User-Agent': SINA_UA,
    },
  });
  const arr = JSON.parse(text) as unknown;
  if (!Array.isArray(arr)) {
    throw new Error('行业资金排名：返回格式异常');
  }
  const rows: IndustryMoneyRow[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const x = item as Record<string, unknown>;
    rows.push({
      name: pickStr(x.name),
      avgChangeratio: pickStr(x.avg_changeratio),
      inamount: pickStr(x.inamount),
      outamount: pickStr(x.outamount),
      netamount: pickStr(x.netamount),
      ratioamount: pickStr(x.ratioamount),
      tsSymbol: pickStr(x.ts_symbol),
      tsName: pickStr(x.ts_name),
      tsTrade: pickStr(x.ts_trade),
      tsChangeratio: pickStr(x.ts_changeratio),
      tsRatioamount: pickStr(x.ts_ratioamount),
    });
  }
  return { rows, fenlei: f, sort: s, fetchedAt: Date.now() };
}
