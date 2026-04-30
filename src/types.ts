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

/** 单次分红事件（已规范化） */
export interface DividendEvent {
  /** 来源原始记录 id（用于去重，缺失则由调用方生成） */
  id?: string;
  code: string;
  /** 报告期（如 2024-12-31），用于派息预案的归属，可选 */
  reportDate?: string;
  /** 公告日 */
  announceDate?: string;
  /** 股权登记日 */
  recordDate?: string;
  /** 除权除息日 */
  exDate?: string;
  /** 派息日 */
  payDate?: string;
  /** 每股现金分红（元/股，税前） */
  cashPerShare?: number;
  /** 每10股现金分红（元/10股，税前） */
  cashPer10Shares?: number;
  /** 每10股送红股 */
  bonusPer10Shares?: number;
  /** 每10股转增 */
  transferPer10Shares?: number;
  /** 实施状态 */
  status: 'implemented' | 'plan' | 'unknown';
  /** 数据来源 id（如 'eastmoney'） */
  source: string;
}

/** 年度归属口径 */
export type DividendYearAttribution = 'payYear' | 'recordYear' | 'announceYear';

/** 单年汇总 */
export interface DividendYearlySummary {
  year: number;
  /** 已实施合计：每股累计现金分红（元/股，税前） */
  cashPerShare: number;
  /** 该年内事件数 */
  count: number;
  /** 是否使用了降级口径（缺失指定字段时回退） */
  fallback: boolean;
}

/** 关注列表行（送给 UI 渲染） */
export interface DividendRow {
  code: string;
  name: string;
  /** 近 1 年合计（元/股，税前） */
  last1yCashPerShare: number | null;
  /** 近 3 年合计（元/股，税前） */
  last3yCashPerShare: number | null;
  /** 基于持仓的年度估算（取近 1 年合计 × 持仓股数；税前/税后视配置） */
  estAnnualYuan: number | null;
  /** 是否税后口径（仅当 showAfterTax 启用） */
  estAfterTax: boolean;
  /** 下一关键日期（YYYY-MM-DD，多取 ex/record/pay 中最近未来或最新） */
  nextEventDate: string | null;
  /** 下一事件状态 */
  nextEventStatus: 'implemented' | 'plan' | 'unknown' | null;
  /** 持仓股数（用于 UI 显示） */
  shares?: number;
  /** 数据更新时间（毫秒） */
  updatedAt: number | null;
  /** 行级错误（数据缺失/拉取失败） */
  error?: string;
}

/** 缓存条目：按股票 */
export interface DividendCacheEntry {
  code: string;
  name?: string;
  events: DividendEvent[];
  fetchedAt: number;
  /** 上一次拉取的错误（成功后清空） */
  error?: string;
}

export interface DividendSortState {
  key: string;
  /** 1 升序，-1 降序 */
  dir: 1 | -1;
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
