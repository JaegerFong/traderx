import { fetchText } from '../http';
import { parseJsonpObject, pickString, toNumber } from './goStockMarket/utils';

export interface NxfxbUpDownData {
  time?: string;
  day?: string;
  up?: number;
  down?: number;
  r0?: number;
  [k: string]: unknown;
}

export interface NxfxbHotThemeItem {
  CategoryName?: string;
  CZDF?: number;
  SecurityName?: string;
  SZDF?: number;
  [k: string]: unknown;
}

/**
 * 兼容 LeekFund：emdatah5 返回数组，取第 1 项
 * https://emdatah5.eastmoney.com/dc/NXFXB/GetUpDownData?type=0
 */
export async function fetchNxfxbUpDownData(): Promise<NxfxbUpDownData | null> {
  const url = 'https://emdatah5.eastmoney.com/dc/NXFXB/GetUpDownData?type=0';
  const text = await fetchText(url, { timeoutMs: 20000 });
  const json = JSON.parse(text) as unknown;
  if (!Array.isArray(json) || json.length === 0 || typeof json[0] !== 'object' || json[0] === null) {
    return null;
  }
  return json[0] as NxfxbUpDownData;
}

/**
 * 兼容 LeekFund：emdatah5 返回数组，取第 1 项的 Data 字段
 * https://emdatah5.eastmoney.com/dc/NXFXB/GetHotTheme
 */
export async function fetchNxfxbHotTheme(): Promise<NxfxbHotThemeItem[]> {
  const url = 'https://emdatah5.eastmoney.com/dc/NXFXB/GetHotTheme';
  const text = await fetchText(url, { timeoutMs: 20000 });
  const json = JSON.parse(text) as unknown;
  if (!Array.isArray(json) || json.length === 0 || typeof json[0] !== 'object' || json[0] === null) {
    return [];
  }
  const top = json[0] as { Data?: unknown };
  if (!Array.isArray(top.Data)) {
    return [];
  }
  return top.Data as NxfxbHotThemeItem[];
}

/**
 * LeekFund 的 NXFXB 这里用 push2 的 kamtbs.rtmin/get。
 * 你的网络环境可能会拦截 push2（socket hang up），因此这里先留空，由上层显示“不可用/需代理”。\n
 * 若后续抓包确认 datacenter-web 可替代，再补齐为同样的 string[] 格式。\n
 */
export async function fetchNxfxbHsgtSeries(): Promise<string[]> {
  // 目标：输出与 LeekFund 相同的 CSV 字符串数组：
  // time,沪净买,沪买入,沪卖出,深净买,深买入,深卖出,北向净买,北向买入,北向卖出
  //
  // LeekFund 默认走 push2 的 kamtbs.rtmin/get；这里优先尝试 datacenter-web 报表以规避 push2 被拦截。
  //
  // 经验报表名（可能随时间调整）：RPT_MUTUAL_MARKET_NORTH_TRADEMAIN
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
  const params = new URLSearchParams({
    callback: 'callback',
    reportName: 'RPT_MUTUAL_MARKET_NORTH_TRADEMAIN',
    columns: 'TRADE_DATE,TRADE_TIME,SH_NET_AMT,SH_BUY_AMT,SH_SELL_AMT,SZ_NET_AMT,SZ_BUY_AMT,SZ_SELL_AMT,NORTH_NET_AMT,NORTH_BUY_AMT,NORTH_SELL_AMT',
    pageNumber: '1',
    pageSize: '200',
    sortColumns: 'TRADE_DATE,TRADE_TIME',
    sortTypes: '-1,-1',
    source: 'WEB',
    client: 'WEB',
  });
  const text = await fetchText(`${url}?${params.toString()}`, {
    timeoutMs: 20000,
    headers: {
      Referer: 'https://data.eastmoney.com/hsgt/index.html',
      Origin: 'https://data.eastmoney.com',
    },
  });
  const obj = parseJsonpObject(text) as any;
  const data = obj?.result?.data;
  if (!Array.isArray(data) || data.length === 0) {
    return [];
  }

  const out: string[] = [];
  // 倒序取后再翻转为时间递增（更像分时）
  const rows = data.slice().reverse();
  for (const r of rows) {
    const timeRaw = pickString(r?.TRADE_TIME);
    const time = timeRaw.includes(':') ? timeRaw : (timeRaw.length === 6 ? `${timeRaw.slice(0, 2)}:${timeRaw.slice(2, 4)}:${timeRaw.slice(4, 6)}` : timeRaw);
    const shNet = toNumber(r?.SH_NET_AMT) ?? 0;
    const shBuy = toNumber(r?.SH_BUY_AMT) ?? 0;
    const shSell = toNumber(r?.SH_SELL_AMT) ?? 0;
    const szNet = toNumber(r?.SZ_NET_AMT) ?? 0;
    const szBuy = toNumber(r?.SZ_BUY_AMT) ?? 0;
    const szSell = toNumber(r?.SZ_SELL_AMT) ?? 0;
    const northNet = toNumber(r?.NORTH_NET_AMT) ?? (shNet + szNet);
    const northBuy = toNumber(r?.NORTH_BUY_AMT) ?? (shBuy + szBuy);
    const northSell = toNumber(r?.NORTH_SELL_AMT) ?? (shSell + szSell);
    out.push([time, shNet, shBuy, shSell, szNet, szBuy, szSell, northNet, northBuy, northSell].join(','));
  }
  return out;
}

