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
  /** 竞买价（集合竞价参考），无则 null */
  bidPrice: number | null;
  /** 竞卖价（集合竞价参考），无则 null */
  askPrice: number | null;
  prevClose: number | null;
  cost?: number;
  shares?: number;
  /** 浮动盈亏（元） */
  pnlYuan?: number | null;
  /** 浮动盈亏比例 % */
  pnlPct?: number | null;
  errors?: string[];
}

export type SortKey =
  | 'name'
  | 'price'
  | 'changePct'
  | 'mainNetInflowWan'
  | 'cost'
  | 'shares'
  | 'pnlYuan'
  | 'pnlPct';

export interface RawQuote {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  amountYuan: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  prevClose: number | null;
}

export interface MarketOverview {
  /** 上涨家数 */
  upCount: number | null;
  /** 下跌家数 */
  downCount: number | null;
  /** 平盘家数 */
  flatCount: number | null;
  /** 全市场成交额（元） */
  turnoverYuan: number | null;
}

export type IndexId = 'sh000001' | 'sz399001' | 'sz399006' | 'sh000688';

export interface IndexQuote {
  id: IndexId;
  name: string;
  price: number | null;
  changePct: number | null;
  /** 成交额（元），若接口无则为 null */
  amountYuan: number | null;
}

/** 通用榜单行（概念/板块/股票Top） */
export interface RankRow {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  /** 成交额（元） */
  amountYuan: number | null;
}

/** 涨停/跌停榜单行 */
export interface LimitRow extends RankRow {
  /** 涨停/跌停时间（例如 HH:MM:SS 或 HH:MM） */
  limitTime: string | null;
}

export interface ConceptItem {
  code: string;
  name: string;
}

export type MarketListKind =
  | 'topConcepts'
  | 'topIndustries'
  | 'limitUp'
  | 'limitDown'
  | 'conceptTopStocks';

export interface MarketState {
  overview: MarketOverview | null;
  indices: IndexQuote[];
  lists: Partial<Record<MarketListKind, { rows: Array<RankRow | LimitRow>; loading: boolean; error?: string }>>;
  conceptQuery?: string;
  conceptPicked?: ConceptItem | null;
  conceptSuggest?: { items: ConceptItem[]; loading: boolean; error?: string };
}
