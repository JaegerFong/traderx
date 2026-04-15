/** 市场行情 DTO */

export type GlobalRegionKey = 'common' | 'asia' | 'america' | 'europe' | 'other';

export interface GlobalIndexRow {
  code: string;
  qtcode: string;
  name: string;
  location: string;
  zxj: string;
  zdf: string;
  state: string;
}

export interface GlobalIndicesPayload {
  regions: { key: GlobalRegionKey; title: string; rows: GlobalIndexRow[] }[];
  fetchedAt: number;
}

export interface IndustryRankRow {
  bdName: string;
  bdCode: string;
  bdZxj: string;
  bdZdf: string;
  nzgCode: string;
  nzgName: string;
  nzgZdf: string;
  nzgZxj: string;
  bdZdf5: string;
  bdZdf20: string;
}

export interface IndustryRankPayload {
  rows: IndustryRankRow[];
  fetchedAt: number;
}

export interface IndustryMoneyRow {
  name: string;
  avgChangeratio: string;
  inamount: string;
  outamount: string;
  netamount: string;
  ratioamount: string;
  tsSymbol: string;
  tsName: string;
  tsTrade: string;
  tsChangeratio: string;
  tsRatioamount: string;
}

export interface IndustryMoneyRankPayload {
  rows: IndustryMoneyRow[];
  fenlei: string;
  sort: string;
  fetchedAt: number;
}

export interface StockMoneyRankRow {
  symbol: string;
  name: string;
  trade: string;
  changeratio: string;
  netamount: string;
  turnover: string;
  amount: string;
  inamount: string;
  outamount: string;
  ratioamount: string;
  r0In: string;
  r0Out: string;
  r0Net: string;
  r0Ratio: string;
  r3In: string;
  r3Out: string;
  r3Net: string;
  r3Ratio: string;
}

export interface StockMoneyRankPayload {
  rows: StockMoneyRankRow[];
  sort: string;
  fetchedAt: number;
}

export interface StockMoneyTrendRow {
  opendate: string;
  trade: string;
  changeratio: string;
  netamount: string;
  ratioamount: string;
  r0Net: string;
}

export interface StockMoneyTrendPayload {
  code: string;
  rows: StockMoneyTrendRow[];
  fetchedAt: number;
}
