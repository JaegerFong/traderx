import type * as vscode from 'vscode';
import type { NormalizedCode } from '../stockCode';
import type { DividendCacheEntry, DividendSortState } from '../types';

const KEY_CODES = 'traderx.dividend.codes';
const KEY_SORT = 'traderx.dividend.sort';
const KEY_LAST_REFRESH = 'traderx.dividend.lastRefreshAt';
const KEY_CACHE = 'traderx.dividend.cache';

const DEFAULT_SORT: DividendSortState = { key: 'name', dir: 1 };

const ALLOWED_SORT_KEYS = new Set([
  'code',
  'name',
  'last1y',
  'last3y',
  'estAnnual',
  'nextEventDate',
  'status',
]);

function dedupe(codes: NormalizedCode[]): NormalizedCode[] {
  const seen = new Set<NormalizedCode>();
  const out: NormalizedCode[] = [];
  for (const c of codes) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/** 股息关注名单与缓存（独立于自选 Watchlist） */
export class DividendStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  getCodes(): NormalizedCode[] {
    return [...this.ctx.globalState.get<NormalizedCode[]>(KEY_CODES, [])];
  }

  has(code: NormalizedCode): boolean {
    return this.getCodes().includes(code);
  }

  async addCode(code: NormalizedCode): Promise<'ok' | 'exists'> {
    const list = this.getCodes();
    if (list.includes(code)) {
      return 'exists';
    }
    list.push(code);
    await this.ctx.globalState.update(KEY_CODES, dedupe(list));
    return 'ok';
  }

  async removeCode(code: NormalizedCode): Promise<void> {
    const list = this.getCodes().filter((c) => c !== code);
    await this.ctx.globalState.update(KEY_CODES, list);
  }

  getSort(): DividendSortState {
    const raw = this.ctx.globalState.get<DividendSortState | undefined>(KEY_SORT);
    if (raw && typeof raw.key === 'string' && (raw.dir === 1 || raw.dir === -1)) {
      const key = ALLOWED_SORT_KEYS.has(raw.key) ? raw.key : DEFAULT_SORT.key;
      return { key, dir: raw.dir };
    }
    return { ...DEFAULT_SORT };
  }

  async setSort(state: DividendSortState): Promise<void> {
    const key = ALLOWED_SORT_KEYS.has(state.key) ? state.key : DEFAULT_SORT.key;
    const dir = state.dir === -1 ? -1 : 1;
    await this.ctx.globalState.update(KEY_SORT, { key, dir });
  }

  getLastRefreshAt(): number {
    return this.ctx.globalState.get<number>(KEY_LAST_REFRESH, 0);
  }

  async setLastRefreshAt(when: number): Promise<void> {
    await this.ctx.globalState.update(KEY_LAST_REFRESH, when);
  }

  getCache(): Record<string, DividendCacheEntry> {
    return { ...this.ctx.globalState.get<Record<string, DividendCacheEntry>>(KEY_CACHE, {}) };
  }

  getCacheEntry(code: NormalizedCode): DividendCacheEntry | undefined {
    const all = this.ctx.globalState.get<Record<string, DividendCacheEntry>>(KEY_CACHE, {});
    return all[code];
  }

  async setCacheEntry(code: NormalizedCode, entry: DividendCacheEntry): Promise<void> {
    const all = { ...this.ctx.globalState.get<Record<string, DividendCacheEntry>>(KEY_CACHE, {}) };
    all[code] = entry;
    await this.ctx.globalState.update(KEY_CACHE, all);
  }

  /** 仅保留当前关注名单中的缓存；用于关注名单变化后清理过期数据 */
  async pruneCache(activeCodes: readonly NormalizedCode[]): Promise<void> {
    const keep = new Set(activeCodes);
    const all = { ...this.ctx.globalState.get<Record<string, DividendCacheEntry>>(KEY_CACHE, {}) };
    let changed = false;
    for (const code of Object.keys(all)) {
      if (!keep.has(code as NormalizedCode)) {
        delete all[code];
        changed = true;
      }
    }
    if (changed) {
      await this.ctx.globalState.update(KEY_CACHE, all);
    }
  }
}
