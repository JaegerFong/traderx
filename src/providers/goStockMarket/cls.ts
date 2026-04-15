import { fetchText } from '../../http';
import { formatHhMmSsFromUnixSeconds, pickString, toInt, toNumber } from './utils';

export interface ClsIndexQuote {
  secuCode: string;
  secuName: string;
  lastPx: number;
  change: number;
  changePx: number;
  upNum: number;
  downNum: number;
  flatNum: number;
}

export interface ClsUpDownDis {
  upNum: number;
  downNum: number;
  averageRise: number;
  riseNum: number;
  fallNum: number;
  down10: number;
  down8: number;
  down6: number;
  down4: number;
  down2: number;
  flatNum: number;
  up2: number;
  up4: number;
  up6: number;
  up8: number;
  up10: number;
  suspendNum: number;
  status: boolean;
}

export interface ClsPurchaseToday {
  secuCode: string;
  secuName: string;
  ipoPrice: number;
  ipoPe: number;
  allotMax: number;
  lotRate: number | null;
}

export interface ClsMarketHome {
  indexQuote: ClsIndexQuote[];
  upDownDis: ClsUpDownDis | null;
  purchaseToday: ClsPurchaseToday[];
  fetchedAt: number;
}

export async function fetchClsMarketHome(timeoutMs = 15000): Promise<ClsMarketHome> {
  const url = 'https://x-quote.cls.cn/quote/index/home?app=CailianpressWeb&os=web&sv=8.4.6';
  const text = await fetchText(url, {
    timeoutMs,
    headers: {
      Referer: 'https://www.cls.cn/',
      Origin: 'https://www.cls.cn',
    },
  });
  const json = JSON.parse(text) as { code?: number; msg?: string; data?: any };
  if (json.code !== 200 || !json.data) {
    throw new Error(`CLS市场数据异常：${json.msg ?? 'unknown'}`);
  }

  const data = json.data as any;
  const indexQuote: ClsIndexQuote[] = Array.isArray(data.index_quote)
    ? data.index_quote
        .map((x: any) => ({
          secuCode: pickString(x.secu_code),
          secuName: pickString(x.secu_name),
          lastPx: toNumber(x.last_px) ?? 0,
          change: toNumber(x.change) ?? 0,
          changePx: toNumber(x.change_px) ?? 0,
          upNum: toInt(x.up_num) ?? 0,
          downNum: toInt(x.down_num) ?? 0,
          flatNum: toInt(x.flat_num) ?? 0,
        }))
        .filter((x: ClsIndexQuote) => x.secuCode || x.secuName)
    : [];

  const upDownDis: ClsUpDownDis | null = data.up_down_dis
    ? {
        upNum: toInt(data.up_down_dis.up_num) ?? 0,
        downNum: toInt(data.up_down_dis.down_num) ?? 0,
        averageRise: toNumber(data.up_down_dis.average_rise) ?? 0,
        riseNum: toInt(data.up_down_dis.rise_num) ?? 0,
        fallNum: toInt(data.up_down_dis.fall_num) ?? 0,
        down10: toInt(data.up_down_dis.down_10) ?? 0,
        down8: toInt(data.up_down_dis.down_8) ?? 0,
        down6: toInt(data.up_down_dis.down_6) ?? 0,
        down4: toInt(data.up_down_dis.down_4) ?? 0,
        down2: toInt(data.up_down_dis.down_2) ?? 0,
        flatNum: toInt(data.up_down_dis.flat_num) ?? 0,
        up2: toInt(data.up_down_dis.up_2) ?? 0,
        up4: toInt(data.up_down_dis.up_4) ?? 0,
        up6: toInt(data.up_down_dis.up_6) ?? 0,
        up8: toInt(data.up_down_dis.up_8) ?? 0,
        up10: toInt(data.up_down_dis.up_10) ?? 0,
        suspendNum: toInt(data.up_down_dis.suspend_num) ?? 0,
        status: Boolean(data.up_down_dis.status),
      }
    : null;

  const purchaseToday: ClsPurchaseToday[] = Array.isArray(data.purchase_today)
    ? data.purchase_today.map((x: any) => ({
        secuCode: pickString(x.secu_code),
        secuName: pickString(x.secu_name),
        ipoPrice: toNumber(x.ipo_price) ?? 0,
        ipoPe: toNumber(x.ipo_pe) ?? 0,
        allotMax: toInt(x.allot_max) ?? 0,
        lotRate: toNumber(x.lot_rate),
      }))
    : [];

  return { indexQuote, upDownDis, purchaseToday, fetchedAt: Date.now() };
}

export interface ClsTelegraphItem {
  title: string;
  content: string;
  time: string;
  dataTime: number;
  url: string;
  isRed: boolean;
  source: '财联社电报';
}

/** 财联社电报：nodeapi/telegraphList，最多取前 limit 条 */
export async function fetchClsTelegraphList(limit = 50, timeoutMs = 15000): Promise<ClsTelegraphItem[]> {
  const url = 'https://www.cls.cn/nodeapi/telegraphList';
  const text = await fetchText(url, {
    timeoutMs,
    headers: { Referer: 'https://www.cls.cn/' },
  });
  const json = JSON.parse(text) as any;
  if (!json || Number(json.error) !== 0 || !json.data || !Array.isArray(json.data.roll_data)) {
    return [];
  }
  const roll = json.data.roll_data as any[];
  const out: ClsTelegraphItem[] = [];
  for (let i = 0; i < roll.length && out.length < limit; i++) {
    const n = roll[i];
    const ctime = toInt(n?.ctime);
    if (!ctime) continue;
    out.push({
      title: pickString(n?.title),
      content: pickString(n?.content),
      time: formatHhMmSsFromUnixSeconds(ctime),
      dataTime: ctime * 1000,
      url: pickString(n?.shareurl),
      isRed: pickString(n?.level) !== 'C',
      source: '财联社电报',
    });
  }
  return out;
}

