import * as vscode from 'vscode';
import type { NormalizedCode } from '../stockCode';
import { mapLimit } from '../providers/eastmoney';
import { fetchDividendEventsEastmoney } from '../providers/dividendEastmoney';
import { DividendStore } from '../storage/dividendStore';
import { WatchlistStore } from '../storage/watchlistStore';
import type {
  DividendCacheEntry,
  DividendEvent,
  DividendRow,
  DividendYearAttribution,
  DividendYearlySummary,
} from '../types';

const ONE_HOUR_MS = 60 * 60 * 1000;

interface DividendConfig {
  refreshIntervalHours: number;
  yearAttribution: DividendYearAttribution;
  showAfterTax: boolean;
  taxRate: number;
}

function readConfig(): DividendConfig {
  const cfg = vscode.workspace.getConfiguration('traderx');
  const hours = cfg.get<number>('dividend.refreshIntervalHours');
  const refreshIntervalHours =
    typeof hours === 'number' && Number.isFinite(hours) ? Math.min(168, Math.max(1, hours)) : 12;

  const ya = cfg.get<string>('dividend.yearAttribution');
  const yearAttribution: DividendYearAttribution =
    ya === 'recordYear' || ya === 'announceYear' ? ya : 'payYear';

  const showAfterTax = cfg.get<boolean>('dividend.showAfterTax') === true;

  const tax = cfg.get<number>('dividend.taxRate');
  const taxRate =
    typeof tax === 'number' && Number.isFinite(tax) && tax >= 0 && tax < 1 ? tax : 0.1;

  return { refreshIntervalHours, yearAttribution, showAfterTax, taxRate };
}

/** 取一个事件的归属年份，缺失时按 pay -> ex -> record -> announce 顺序降级 */
function pickYear(
  ev: DividendEvent,
  attribution: DividendYearAttribution,
): { year: number | null; fallback: boolean } {
  const tryParse = (d: string | undefined): number | null => {
    if (!d) return null;
    const m = /^(\d{4})/.exec(d);
    return m ? Number(m[1]) : null;
  };
  let primary: string | undefined;
  switch (attribution) {
    case 'payYear':
      primary = ev.payDate;
      break;
    case 'recordYear':
      primary = ev.recordDate;
      break;
    case 'announceYear':
      primary = ev.announceDate;
      break;
  }
  const py = tryParse(primary);
  if (py !== null) {
    return { year: py, fallback: false };
  }
  // 降级顺序：尽量贴近“资金到账时间”
  const order: Array<string | undefined> = [ev.payDate, ev.exDate, ev.recordDate, ev.announceDate];
  for (const d of order) {
    const y = tryParse(d);
    if (y !== null) {
      return { year: y, fallback: true };
    }
  }
  return { year: null, fallback: true };
}

function eventCashPerShare(ev: DividendEvent): number | null {
  if (typeof ev.cashPerShare === 'number' && Number.isFinite(ev.cashPerShare)) {
    return ev.cashPerShare;
  }
  if (typeof ev.cashPer10Shares === 'number' && Number.isFinite(ev.cashPer10Shares)) {
    return ev.cashPer10Shares / 10;
  }
  return null;
}

/** 仅汇总“已实施”事件 */
export function summarizeYearly(
  events: DividendEvent[],
  attribution: DividendYearAttribution,
): DividendYearlySummary[] {
  const map = new Map<number, DividendYearlySummary>();
  for (const ev of events) {
    if (ev.status !== 'implemented') {
      continue;
    }
    const cps = eventCashPerShare(ev);
    if (cps === null) {
      continue;
    }
    const { year, fallback } = pickYear(ev, attribution);
    if (year === null) {
      continue;
    }
    const cur = map.get(year);
    if (cur) {
      cur.cashPerShare += cps;
      cur.count += 1;
      if (fallback) cur.fallback = true;
    } else {
      map.set(year, { year, cashPerShare: cps, count: 1, fallback });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.year - a.year);
}

function sumLastNYears(yearly: DividendYearlySummary[], n: number, refYear: number): number | null {
  if (yearly.length === 0) {
    return null;
  }
  let total = 0;
  let any = false;
  for (let i = 0; i < n; i++) {
    const y = refYear - i;
    const item = yearly.find((it) => it.year === y);
    if (item) {
      total += item.cashPerShare;
      any = true;
    }
  }
  return any ? total : null;
}

function pickNextEvent(events: DividendEvent[]): {
  date: string | null;
  status: DividendEvent['status'] | null;
} {
  if (events.length === 0) {
    return { date: null, status: null };
  }
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  type Candidate = { date: string; status: DividendEvent['status'] };
  const cands: Candidate[] = [];
  for (const ev of events) {
    const d = ev.payDate ?? ev.exDate ?? ev.recordDate ?? ev.announceDate;
    if (!d) continue;
    cands.push({ date: d, status: ev.status });
  }
  if (cands.length === 0) {
    return { date: null, status: null };
  }
  // 优先未来最近；否则取过去最新
  const future = cands.filter((c) => c.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date));
  if (future.length > 0) {
    return { date: future[0]!.date, status: future[0]!.status };
  }
  const past = cands.slice().sort((a, b) => b.date.localeCompare(a.date));
  return { date: past[0]!.date, status: past[0]!.status };
}

export class DividendService {
  constructor(
    private readonly store: DividendStore,
    private readonly watchlistStore: WatchlistStore,
  ) {}

  getConfig(): DividendConfig {
    return readConfig();
  }

  /** 仅返回缓存数据，不发起网络请求；用于首屏 */
  getRowsFromCache(): DividendRow[] {
    const codes = this.store.getCodes();
    return codes.map((code) => this.buildRow(code, this.store.getCacheEntry(code)));
  }

