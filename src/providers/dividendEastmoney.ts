import type { NormalizedCode } from '../stockCode';
import { fetchText } from '../http';
import type { DividendEvent } from '../types';

const SOURCE_ID = 'eastmoney';

/** 把 sh600519 / sz000001 / bj920118 转换为东财 datacenter 接口的数字代码 */
function toRawCode(code: NormalizedCode): string | null {
  const m = /^(sh|sz|bj)(\d{6})$/.exec(code);
  return m ? m[2]! : null;
}

/** 东财 datacenter 接口在不同时间会返回不同字段名，统一做兜底 */
function pickFirst(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (k in obj && obj[k] !== null && obj[k] !== '' && obj[k] !== undefined) {
      return obj[k];
    }
  }
  return undefined;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 把 "2024-12-31 00:00:00" / "20241231" 等格式归一为 YYYY-MM-DD；非法则返回 undefined */
function normDate(v: unknown): string | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  const s = String(v).trim();
  if (!s) {
    return undefined;
  }
  const m1 = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(s);
  if (m1) {
    return `${m1[1]}-${m1[2]}-${m1[3]}`;
  }
  const m2 = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m2) {
    return `${m2[1]}-${m2[2]}-${m2[3]}`;
  }
  return undefined;
}

/**
 * 把进度文本映射到状态：
 * - "实施" / "实施完成" -> implemented
 * - "预案" / "董事会预案" / "股东大会通过" -> plan
 * - "不分配" / "取消实施" -> unknown（不参与汇总）
 */
function normStatus(raw: unknown): DividendEvent['status'] {
  const s = String(raw ?? '').trim();
  if (!s) {
    return 'unknown';
  }
  if (s.includes('不分') || s.includes('不分配') || s.includes('取消')) {
    return 'unknown';
  }
  if (s.includes('实施')) {
    return 'implemented';
  }
  if (s.includes('预案') || s.includes('股东大会') || s.includes('通过')) {
    return 'plan';
  }
  return 'unknown';
}

/** 字段同义词集合（兼容东财不同接口字段命名） */
const KEYS_NOTICE = ['NOTICE_DATE', 'NoticeDate', 'PUBLISH_DATE'] as const;
const KEYS_REPORT = ['REPORT_DATE', 'ReportDate'] as const;
const KEYS_EX = ['EX_DIVIDEND_DATE', 'EX_DIVIDEND_DAY', 'ExDividendDate', 'EXDIV_DATE'] as const;
const KEYS_RECORD = ['EQUITY_RECORD_DATE', 'EQUITY_RECORD_DAY', 'RecordDate', 'REGISTER_DATE'] as const;
const KEYS_PAY = ['PAY_CASH_DATE', 'PAYABLE_DATE', 'PAY_DATE', 'PayCashDate'] as const;
const KEYS_PER10_PRETAX = [
  'PRETAX_BONUS_RMB',
  'PRE_TAX_BONUS_RMB',
  'PRETAX_PAY_CASH_RMB',
  'PRETAX_DIV_RMB',
  'PreTaxBonusRMB',
] as const;
const KEYS_PER10_AFTERTAX = ['PNETBONUS_RMB', 'AFTER_TAX_BONUS_RMB', 'AFTER_TAX_PAY_CASH_RMB'] as const;
const KEYS_BONUS_PER10 = ['BONUS_IT_RATIO_RMB', 'BONUS_RATIO_RMB', 'BONUS_IT_RMB'] as const;
const KEYS_TRANSFER_PER10 = ['PCT_CHANGE_RATIO_RMB', 'TRANSFER_RATIO_RMB', 'PCT_CHANGE_RMB'] as const;
const KEYS_STATUS = ['ASSIGN_PROGRESS', 'PROGRESS', 'PLAN_NOTE', 'IMPL_PLAN_PROFILE'] as const;

/**
 * 解析东财 datacenter v1 接口的一行
 */
function mapRow(code: string, row: Record<string, unknown>): DividendEvent {
  const announceDate = normDate(pickFirst(row, KEYS_NOTICE));
  const reportDate = normDate(pickFirst(row, KEYS_REPORT));
  const exDate = normDate(pickFirst(row, KEYS_EX));
  const recordDate = normDate(pickFirst(row, KEYS_RECORD));
  const payDate = normDate(pickFirst(row, KEYS_PAY));

  const per10Pretax = num(pickFirst(row, KEYS_PER10_PRETAX));
  const bonusPer10 = num(pickFirst(row, KEYS_BONUS_PER10));
  const transferPer10 = num(pickFirst(row, KEYS_TRANSFER_PER10));
  const status = normStatus(pickFirst(row, KEYS_STATUS));

  const ev: DividendEvent = {
    code,
    status,
    source: SOURCE_ID,
  };
  if (reportDate) ev.reportDate = reportDate;
  if (announceDate) ev.announceDate = announceDate;
  if (recordDate) ev.recordDate = recordDate;
  if (exDate) ev.exDate = exDate;
  if (payDate) ev.payDate = payDate;
  if (per10Pretax !== null) {
    ev.cashPer10Shares = per10Pretax;
    ev.cashPerShare = per10Pretax / 10;
  }
  if (bonusPer10 !== null && bonusPer10 > 0) ev.bonusPer10Shares = bonusPer10;
  if (transferPer10 !== null && transferPer10 > 0) ev.transferPer10Shares = transferPer10;

  // 行级 id：用日期 + 报告期组合，便于跨刷新去重
  const idParts = [reportDate ?? '', announceDate ?? '', exDate ?? ''].filter(Boolean);
  if (idParts.length > 0) {
    ev.id = idParts.join('|');
  }
  return ev;
}

/** 提供给 service 层使用：按规范化代码拉取分红明细 */
export async function fetchDividendEventsEastmoney(code: NormalizedCode): Promise<{
  events: DividendEvent[];
  name?: string;
}> {
  const raw = toRawCode(code);
  if (!raw) {
    throw new Error('代码格式不支持东方财富分红查询');
  }

  // datacenter-web 通用查询：分红送配明细
  const qs = new URLSearchParams({
    reportName: 'RPT_SHAREBONUS_DET',
    columns: 'ALL',
    filter: `(SECURITY_CODE="${raw}")`,
    pageNumber: '1',
    pageSize: '100',
    sortColumns: 'NOTICE_DATE',
    sortTypes: '-1',
  });
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${qs.toString()}`;

  const text = await fetchText(url, {
    headers: {
      Referer: 'https://data.eastmoney.com/',
      Accept: 'application/json,text/plain,*/*',
    },
    timeoutMs: 20_000,
  });

  let json: { result?: { data?: unknown[] } | null; success?: boolean };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error('东方财富返回内容不是合法 JSON');
  }

  const rows = Array.isArray(json.result?.data) ? json.result!.data! : [];
  if (rows.length === 0) {
    return { events: [] };
  }

  let name: string | undefined;
  const events: DividendEvent[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') {
      continue;
    }
    const obj = r as Record<string, unknown>;
    if (!name) {
      const n = pickFirst(obj, ['SECURITY_NAME_ABBR', 'SecurityNameAbbr', 'SECURITY_NAME']);
      if (typeof n === 'string' && n.trim()) {
        name = n.trim();
      }
    }
    events.push(mapRow(code, obj));
  }
  return { events, name };
}
