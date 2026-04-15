import type * as vscode from 'vscode';
import type { NormalizedCode } from '../stockCode';
import type { PositionInfo } from '../types';

const KEY_LIST_LEGACY = 'traderx.watchlist.codes';
const KEY_GROUPS = 'traderx.watchlist.groups';
const KEY_ACTIVE = 'traderx.watchlist.activeGroupId';
const KEY_POS = 'traderx.watchlist.positions';
const KEY_SORT_BY_GROUP = 'traderx.watchlist.sortByGroup';

export const DEFAULT_GROUP_ID = 'default';

/** 分组内表格排序（列 key + 方向） */
export interface GroupSortState {
  key: string;
  /** 1 升序，-1 降序 */
  dir: number;
}

const DEFAULT_SORT: GroupSortState = { key: 'name', dir: 1 };

/** 表头已移除的列，历史排序需回退 */
const LEGACY_SORT_KEYS = new Set(['code', 'high', 'low', 'amountYuan']);

function normalizeSortKey(key: string): string {
  return LEGACY_SORT_KEYS.has(key) ? 'name' : key;
}

export interface WatchlistGroup {
  id: string;
  name: string;
  codes: NormalizedCode[];
}

function newGroupId(): string {
  return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeCodes(codes: NormalizedCode[]): NormalizedCode[] {
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

export class WatchlistStore {
  private readonly readyPromise: Promise<void>;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.readyPromise = this.migrateFromLegacy();
  }

  /** 须在扩展激活时 await，确保完成从旧版扁平列表的迁移 */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private async migrateFromLegacy(): Promise<void> {
    const hasGroups = this.ctx.globalState.get<WatchlistGroup[] | undefined>(KEY_GROUPS);
    if (hasGroups && hasGroups.length > 0) {
      return;
    }
    const legacy = this.ctx.globalState.get<NormalizedCode[] | undefined>(KEY_LIST_LEGACY) ?? [];
    const groups: WatchlistGroup[] = [{ id: DEFAULT_GROUP_ID, name: '自选', codes: dedupeCodes(legacy) }];
    await this.ctx.globalState.update(KEY_GROUPS, groups);
    await this.ctx.globalState.update(KEY_ACTIVE, DEFAULT_GROUP_ID);
    await this.ctx.globalState.update(KEY_LIST_LEGACY, undefined);
  }

  getGroups(): WatchlistGroup[] {
    const g = this.ctx.globalState.get<WatchlistGroup[]>(KEY_GROUPS, []);
    return g.map((x) => ({ ...x, codes: [...x.codes] }));
  }

  private async setGroups(groups: WatchlistGroup[]): Promise<void> {
    await this.readyPromise;
    await this.ctx.globalState.update(KEY_GROUPS, groups);
  }

  getActiveGroupId(): string {
    const id = this.ctx.globalState.get<string | undefined>(KEY_ACTIVE);
    const groups = this.getGroups();
    if (id && groups.some((g) => g.id === id)) {
      return id;
    }
    return groups[0]?.id ?? DEFAULT_GROUP_ID;
  }

  async setActiveGroupId(id: string): Promise<void> {
    await this.readyPromise;
    if (!this.getGroups().some((g) => g.id === id)) {
      return;
    }
    await this.ctx.globalState.update(KEY_ACTIVE, id);
  }

  getGroupById(id: string): WatchlistGroup | undefined {
    return this.getGroups().find((g) => g.id === id);
  }

  getCodesForActiveGroup(): NormalizedCode[] {
    const g = this.getGroupById(this.getActiveGroupId());
    return g ? [...g.codes] : [];
  }

  hasCodeInAnyGroup(code: NormalizedCode): boolean {
    return this.getGroups().some((g) => g.codes.includes(code));
  }

  async createGroup(name: string): Promise<string> {
    await this.readyPromise;
    const trimmed = name.trim();
    const finalName = trimmed.length > 0 ? trimmed : '新分组';
    const id = newGroupId();
    const groups = this.getGroups();
    groups.push({ id, name: finalName, codes: [] });
    await this.ctx.globalState.update(KEY_GROUPS, groups);
    await this.setActiveGroupId(id);
    return id;
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    await this.readyPromise;
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const groups = this.getGroups();
    const g = groups.find((x) => x.id === groupId);
    if (!g) {
      return;
    }
    g.name = trimmed;
    await this.ctx.globalState.update(KEY_GROUPS, groups);
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.readyPromise;
    if (groupId === DEFAULT_GROUP_ID) {
      throw new Error('不能删除默认分组「自选」');
    }
    const groups = this.getGroups();
    const idx = groups.findIndex((g) => g.id === groupId);
    if (idx < 0) {
      return;
    }
    const victim = groups[idx]!;
    const def = groups.find((g) => g.id === DEFAULT_GROUP_ID);
    if (def) {
      def.codes = dedupeCodes([...def.codes, ...victim.codes]);
    }
    groups.splice(idx, 1);
    await this.ctx.globalState.update(KEY_GROUPS, groups);
    const active = this.getActiveGroupId();
    if (active === groupId) {
      await this.setActiveGroupId(DEFAULT_GROUP_ID);
    }
  }

  async addCodeToGroup(groupId: string, code: NormalizedCode): Promise<void> {
    await this.readyPromise;
    const groups = this.getGroups();
    const g = groups.find((x) => x.id === groupId);
    if (!g) {
      return;
    }
    if (g.codes.includes(code)) {
      return;
    }
    g.codes.push(code);
    await this.ctx.globalState.update(KEY_GROUPS, groups);
  }

  async removeCodeFromGroup(groupId: string, code: NormalizedCode): Promise<void> {
    await this.readyPromise;
    const groups = this.getGroups();
    const g = groups.find((x) => x.id === groupId);
    if (!g) {
      return;
    }
    g.codes = g.codes.filter((c) => c !== code);
    await this.ctx.globalState.update(KEY_GROUPS, groups);
  }

  async copyCodeToGroup(fromGroupId: string, toGroupId: string, code: NormalizedCode): Promise<'ok' | 'exists' | 'noop'> {
    await this.readyPromise;
    if (fromGroupId === toGroupId) {
      return 'noop';
    }
    const groups = this.getGroups();
    const from = groups.find((x) => x.id === fromGroupId);
    const to = groups.find((x) => x.id === toGroupId);
    if (!from || !to) {
      return 'noop';
    }
    if (!from.codes.includes(code)) {
      return 'noop';
    }
    if (to.codes.includes(code)) {
      return 'exists';
    }
    to.codes.push(code);
    await this.ctx.globalState.update(KEY_GROUPS, groups);
    return 'ok';
  }

  async moveCodeToGroup(fromGroupId: string, toGroupId: string, code: NormalizedCode): Promise<'ok' | 'exists' | 'noop'> {
    await this.readyPromise;
    if (fromGroupId === toGroupId) {
      return 'noop';
    }
    const groups = this.getGroups();
    const from = groups.find((x) => x.id === fromGroupId);
    const to = groups.find((x) => x.id === toGroupId);
    if (!from || !to) {
      return 'noop';
    }
    if (!from.codes.includes(code)) {
      return 'noop';
    }
    if (to.codes.includes(code)) {
      from.codes = from.codes.filter((c) => c !== code);
      await this.ctx.globalState.update(KEY_GROUPS, groups);
      return 'exists';
    }
    from.codes = from.codes.filter((c) => c !== code);
    to.codes.push(code);
    await this.ctx.globalState.update(KEY_GROUPS, groups);
    return 'ok';
  }

  getPositions(): Record<string, PositionInfo> {
    return { ...(this.ctx.globalState.get<Record<string, PositionInfo>>(KEY_POS, {})) };
  }

  async setPositions(p: Record<string, PositionInfo>): Promise<void> {
    await this.readyPromise;
    await this.ctx.globalState.update(KEY_POS, p);
  }

  async setPosition(code: NormalizedCode, info: PositionInfo): Promise<void> {
    await this.readyPromise;
    const cur = this.getPositions();
    if (info.cost === undefined && info.shares === undefined) {
      delete cur[code];
    } else {
      cur[code] = { cost: info.cost, shares: info.shares };
    }
    await this.ctx.globalState.update(KEY_POS, cur);
  }

  getSortForGroup(groupId: string): GroupSortState {
    const all = this.ctx.globalState.get<Record<string, GroupSortState>>(KEY_SORT_BY_GROUP, {});
    const s = all[groupId];
    if (s && typeof s.key === 'string' && (s.dir === 1 || s.dir === -1)) {
      return { key: normalizeSortKey(s.key), dir: s.dir };
    }
    return { ...DEFAULT_SORT };
  }

  async setSortForGroup(groupId: string, state: GroupSortState): Promise<void> {
    await this.readyPromise;
    const all = { ...this.ctx.globalState.get<Record<string, GroupSortState>>(KEY_SORT_BY_GROUP, {}) };
    all[groupId] = { key: state.key, dir: state.dir };
    await this.ctx.globalState.update(KEY_SORT_BY_GROUP, all);
  }
}