  /**
   * 拉取/刷新所有关注代码：
   * - force=true：忽略 TTL 强制刷新
   * - 否则：超过 TTL 才请求
   */
  async refreshAll(force = false): Promise<DividendRow[]> {
    const codes = this.store.getCodes();
    if (codes.length === 0) {
      return [];
    }
    const ttlMs = this.getConfig().refreshIntervalHours * ONE_HOUR_MS;
    const now = Date.now();

    await mapLimit(codes, 4, async (code) => {
      const cached = this.store.getCacheEntry(code);
      const stale = !cached || now - (cached.fetchedAt ?? 0) > ttlMs || !!cached.error;
      if (!force && !stale) {
        return;
      }
      try {
        const { events, name } = await fetchDividendEventsEastmoney(code);
        const entry: DividendCacheEntry = {
          code,
          name: name ?? cached?.name,
          events,
          fetchedAt: Date.now(),
        };
        await this.store.setCacheEntry(code, entry);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const entry: DividendCacheEntry = {
          code,
          name: cached?.name,
          events: cached?.events ?? [],
          fetchedAt: cached?.fetchedAt ?? 0,
          error: msg,
        };
        await this.store.setCacheEntry(code, entry);
      }
    });
    await this.store.setLastRefreshAt(Date.now());
    return this.getRowsFromCache();
  }

  /** 单只刷新（用于添加新代码立即看到数据） */
  async refreshOne(code: NormalizedCode, force = true): Promise<DividendRow> {
    const cached = this.store.getCacheEntry(code);
    const ttlMs = this.getConfig().refreshIntervalHours * ONE_HOUR_MS;
    const stale = !cached || Date.now() - (cached.fetchedAt ?? 0) > ttlMs || !!cached.error;
    if (force || stale) {
      try {
        const { events, name } = await fetchDividendEventsEastmoney(code);
        await this.store.setCacheEntry(code, {
          code,
          name: name ?? cached?.name,
          events,
          fetchedAt: Date.now(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.store.setCacheEntry(code, {
          code,
          name: cached?.name,
          events: cached?.events ?? [],
          fetchedAt: cached?.fetchedAt ?? 0,
          error: msg,
        });
      }
    }
    return this.buildRow(code, this.store.getCacheEntry(code));
  }

  /** 单只详情：返回事件 + 年度汇总 + 估算细节 */
  getDetail(code: NormalizedCode): {
    code: NormalizedCode;
    name?: string;
    events: DividendEvent[];
    yearly: DividendYearlySummary[];
    estimate: {
      shares?: number;
      perShareLast1y: number | null;
      annualEstYuan: number | null;
      afterTax: boolean;
      taxRate: number;
    };
    yearAttribution: DividendYearAttribution;
    fetchedAt: number | null;
    error?: string;
  } {
    const cfg = this.getConfig();
    const entry = this.store.getCacheEntry(code);
    const events = entry?.events ?? [];
    const yearly = summarizeYearly(events, cfg.yearAttribution);
    const refYear = new Date().getFullYear();
    const last1y = sumLastNYears(yearly, 1, refYear);
    const positions = this.watchlistStore.getPositions();
    const shares = positions[code]?.shares;

    let annualEstYuan: number | null = null;
    if (last1y !== null && shares !== undefined && Number.isFinite(shares) && shares > 0) {
      const pretax = last1y * shares;
      annualEstYuan = cfg.showAfterTax ? pretax * (1 - cfg.taxRate) : pretax;
    }

    return {
      code,
      name: entry?.name,
      events: [...events].sort((a, b) => {
        const ka = a.exDate ?? a.recordDate ?? a.announceDate ?? a.payDate ?? '';
        const kb = b.exDate ?? b.recordDate ?? b.announceDate ?? b.payDate ?? '';
        return kb.localeCompare(ka);
      }),
      yearly,
      estimate: {
        shares,
        perShareLast1y: last1y,
        annualEstYuan,
        afterTax: cfg.showAfterTax,
        taxRate: cfg.taxRate,
      },
      yearAttribution: cfg.yearAttribution,
      fetchedAt: entry?.fetchedAt ?? null,
      error: entry?.error,
    };
  }

  /** 关注名单变化后清理孤儿缓存 */
  async pruneCache(): Promise<void> {
    await this.store.pruneCache(this.store.getCodes());
  }

  private buildRow(code: NormalizedCode, entry: DividendCacheEntry | undefined): DividendRow {
    const cfg = this.getConfig();
    const events = entry?.events ?? [];
    const yearly = summarizeYearly(events, cfg.yearAttribution);
    const refYear = new Date().getFullYear();
    const last1y = sumLastNYears(yearly, 1, refYear);
    const last3y = sumLastNYears(yearly, 3, refYear);
    const positions = this.watchlistStore.getPositions();
    const shares = positions[code]?.shares;

    let estAnnualYuan: number | null = null;
    if (last1y !== null && shares !== undefined && Number.isFinite(shares) && shares > 0) {
      const pretax = last1y * shares;
      estAnnualYuan = cfg.showAfterTax ? pretax * (1 - cfg.taxRate) : pretax;
    }

    const next = pickNextEvent(events);
    return {
      code,
      name: entry?.name ?? code,
      last1yCashPerShare: last1y,
      last3yCashPerShare: last3y,
      estAnnualYuan,
      estAfterTax: cfg.showAfterTax,
      nextEventDate: next.date,
      nextEventStatus: next.status,
      shares,
      updatedAt: entry?.fetchedAt ?? null,
      error: entry?.error,
    };
  }
}
