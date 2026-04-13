export interface PositionInfo {
  cost?: number;
  shares?: number;
}

export interface QuoteRow {
  code: string;
  name: string;
  price: number | null;
  /** 涨跌幅 % */
  changePct: number | null;
  /** 主力净流入，单位：万元 */
  mainNetInflowWan: number | null;
  high: number | null;
  low: number | null;
  /** 成交额，单位：元 */
  amountYuan: number | null;
  prevClose: number | null;
  cost?: number;
  shares?: number;
  /** 浮动盈亏（元） */
  pnlYuan?: number | null;
  /** 浮动盈亏比例 % */
  pnlPct?: number | null;
  errors?: string[];
}

export type SortKey = 'price' | 'changePct' | 'mainNetInflowWan' | 'code' | 'name';

export interface RawQuote {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  amountYuan: number | null;
  prevClose: number | null;
}
