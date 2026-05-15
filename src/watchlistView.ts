import * as vscode from 'vscode';
import { isCnAshareAutoRefreshWindow } from './marketHours';
import { QuoteService } from './services/quoteService';
import { WatchlistStore } from './storage/watchlistStore';
import type { NormalizedCode } from './stockCode';
import type { QuoteRow } from './types';
import { fetchEastmoneyMainForceOne, mapLimit } from './providers/eastmoney';
import { fetchIntradaySeries } from './providers/intradaySeries';
import { STEALTH_OFFICE_STYLE_SNIPPET } from './stealthOfficeWebview';
import { fetchIndexQuotes } from './providers/market';

interface IntradayPreviewPoint {
  timeLabel: string;
  price: number;
  avgPrice?: number;
}

interface IntradayPreviewPayload {
  code: NormalizedCode;
  name: string;
  preClose: number;
  points: IntradayPreviewPoint[];
  updatedAt: number;
}

export class WatchlistViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'traderx.watchlistView';
  /** 底部 Panel 容器中的自选（与侧栏可同时存在，便于拖到终端区停靠） */
  public static readonly viewIdPanel = 'traderx.watchlistView.panel';

  private readonly webviews = new Set<vscode.WebviewView>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private seq = 0;
  private registeredConfigListener = false;
  private rowCache = new Map<string, QuoteRow>();
  private indicesCache: { updatedAt: number; rows: Array<{ name: string; price: number | null; changePct: number | null }> } = {
    updatedAt: 0,
    rows: [],
  };
  private indicesRefreshing = false;
  private intradayCache = new Map<
    NormalizedCode,
    { updatedAt: number; data?: IntradayPreviewPayload; error?: string; inflight?: Promise<void> }
  >();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: WatchlistStore,
    private readonly quoteService: QuoteService,
  ) {}

  private postMessageAll(message: unknown): void {
    for (const wv of this.webviews) {
      void wv.webview.postMessage(message);
    }
  }

  private hasVisibleWebview(): boolean {
    for (const wv of this.webviews) {
      if (wv.visible) {
        return true;
      }
    }
    return false;
  }

  private getIndicesSnapshotSync(): {
    indices: Array<{ name: string; price: number | null; changePct: number | null }>;
    indicesUpdatedAt: number;
  } {
    return { indices: this.indicesCache.rows, indicesUpdatedAt: this.indicesCache.updatedAt };
  }

  /** 异步刷新指数并单独推送，避免阻塞自选列表首屏渲染 */
  private refreshIndicesIfStale(): void {
    const now = Date.now();
    if (this.indicesRefreshing) {
      return;
    }
    if (this.indicesCache.rows.length > 0 && now - this.indicesCache.updatedAt < 10_000) {
      return;
    }
    this.indicesRefreshing = true;
    void (async () => {
      try {
        const res = await fetchIndexQuotes();
        const rows = res.map((x) => ({ name: x.name, price: x.price, changePct: x.changePct }));
        this.indicesCache = { updatedAt: Date.now(), rows };
        const snap = this.getIndicesSnapshotSync();
        this.postMessageAll({ type: 'indices', ...snap });
      } catch {
        // ignore
      } finally {
        this.indicesRefreshing = false;
      }
    })();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviews.add(webviewView);
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.ctx.extensionUri],
    };

    const nonce = String(Math.random()).slice(2);
    webviewView.webview.html = this.buildHtml(webviewView.webview, nonce);

    webviewView.webview.onDidReceiveMessage((msg) => {
      void this.onMessage(msg as Record<string, unknown>);
    });

    webviewView.onDidDispose(() => {
      this.webviews.delete(webviewView);
      this.applyRefreshSchedule();
    });

    webviewView.onDidChangeVisibility(() => {
      this.applyRefreshSchedule();
      if (webviewView.visible) {
        void this.postRows('visible');
      }
    });

    this.applyRefreshSchedule();
    void this.postRows('init');

    if (!this.registeredConfigListener) {
      this.registeredConfigListener = true;
      this.ctx.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration('traderx')) {
            this.applyRefreshSchedule();
            // 配置变更（尤其是全局设置保存）不应阻塞在全量行情刷新上
            this.refreshUiOnly('config');
          }
        }),
      );
    }
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private applyRefreshSchedule(): void {
    this.clearRefreshTimer();
    if (this.webviews.size === 0 || !this.hasVisibleWebview()) {
      return;
    }
    const sec = vscode.workspace.getConfiguration('traderx').get<number>('refreshIntervalSeconds') ?? 3;
    const ms = Math.max(3000, Math.min(300_000, sec * 1000));
    this.refreshTimer = setInterval(() => {
      void this.postRows('timer');
    }, ms);
  }

  public dispose(): void {
    this.clearRefreshTimer();
    this.webviews.clear();
    this.rowCache.clear();
    this.indicesCache = { updatedAt: 0, rows: [] };
    this.intradayCache.clear();
  }

  public async refresh(reason = 'external'): Promise<void> {
    await this.postRows(reason);
  }

  /** 仅同步 UI 状态（不重新拉行情），用于配置保存等场景 */
  public refreshUiOnly(reason = 'ui'): void {
    this.postRowsFromCache(reason);
  }

  public async addStockIncremental(code: NormalizedCode): Promise<void> {
    await this.postPatchAddToActiveGroup(code, 'addStock');
  }

  public async removeStockIncremental(code: NormalizedCode): Promise<void> {
    await this.postPatchRemoveFromActiveGroup(code, 'removeStock');
  }

  public async editPositionIncremental(code: NormalizedCode): Promise<void> {
    await this.postPatchRefreshOne(code, 'editPosition');
  }

  private postRowsFromCache(reason: string): void {
    const codes = this.store.getCodesForActiveGroup();
    const positions = this.store.getPositions();
    const groups = this.store.getGroups().map((g) => ({ id: g.id, name: g.name, count: g.codes.length }));
    const turnoverDisplay = (vscode.workspace.getConfiguration('traderx').get<string>('turnoverDisplay') ?? 'yi') as 'wan' | 'yi';
    const stealthMode = vscode.workspace.getConfiguration('traderx').get<boolean>('intradayStealthMode') === true;
    const gid = this.store.getActiveGroupId();
    const sort = this.store.getSortForGroup(gid);

    const rows: QuoteRow[] =
      codes.length === 0
        ? []
        : codes.map((c) => {
            const cached = this.rowCache.get(c);
            if (cached) {
              const pos = positions[c];
              return { ...cached, cost: pos?.cost, shares: pos?.shares };
            }
            return this.buildSkeletonRows([c], positions)[0]!;
          });

    this.pruneRowCache(codes);

    const idx = this.getIndicesSnapshotSync();
    this.postMessageAll({
      type: 'update',
      reason,
      rows,
      turnoverDisplay,
      updatedAt: Date.now(),
      indices: idx.indices,
      indicesUpdatedAt: idx.indicesUpdatedAt,
      groups,
      activeGroupId: gid,
      quotesLoading: false,
      stealthMode,
      sortKey: sort.key,
      sortDir: sort.dir,
    });
    this.refreshIndicesIfStale();
  }

  private buildSkeletonRows(
    codes: NormalizedCode[],
    positions: Record<string, { cost?: number; shares?: number }>,
  ): QuoteRow[] {
    return codes.map((code) => {
      const pos = positions[code];
      return {
        code,
        name: '…',
        price: null,
        changePct: null,
        mainNetInflowWan: null,
        high: null,
        low: null,
        amountYuan: null,
        bidPrice: null,
        askPrice: null,
        prevClose: null,
        cost: pos?.cost,
        shares: pos?.shares,
        pnlYuan: null,
        pnlPct: null,
      };
    });
  }

  private async postRows(reason: string): Promise<void> {
    if (reason === 'timer' && !isCnAshareAutoRefreshWindow()) {
      return;
    }
    if (this.webviews.size === 0) {
      return;
    }
    if (reason === 'timer' && !this.hasVisibleWebview()) {
      return;
    }
    const my = ++this.seq;
    const codes = this.store.getCodesForActiveGroup();
    const positions = this.store.getPositions();
    const groups = this.store.getGroups().map((g) => ({ id: g.id, name: g.name, count: g.codes.length }));
    const turnoverDisplay = (vscode.workspace.getConfiguration('traderx').get<string>('turnoverDisplay') ?? 'yi') as 'wan' | 'yi';
    const stealthMode = vscode.workspace.getConfiguration('traderx').get<boolean>('intradayStealthMode') === true;

    /** 定时/配置/可见/手动刷新：不插骨架、不多次推送，减少闪烁 */
    const quietRefresh =
      reason === 'timer' || reason === 'config' || reason === 'visible' || reason === 'webview';

    const push = (payload: {
      rows: unknown[];
      error?: string;
      quotesLoading: boolean;
      reasonSuffix: string;
    }): void => {
      if (my !== this.seq) {
        return;
      }
      // 必须在 push 时重新读分组与排序：若在 await 行情期间用户点了排序，闭包里的旧 sort 会覆盖倒序
      const gid = this.store.getActiveGroupId();
      const sort = this.store.getSortForGroup(gid);
      const idx = this.getIndicesSnapshotSync();
      this.postMessageAll({
        type: 'update',
        reason: reason + payload.reasonSuffix,
        rows: payload.rows,
        turnoverDisplay,
        error: payload.error,
        updatedAt: Date.now(),
        indices: idx.indices,
        indicesUpdatedAt: idx.indicesUpdatedAt,
        groups,
        activeGroupId: gid,
        quotesLoading: payload.quotesLoading,
        stealthMode,
        sortKey: sort.key,
        sortDir: sort.dir,
      });
      this.refreshIndicesIfStale();
    };

    if (!quietRefresh && codes.length > 0) {
      push({ rows: this.buildSkeletonRows(codes, positions), quotesLoading: true, reasonSuffix: '-skeleton' });
    }

    if (codes.length === 0) {
      this.pruneRowCache([]);
      push({ rows: [], quotesLoading: false, reasonSuffix: '' });
      return;
    }

    let basic: QuoteRow[];
    try {
      basic = await this.quoteService.fetchRowsBasic(codes, positions);
    } catch (e) {
      push({
        rows: this.buildSkeletonRows(codes, positions),
        error: e instanceof Error ? e.message : String(e),
        quotesLoading: false,
        reasonSuffix: '-err-basic',
      });
      return;
    }

    if (my !== this.seq) {
      return;
    }

    // 基础行情先展示（不等待主力净流入），提升首屏速度
    this.rowCache.clear();
    for (const r of basic) {
      this.rowCache.set(r.code, r);
    }
    push({ rows: basic, quotesLoading: true, reasonSuffix: '-basic' });

    // 监听触发（用基础行情即可：速度快；主力净流入不影响阈值）
    void this.checkAndFireAlerts(basic);

    if (my !== this.seq) {
      return;
    }

    // 主力净流入后台并发补齐：每拿到一只就 patch 该行
    void this.enrichMainForceStreaming(codes, basic, my);
  }

  private pruneRowCache(activeCodes: readonly NormalizedCode[]): void {
    const keep = new Set(activeCodes);
    for (const code of this.rowCache.keys()) {
      if (!keep.has(code)) {
        this.rowCache.delete(code);
      }
    }
  }

  private async enrichMainForceStreaming(codes: NormalizedCode[], baseRows: QuoteRow[], seqToken: number): Promise<void> {
    if (codes.length === 0) {
      return;
    }

    const extras = await mapLimit(codes, 8, async (code) => fetchEastmoneyMainForceOne(code));
    if (seqToken !== this.seq) {
      return;
    }

    const upserts: QuoteRow[] = [];
    for (let i = 0; i < codes.length; i++) {
      const prev = baseRows[i]!;
      const em = extras[i]!;
      const errors = [...(prev.errors ?? [])];
      const filtered = errors.filter((e) => e !== '主力净流入暂不可用');
      if (em.mainNetInflowWan === null) {
        filtered.push('主力净流入暂不可用');
      }
      const patched: QuoteRow = {
        ...prev,
        mainNetInflowWan: em.mainNetInflowWan,
        errors: filtered.length ? filtered : undefined,
      };
      this.rowCache.set(patched.code, patched);
      upserts.push(patched);
    }

    // 一次 patch 推送全部更新（4 只股票也足够快）；可避免多次 render 抖动
    this.postPatch({ reason: 'mainforce', upserts, quotesLoading: false });
  }

  private getUiStateSnapshot(): {
    groups: { id: string; name: string; count: number }[];
    activeGroupId: string;
    turnoverDisplay: 'wan' | 'yi';
    stealthMode: boolean;
    sortKey: string;
    sortDir: number;
  } {
    const groups = this.store.getGroups().map((g) => ({ id: g.id, name: g.name, count: g.codes.length }));
    const activeGroupId = this.store.getActiveGroupId();
    const turnoverDisplay = (vscode.workspace.getConfiguration('traderx').get<string>('turnoverDisplay') ?? 'yi') as 'wan' | 'yi';
    const stealthMode = vscode.workspace.getConfiguration('traderx').get<boolean>('intradayStealthMode') === true;
    const sort = this.store.getSortForGroup(activeGroupId);
    return { groups, activeGroupId, turnoverDisplay, stealthMode, sortKey: sort.key, sortDir: sort.dir };
  }

  private postPatch(payload: {
    reason: string;
    upserts?: QuoteRow[];
    removes?: NormalizedCode[];
    quotesLoading?: boolean;
    error?: string;
  }): void {
    const snap = this.getUiStateSnapshot();
    const idx = this.getIndicesSnapshotSync();
    this.postMessageAll({
      type: 'patch',
      reason: payload.reason,
      upserts: payload.upserts ?? [],
      removes: payload.removes ?? [],
      quotesLoading: !!payload.quotesLoading,
      error: payload.error,
      updatedAt: Date.now(),
      indices: idx.indices,
      indicesUpdatedAt: idx.indicesUpdatedAt,
      groups: snap.groups,
      activeGroupId: snap.activeGroupId,
      turnoverDisplay: snap.turnoverDisplay,
      stealthMode: snap.stealthMode,
      sortKey: snap.sortKey,
      sortDir: snap.sortDir,
    });
    this.refreshIndicesIfStale();
  }

  private async checkAndFireAlerts(rows: QuoteRow[]): Promise<void> {
    const alerts = this.store.getAlerts().filter((a) => !a.triggeredAt);
    if (alerts.length === 0) {
      return;
    }
    const byCode = new Map<string, QuoteRow>();
    for (const r of rows) {
      byCode.set(r.code, r);
    }
    for (const a of alerts) {
      const r = byCode.get(a.code);
      if (!r) continue;
      let cur: number | null = null;
      let label = '';
      if (a.type === 'price') {
        cur = r.price ?? null;
        label = '价格';
      } else {
        cur = r.changePct ?? null;
        label = '涨跌幅%';
      }
      if (cur === null || Number.isNaN(cur)) continue;
      const hit = a.op === '>=' ? cur >= a.target : cur <= a.target;
      if (!hit) continue;

      await this.store.markAlertTriggered(a.id);
      const title = `TraderX 监听触发：${r.name}（${r.code}）`;
      const curStr = a.type === 'price' ? `${cur.toFixed(2)} 元` : `${cur.toFixed(2)} %`;
      const targetStr = a.type === 'price' ? `${a.target.toFixed(2)} 元` : `${a.target.toFixed(2)} %`;
      const actionClear = '清理该股监听';
      const actionEdit = '继续设置…';
      const picked = await vscode.window.showInformationMessage(`${label} ${a.op} ${targetStr}（当前 ${curStr}）`, actionClear, actionEdit);
      if (picked === actionClear) {
        await this.store.clearAlertsForCode(a.code);
      } else if (picked === actionEdit) {
        await this.openAlertWizard(a.code);
      }
    }
  }

  private async openAlertWizard(code: NormalizedCode): Promise<void> {
    const kind = await vscode.window.showQuickPick(
      [
        { label: '监听股价到指定价格', v: 'price' as const },
        { label: '监听涨跌幅到指定涨幅', v: 'changePct' as const },
        { label: '清理该股监听', v: 'clear' as const },
      ],
      { placeHolder: `设置监听：${code}` },
    );
    if (!kind) {
      return;
    }
    if (kind.v === 'clear') {
      await this.store.clearAlertsForCode(code);
      vscode.window.showInformationMessage(`已清理监听：${code}`);
      return;
    }
    const op = await vscode.window.showQuickPick(
      [
        { label: '达到或高于（>=）', v: '>=' as const },
        { label: '达到或低于（<=）', v: '<=' as const },
      ],
      { placeHolder: '触发条件' },
    );
    if (!op) {
      return;
    }
    const prompt = kind.v === 'price' ? '目标价（元）' : '目标涨跌幅（%）';
    const raw = await vscode.window.showInputBox({ title: `设置监听：${code}`, prompt });
    if (raw === undefined) {
      return;
    }
    const v = Number(raw.trim());
    if (!Number.isFinite(v)) {
      vscode.window.showErrorMessage('输入的目标值无效');
      return;
    }
    await this.store.addAlert({ code, type: kind.v, target: v, op: op.v });
    vscode.window.showInformationMessage(`已设置监听：${code}`);
  }

  private async postPatchAddToActiveGroup(code: NormalizedCode, reason: string): Promise<void> {
    const my = ++this.seq;
    const positions = this.store.getPositions();
    const skeleton = this.buildSkeletonRows([code], positions)[0]!;
    this.rowCache.set(code, skeleton);
    this.postPatch({ reason: `${reason}-skeleton`, upserts: [skeleton], quotesLoading: true });

    try {
      const full = await this.quoteService.fetchRows([code], positions);
      if (my !== this.seq) {
        return;
      }
      const r = full[0]!;
      this.rowCache.set(code, r);
      this.postPatch({ reason, upserts: [r], quotesLoading: false });
    } catch (e) {
      if (my !== this.seq) {
        return;
      }
      this.postPatch({
        reason: `${reason}-err`,
        upserts: [skeleton],
        quotesLoading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async postPatchRemoveFromActiveGroup(code: NormalizedCode, reason: string): Promise<void> {
    ++this.seq;
    this.rowCache.delete(code);
    this.postPatch({ reason, removes: [code], quotesLoading: false });
  }

  private async postPatchRefreshOne(code: NormalizedCode, reason: string): Promise<void> {
    const my = ++this.seq;
    const positions = this.store.getPositions();
    const cached = this.rowCache.get(code);
    const fallback = cached ?? this.buildSkeletonRows([code], positions)[0]!;

    // 持仓编辑：优先本地重算盈亏，减少一次网络请求；若价格未知再补网络
    const canLocal =
      cached &&
      typeof cached.price === 'number' &&
      cached.price !== null &&
      positions[code] !== undefined;

    if (canLocal) {
      const pos = positions[code]!;
      const cost = pos?.cost;
      const shares = pos?.shares;
      let pnlYuan: number | null = null;
      let pnlPct: number | null = null;
      if (cached.price !== null && cost !== undefined && shares !== undefined && shares > 0) {
        pnlYuan = (cached.price - cost) * shares;
        if (cost !== 0) {
          pnlPct = ((cached.price - cost) / cost) * 100;
        }
      }
      const patched: QuoteRow = { ...cached, cost, shares, pnlYuan, pnlPct };
      this.rowCache.set(code, patched);
      this.postPatch({ reason: `${reason}-local`, upserts: [patched], quotesLoading: false });
      return;
    }

    this.postPatch({ reason: `${reason}-loading`, upserts: [fallback], quotesLoading: true });
    try {
      const full = await this.quoteService.fetchRows([code], positions);
      if (my !== this.seq) {
        return;
      }
      const r = full[0]!;
      this.rowCache.set(code, r);
      this.postPatch({ reason, upserts: [r], quotesLoading: false });
    } catch (e) {
      if (my !== this.seq) {
        return;
      }
      this.postPatch({
        reason: `${reason}-err`,
        upserts: [fallback],
        quotesLoading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async onMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type;
    if (type === 'addStock') {
      await vscode.commands.executeCommand('traderx.addStock');
      return;
    }
    if (type === 'selectGroup' && typeof msg.groupId === 'string') {
      await this.store.setActiveGroupId(msg.groupId);
      await this.refresh('selectGroup');
      return;
    }
    if (type === 'removeStock' && typeof msg.code === 'string') {
      await this.store.removeCodeFromGroup(this.store.getActiveGroupId(), msg.code);
      await this.postPatchRemoveFromActiveGroup(msg.code as NormalizedCode, 'remove');
      return;
    }
    if (type === 'openGroupManage') {
      await vscode.commands.executeCommand('traderx.openGroupManage');
      return;
    }
    if (type === 'openSettings') {
      await vscode.commands.executeCommand('traderx.openSettings');
      return;
    }
    if (type === 'clearPosition' && typeof msg.code === 'string') {
      const code = msg.code as NormalizedCode;
      const cur = this.store.getPositions()[code];
      const shares = cur?.shares;
      if (shares === undefined || !Number.isFinite(shares) || shares <= 0) {
        vscode.window.showInformationMessage('当前未记录有效持仓，无需清仓');
        return;
      }
      await this.store.setPosition(code, { cost: undefined, shares: undefined });
      vscode.window.showInformationMessage(`已清仓：${code}`);
      await this.editPositionIncremental(code);
      return;
    }
    if (type === 'copyStock' && typeof msg.code === 'string') {
      const fromId = this.store.getActiveGroupId();
      const others = this.store.getGroups().filter((g) => g.id !== fromId);
      if (others.length === 0) {
        vscode.window.showInformationMessage('没有其他分组可复制到');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        others.map((g) => ({ label: g.name, description: `${g.codes.length} 只`, gid: g.id })),
        { placeHolder: `复制 ${msg.code} 到分组` },
      );
      if (!picked || !('gid' in picked)) {
        return;
      }
      const r = await this.store.copyCodeToGroup(fromId, picked.gid as string, msg.code);
      if (r === 'exists') {
        vscode.window.showInformationMessage('目标分组已包含该股票');
      } else if (r === 'ok') {
        vscode.window.showInformationMessage('已复制到其他分组');
      }
      ++this.seq;
      this.postPatch({ reason: 'copy', quotesLoading: false });
      return;
    }
    if (type === 'moveStock' && typeof msg.code === 'string') {
      const fromId = this.store.getActiveGroupId();
      const others = this.store.getGroups().filter((g) => g.id !== fromId);
      if (others.length === 0) {
        vscode.window.showInformationMessage('没有其他分组可移动');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        others.map((g) => ({ label: g.name, description: `${g.codes.length} 只`, gid: g.id })),
        { placeHolder: `移动 ${msg.code} 到分组（从当前分组移除）` },
      );
      if (!picked || !('gid' in picked)) {
        return;
      }
      const r = await this.store.moveCodeToGroup(fromId, picked.gid as string, msg.code);
      if (r === 'exists') {
        vscode.window.showInformationMessage('目标分组已有该股票，已从当前分组移除');
      } else if (r === 'ok') {
        vscode.window.showInformationMessage('已移动到其他分组');
      }
      await this.postPatchRemoveFromActiveGroup(msg.code as NormalizedCode, 'move');
      return;
    }
    if (type === 'openIntraday' && typeof msg.code === 'string') {
      await vscode.commands.executeCommand('traderx.openIntraday', msg.code);
      return;
    }
    if (type === 'requestIntraday' && typeof msg.code === 'string') {
      await this.postIntradaySeries(msg.code as NormalizedCode);
      return;
    }
    if (type === 'editPosition' && typeof msg.code === 'string') {
      await vscode.commands.executeCommand('traderx.editPosition', msg.code);
      return;
    }
    if (type === 'setAlert' && typeof msg.code === 'string') {
      await this.openAlertWizard(msg.code as NormalizedCode);
      return;
    }
    if (type === 'clearAlerts' && typeof msg.code === 'string') {
      await this.store.clearAlertsForCode(msg.code as NormalizedCode);
      vscode.window.showInformationMessage(`已清理监听：${msg.code}`);
      return;
    }
    if (type === 'refresh') {
      await this.refresh('webview');
      return;
    }
    if (type === 'setSort' && typeof msg.sortKey === 'string' && typeof msg.sortDir === 'number') {
      const gid = this.store.getActiveGroupId();
      await this.store.setSortForGroup(gid, { key: msg.sortKey, dir: msg.sortDir as number });
      return;
    }
  }

  private async postIntradaySeries(code: NormalizedCode): Promise<void> {
    const cached = this.intradayCache.get(code);
    const now = Date.now();
    if (cached?.data && now - cached.updatedAt < 30_000) {
      this.postMessageAll({ type: 'intradaySeries', code, data: cached.data, updatedAt: cached.updatedAt });
      return;
    }
    if (cached?.inflight) {
      return;
    }

    const inflight = (async () => {
      this.postMessageAll({ type: 'intradaySeriesLoading', code });
      try {
        const res = await fetchIntradaySeries(code);
        const data: IntradayPreviewPayload = {
          code,
          name: res.name,
          preClose: Number.isFinite(res.preClose) ? res.preClose : 0,
          points: res.points.map((p) => ({
            timeLabel: p.timeLabel,
            price: p.price,
            avgPrice: p.avgPrice,
          })),
          updatedAt: Date.now(),
        };
        this.intradayCache.set(code, { updatedAt: data.updatedAt, data });
        this.postMessageAll({ type: 'intradaySeries', code, data, updatedAt: data.updatedAt });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.intradayCache.set(code, { updatedAt: Date.now(), error });
        this.postMessageAll({ type: 'intradaySeriesError', code, error });
      } finally {
        const next = this.intradayCache.get(code);
        if (next) {
          delete next.inflight;
          this.intradayCache.set(code, next);
        }
      }
    })();

    this.intradayCache.set(code, { updatedAt: cached?.updatedAt ?? 0, data: cached?.data, error: cached?.error, inflight });
    await inflight;
  }

  private buildHtml(webview: vscode.Webview, nonce: string): string {
    const csp = [
      `default-src 'none';`,
      `style-src ${webview.cspSource} 'unsafe-inline';`,
      `script-src 'nonce-${nonce}';`,
      `connect-src ${webview.cspSource};`,
    ].join(' ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TraderX 自选</title>
  <style>
    :root {
      --border: var(--vscode-panel-border, rgba(128,128,128,.35));
      --muted: var(--vscode-descriptionForeground);
      --bg-header: var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04));
      /** 冻结前 4 列宽度（与 left 累加一致） */
      /** 名称：约 4 个中文字符 + 省略号 */
      --freeze-w1: 64px;
      /** 现价 */
      --freeze-w2: 48px;
      /** 涨幅 */
      --freeze-w3: 48px;
      /** 操作：3 个 icon 按钮 */
      --freeze-w4: 132px;
      --freeze-l2: var(--freeze-w1);
      --freeze-l3: calc(var(--freeze-w1) + var(--freeze-w2));
      --freeze-l4: calc(var(--freeze-w1) + var(--freeze-w2) + var(--freeze-w3));
    }
    body {
      margin: 0;
      padding: 8px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .bar-row {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-bottom: 6px;
      flex-wrap: nowrap;
    }
    .bar-row .flex-grow {
      flex: 1;
      min-width: 0;
    }
    .meta-line {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 8px;
    }
    select#groupSelect {
      width: 100%;
      padding: 4px 6px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 2px;
    }
    button.icon-btn {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
    }
    button.icon-btn svg { display: block; }
    .more-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    .more-actions button {
      text-align: left;
      width: 100%;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    tbody tr.data-row { cursor: pointer; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid transparent;
      border-radius: 2px;
      padding: 4px 8px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .meta {
      color: var(--muted);
      font-size: 11px;
    }
    .error {
      color: var(--vscode-errorForeground);
      margin: 6px 0;
      white-space: pre-wrap;
    }
    .table-wrap {
      overflow-y: auto;
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      table-layout: fixed;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 3;
      background: var(--bg-header);
      border-bottom: 1px solid var(--border);
      text-align: left;
      padding: 6px 8px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      /** 列宽拖拽把手用 */
      position: sticky;
    }
    /** 前 4 列横向滚动时固定；表头角块需盖住下方冻结单元格 */
    thead th:nth-child(1),
    tbody td:nth-child(1) {
      position: sticky;
      left: 0;
      box-sizing: border-box;
      width: var(--freeze-w1);
      min-width: var(--freeze-w1);
      max-width: var(--freeze-w1);
    }
    thead th:nth-child(2),
    tbody td:nth-child(2) {
      position: sticky;
      left: var(--freeze-l2);
      box-sizing: border-box;
      width: var(--freeze-w2);
      min-width: var(--freeze-w2);
      max-width: var(--freeze-w2);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    thead th:nth-child(3),
    tbody td:nth-child(3) {
      position: sticky;
      left: var(--freeze-l3);
      box-sizing: border-box;
      width: var(--freeze-w3);
      min-width: var(--freeze-w3);
      max-width: var(--freeze-w3);
    }
    thead th:nth-child(4),
    tbody td:nth-child(4) {
      position: sticky;
      left: var(--freeze-l4);
      box-sizing: border-box;
      width: var(--freeze-w4);
      min-width: var(--freeze-w4);
      max-width: var(--freeze-w4);
      box-shadow: 6px 0 10px -6px rgba(0, 0, 0, 0.18);
    }
    thead th:nth-child(-n+4) {
      z-index: 6;
    }
    tbody td:nth-child(-n+4) {
      z-index: 2;
      background: var(--vscode-editor-background);
    }
    tbody tr:hover td:nth-child(-n+4) {
      background: var(--vscode-list-hoverBackground);
    }
    thead th[data-k] .sort-ind {
      display: inline-block;
      min-width: 1.1em;
      font-size: 10px;
      line-height: 1;
      opacity: 0.4;
      margin-left: 3px;
      vertical-align: middle;
    }
    thead th[data-k].sort-active {
      font-weight: 600;
    }
    thead th[data-k].sort-active .sort-ind {
      opacity: 1;
    }
    tbody td {
      border-bottom: 1px solid var(--border);
      padding: 4px 6px;
      white-space: nowrap;
    }
    /* 名称最多展示约 4 个字符 */
    tbody td:nth-child(1) {
      max-width: var(--freeze-w1);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* 操作列不省略，按钮完整显示 */
    tbody td.actions {
      overflow: visible;
      text-overflow: clip;
      white-space: nowrap;
    }
    thead th { padding: 5px 6px; }
    /** 表头拖拽调整列宽 */
    thead th {
      position: sticky;
    }
    thead th .col-resizer {
      position: absolute;
      top: 0;
      right: -2px;
      width: 6px;
      height: 100%;
      cursor: col-resize;
      user-select: none;
      touch-action: none;
    }
    thead th .col-resizer:hover {
      background: color-mix(in srgb, var(--vscode-focusBorder) 25%, transparent);
    }
    tbody tr:hover td {
      background: var(--vscode-list-hoverBackground);
    }
    .right { text-align: right; }
    .cn-up { color: var(--vscode-charts-red, #f14c4c); }
    .cn-down { color: var(--vscode-charts-green, #3fb950); }
    ${STEALTH_OFFICE_STYLE_SNIPPET}
    .actions button {
      margin-right: 6px;
      padding: 2px 6px;
      font-size: 11px;
      width: 26px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .actions button svg { display: block; }
    .empty {
      padding: 16px;
      color: var(--muted);
    }
    details.reserve {
      margin-top: 10px;
      border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
      border-radius: 6px;
      padding: 8px;
      color: var(--muted);
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, white 8%);
    }
    details.reserve:first-of-type {
      margin-top: 0;
    }
    details.reserve summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .indices-line {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin: 2px 0 8px 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.5;
    }
    .idx-item { white-space: nowrap; }
    .idx-item .nm { opacity: .9; }
    .idx-item .px { color: var(--vscode-foreground); }
    .idx-item .pct { margin-left: 4px; }

  </style>
  <style>
    body {
      padding: 12px;
      line-height: 1.45;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 97%, black 3%) 0%, var(--vscode-editor-background) 100%);
    }
    .traderx-stealth-inner {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .watchlist-body {
      margin-top: 10px;
    }
    .bar-row {
      gap: 6px;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 76%, transparent);
    }
    .meta-line {
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      padding: 2px 0 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 62%, transparent);
    }
    .toolbar-label {
      flex-shrink: 0;
      color: color-mix(in srgb, var(--vscode-descriptionForeground) 90%, var(--vscode-foreground) 10%);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .bar-row > label.meta {
      flex-shrink: 0;
      color: color-mix(in srgb, var(--vscode-descriptionForeground) 90%, var(--vscode-foreground) 10%);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .meta-badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 0;
      background: color-mix(in srgb, var(--vscode-editor-background) 82%, white 18%);
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 82%, transparent);
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      white-space: nowrap;
    }
    .meta-line::after {
      content: "LIVE";
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 0;
      background: transparent;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 35%, transparent);
      color: color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 70%, var(--vscode-foreground) 30%);
      font-size: 11px;
      white-space: nowrap;
      letter-spacing: .08em;
    }
    select#groupSelect {
      padding: 7px 8px;
      border-radius: 0;
      border-color: color-mix(in srgb, var(--vscode-dropdown-border) 68%, transparent);
      background: color-mix(in srgb, var(--vscode-dropdown-background) 96%, black 4%);
    }
    button {
      border-radius: 0;
      padding: 7px 10px;
      transition: background .16s ease, border-color .16s ease, color .16s ease;
    }
    button:hover {
      border-color: color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 30%, transparent);
    }
    button:active {
      background: color-mix(in srgb, var(--vscode-button-background) 82%, black 18%);
    }
    button.icon-btn {
      width: 30px;
      height: 30px;
      border-radius: 0;
    }
    .table-wrap {
      border-radius: 0;
      border-color: color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 72%, transparent);
      background: color-mix(in srgb, var(--vscode-editor-background) 98%, white 2%);
      box-shadow: none;
    }
    thead th {
      padding: 10px;
      background: color-mix(in srgb, var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04)) 82%, black 2%);
      border-bottom-color: color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 92%, transparent);
    }
    tbody td {
      padding: 9px 10px;
      border-bottom-color: color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 82%, transparent);
      transition: background .16s ease;
    }
    tbody tr.data-row:hover td {
      background: color-mix(in srgb, var(--vscode-list-hoverBackground) 88%, var(--vscode-editor-background) 12%);
    }
    .actions button {
      width: 26px;
      height: 26px;
      padding: 0;
      border-radius: 0;
      background: transparent;
      border-color: transparent;
      color: var(--vscode-descriptionForeground);
    }
    .actions button:hover {
      background: color-mix(in srgb, var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04)) 70%, white 8%);
      color: var(--vscode-foreground);
    }
    .actions button.active {
      background: color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 20%, transparent);
      border-color: color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 40%, transparent);
      color: var(--vscode-foreground);
    }
    .intraday-panel {
      margin-top: 10px;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 82%, transparent);
      background: color-mix(in srgb, var(--vscode-editor-background) 97%, white 3%);
    }
    .intraday-panel[hidden] {
      display: none !important;
    }
    .intraday-card {
      padding: 10px 12px 12px;
    }
    .intraday-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .intraday-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .intraday-name {
      color: var(--vscode-foreground);
      font-weight: 700;
      font-size: 13px;
      line-height: 1.2;
    }
    .intraday-code {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .intraday-stat {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
      margin-left: auto;
    }
    .intraday-quote-main {
      display: inline-flex;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .intraday-quote-price {
      font-size: 20px;
      line-height: 1;
      font-weight: 700;
      letter-spacing: .01em;
    }
    .intraday-quote-pct {
      font-size: 12px;
      font-weight: 700;
    }
    .intraday-quote-sub {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .intraday-chart-wrap {
      position: relative;
      cursor: crosshair;
    }
    .intraday-canvas {
      width: 100%;
      height: 220px;
      display: block;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 82%, transparent);
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 92%, white 8%) 0%, color-mix(in srgb, var(--vscode-editor-background) 99%, black 1%) 100%);
    }
    .intraday-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 2;
    }
    .intraday-tooltip {
      position: absolute;
      pointer-events: none;
      z-index: 3;
      background: rgba(30,30,30,0.92);
      color: #e0e0e0;
      font-size: 11px;
      line-height: 1.55;
      padding: 3px 7px;
      border: 1px solid rgba(128,128,128,0.3);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      display: none;
    }
    .intraday-foot {
      margin-top: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .intraday-msg {
      padding: 18px 12px;
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .empty {
      padding: 24px 14px;
      text-align: center;
      border: 1px dashed color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 80%, transparent);
      border-radius: 0;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 96%, white 4%) 0%, color-mix(in srgb, var(--vscode-editor-background) 99%, black 1%) 100%);
    }
    details.reserve {
      margin-top: 0;
      padding: 10px 12px 12px;
      border-radius: 0;
      border-color: color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 72%, transparent);
      background: linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 97%, white 3%) 0%, color-mix(in srgb, var(--vscode-editor-background) 99%, black 1%) 100%);
      box-shadow: none;
    }
    details.reserve summary {
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      list-style: none;
      padding-bottom: 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 78%, transparent);
    }
    details.reserve summary::-webkit-details-marker {
      display: none;
    }
    .indices-line {
      gap: 6px;
      margin: 0 0 10px 0;
    }
    .idx-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 7px;
      border-radius: 0;
      background: color-mix(in srgb, var(--vscode-editor-background) 94%, white 6%);
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,.35)) 78%, transparent);
    }
    .more-actions {
      gap: 8px;
      margin-top: 10px;
    }
    .more-actions button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-radius: 0;
    }
    .more-actions button::after {
      content: "›";
      color: var(--vscode-descriptionForeground);
      font-size: 14px;
    }
    .more-actions button::after {
      content: ">";
    }
    .action-hint {
      margin: 10px 0 0 0;
      line-height: 1.6;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      padding: 8px 10px;
      border-radius: 0;
      background: color-mix(in srgb, var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04)) 82%, black 2%);
      border-left: 2px solid color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 35%, transparent);
    }
    details.reserve > p {
      margin: 10px 0 0 0 !important;
      line-height: 1.6 !important;
      color: var(--vscode-descriptionForeground) !important;
      font-size: 11px !important;
      padding: 8px 10px;
      border-radius: 0;
      background: color-mix(in srgb, var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04)) 82%, black 2%);
      border-left: 2px solid color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 35%, transparent);
    }
  </style>
</head>
<body>
  <div class="traderx-stealth-scrim" aria-hidden="true"></div>
  <div class="traderx-stealth-inner">
  <details class="reserve" id="watchlistDetails">
    <summary>自选栏</summary>
    <div class="watchlist-body">
      <div class="indices-line" id="indicesLine" style="display:none"></div>
      <div class="bar-row">
        <label for="groupSelect" class="meta" style="flex-shrink:0;">分组</label>
        <div class="flex-grow">
          <select id="groupSelect" aria-label="切换分组"></select>
        </div>
        <button type="button" class="icon-btn" id="btnAdd" title="添加自选" aria-label="添加自选">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
        <button type="button" class="icon-btn secondary" id="btnRefresh" title="刷新行情" aria-label="刷新行情">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13 6a6 6 0 00-9.9-3.5M3 10a6 6 0 009.9 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12 2v4h-4M4 14v-4h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="meta-line"><span class="meta" id="meta"></span></div>
      <div class="error" id="err" style="display:none"></div>
      <div id="empty" class="empty" style="display:none">暂无自选。点击「添加自选」开始。</div>
      <div class="table-wrap" id="wrap" style="display:none">
        <table>
          <colgroup id="cols">
            <col style="width:64px" />
            <col style="width:48px" />
            <col style="width:48px" />
            <col style="width:132px" />
          </colgroup>
          <thead>
            <tr>
              <th data-k="name">名称<span class="sort-ind" aria-hidden="true"></span></th>
              <th class="right" data-k="price">现价<span class="sort-ind" aria-hidden="true"></span></th>
              <th class="right" data-k="changePct">涨跌幅<span class="sort-ind" aria-hidden="true"></span></th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>
      <section class="intraday-panel" id="intradayPanel" hidden>
        <div id="intradayMount"></div>
      </section>
    </div>
  </details>

  <details class="reserve">
    <summary>更多功能</summary>
    <div class="more-actions">
      <button type="button" id="btnGroupManage">分组管理…</button>
      <button type="button" id="btnGlobalSettings">全局设置…</button>
    </div>
    <p style="margin:10px 0 0 0;line-height:1.5;color:var(--muted);font-size:11px;">
      后续可扩展：大盘指数、预警、策略信号等。持仓盈亏在侧栏表格中维护。
    </p>
  </details>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    /** @type {any[]} */
    let rows = [];
    /** @type {{id:string,name:string,count:number}[]} */
    let groups = [];
    let activeGroupId = '';
    let lastUpdatedAt = Date.now();
    /** @type {{name:string,price:number|null,changePct:number|null}[]} */
    let indices = [];
    let indicesUpdatedAt = 0;
    let quotesLoading = false;
    let stealthMode = false;
    let turnoverDisplay = 'yi';
    let sortKey = 'name';
    let sortDir = 1;
    let userSorted = false;
    let skipSortOnce = true;
    let lastIndicesSig = '';
    let lastGroupSig = '';
    let lastMetaText = '';
    let intradayOpenCode = '';
    let intradayChartMetrics = null;
    const intradaySeries = new Map();
    const intradayLoading = new Set();
    const intradayErrors = new Map();

    function getColEls() {
      const cg = document.getElementById('cols');
      if (!cg) return [];
      return Array.from(cg.querySelectorAll('col'));
    }

    function readPx(s) {
      if (!s) return null;
      const m = String(s).match(/(\\d+(?:\\.\\d+)?)px/);
      if (!m) return null;
      return Number(m[1]);
    }

    function setFreezeWidthVar(idx, px) {
      const root = document.documentElement;
      if (idx === 0) root.style.setProperty('--freeze-w1', px + 'px');
      if (idx === 1) root.style.setProperty('--freeze-w2', px + 'px');
      if (idx === 2) root.style.setProperty('--freeze-w3', px + 'px');
      if (idx === 3) root.style.setProperty('--freeze-w4', px + 'px');
    }

    function loadColumnWidths() {
      if (!vscode.getState) return;
      const st = vscode.getState() || {};
      if (!Array.isArray(st.colWidths)) return;
      const cols = getColEls();
      for (let i = 0; i < cols.length && i < st.colWidths.length; i++) {
        const w = st.colWidths[i];
        if (typeof w === 'number' && Number.isFinite(w) && w > 20) {
          cols[i].style.width = w + 'px';
          if (i < 4) setFreezeWidthVar(i, w);
        }
      }
    }

    function saveColumnWidths() {
      if (!vscode.setState) return;
      const cols = getColEls();
      const widths = cols.map((c) => {
        const w = readPx(c.style.width) ?? c.getBoundingClientRect().width;
        return Math.round(w);
      });
      const st = (vscode.getState && vscode.getState()) || {};
      vscode.setState({ ...st, colWidths: widths });
    }

    function setupResizableHeaders() {
      const ths = Array.from(document.querySelectorAll('thead th'));
      const cols = getColEls();
      if (ths.length === 0 || cols.length === 0) return;

      ths.forEach((th, i) => {
        th.style.position = 'sticky';
        const h = document.createElement('span');
        h.className = 'col-resizer';
        h.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const startW = cols[i]?.getBoundingClientRect().width ?? th.getBoundingClientRect().width;
          const minW = i === 1 ? 56 : 44;

          function onMove(ev) {
            const dx = ev.clientX - startX;
            const w = Math.max(minW, Math.round(startW + dx));
            if (cols[i]) cols[i].style.width = w + 'px';
            if (i < 4) setFreezeWidthVar(i, w);
          }

          function onUp() {
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('mouseup', onUp, true);
            saveColumnWidths();
          }

          window.addEventListener('mousemove', onMove, true);
          window.addEventListener('mouseup', onUp, true);
        });
        th.appendChild(h);
      });
    }

    function applyPatch(upserts, removes) {
      const rmSet = new Set(removes || []);
      let next = rows.filter((r) => !rmSet.has(r.code));
      const by = new Map(next.map((r) => [r.code, r]));
      for (const r of (upserts || [])) {
        if (!r || !r.code) continue;
        by.set(r.code, r);
      }
      next = Array.from(by.values());
      rows = next;
    }

    function fillGroupSelect() {
      const sel = document.getElementById('groupSelect');
      const sig = groups.map((g) => g.id + ':' + g.name + ':' + g.count).join('|') + '::' + activeGroupId;
      if (sig === lastGroupSig) return;
      lastGroupSig = sig;
      sel.innerHTML = '';
      for (const g of groups) {
        const o = document.createElement('option');
        o.value = g.id;
        o.textContent = g.name + ' (' + g.count + ')';
        if (g.id === activeGroupId) o.selected = true;
        sel.appendChild(o);
      }
    }

    function fmtNum(n, digits) {
      if (n === null || n === undefined || Number.isNaN(n)) return '—';
      return Number(n).toFixed(digits);
    }

    function fmtAmountYuan(yuan) {
      if (yuan === null || yuan === undefined || Number.isNaN(yuan)) return '—';
      if (turnoverDisplay === 'wan') return (yuan / 1e4).toFixed(2) + '万';
      return (yuan / 1e8).toFixed(2) + '亿';
    }

    function clsForChange(pct) {
      if (pct === null || pct === undefined || Number.isNaN(pct)) return '';
      if (pct > 0) return 'cn-up';
      if (pct < 0) return 'cn-down';
      return '';
    }

    function renderIndicesLine() {
      const el = document.getElementById('indicesLine');
      if (!el) return;
      if (!Array.isArray(indices) || indices.length === 0) {
        lastIndicesSig = '';
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      const sig = indices.map((it) => [it.name || '', fmtNum(it.price, 2), fmtNum(it.changePct, 2)].join(':')).join('|');
      if (sig === lastIndicesSig) {
        el.style.display = 'flex';
        return;
      }
      lastIndicesSig = sig;
      el.style.display = 'flex';
      el.replaceChildren();
      for (const it of indices) {
        const wrap = document.createElement('span');
        wrap.className = 'idx-item';
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = (it.name || '—') + ': ';
        const px = document.createElement('span');
        px.className = 'px';
        px.textContent = fmtNum(it.price, 2);
        const pct = document.createElement('span');
        pct.className = 'pct ' + clsForChange(it.changePct);
        pct.textContent = fmtNum(it.changePct, 2) + '%';
        wrap.appendChild(nm);
        wrap.appendChild(px);
        wrap.appendChild(pct);
        el.appendChild(wrap);
      }
    }

    function isShanghaiCallAuctionNow() {
      const d = new Date();
      const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(d);
      if (wd === 'Sat' || wd === 'Sun') return false;
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(d);
      const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
      const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
      const t = h * 60 + m;
      return t >= 9 * 60 + 15 && t < 9 * 60 + 30;
    }

    /** 鼠标悬浮行时展示与表格一致的全部字段（多行） */
    function rowTooltipText(r) {
      const lines = [
        '代码：' + (r.code ?? '—'),
        '名称：' + (r.name ?? '—'),
        '现价：' + fmtNum(r.price, 2),
        '涨跌幅%：' + fmtNum(r.changePct, 2),
      ];
      if (r.prevClose !== null && r.prevClose !== undefined && !Number.isNaN(r.prevClose)) {
        lines.push('昨收：' + fmtNum(r.prevClose, 2));
      }
      if (isShanghaiCallAuctionNow()) {
        if (r.bidPrice !== null && r.bidPrice !== undefined && !Number.isNaN(r.bidPrice)) {
          lines.push('竞买价：' + fmtNum(r.bidPrice, 2));
        }
        if (r.askPrice !== null && r.askPrice !== undefined && !Number.isNaN(r.askPrice)) {
          lines.push('竞卖价：' + fmtNum(r.askPrice, 2));
        }
      }
      lines.push(
        '主力净流入(万)：' + fmtNum(r.mainNetInflowWan, 2),
        '最高：' + fmtNum(r.high, 2),
        '最低：' + fmtNum(r.low, 2),
      );
      if (isShanghaiCallAuctionNow()) {
        lines.push('竞价成交额：' + fmtAmountYuan(r.amountYuan));
      } else {
        lines.push('成交额：' + fmtAmountYuan(r.amountYuan));
      }
      lines.push(
        '成本：' + (r.cost === undefined ? '—' : fmtNum(r.cost, 2)),
        '持仓：' + (r.shares === undefined ? '—' : String(r.shares)),
        '盈亏(元)：' + (r.pnlYuan === null || r.pnlYuan === undefined ? '—' : fmtNum(r.pnlYuan, 2)),
        '盈亏%：' + (r.pnlPct === null || r.pnlPct === undefined ? '—' : fmtNum(r.pnlPct, 2)),
      );
      if (Array.isArray(r.errors) && r.errors.length) {
        lines.push('提示：' + r.errors.join('；'));
      }
      return lines.join(String.fromCharCode(10));
    }

    function sortRows() {
      const k = sortKey;
      const dir = sortDir;
      const arr = rows.slice();
      const val = (r) => {
        const map = {
          name: r.name,
          price: r.price,
          changePct: r.changePct,
          mainNetInflowWan: r.mainNetInflowWan,
          cost: r.cost,
          shares: r.shares,
          pnlYuan: r.pnlYuan,
          pnlPct: r.pnlPct,
        };
        return map[k];
      };
      arr.sort((a,b) => {
        const va = val(a);
        const vb = val(b);
        const na = va === null || va === undefined ? null : (typeof va === 'string' ? va : Number(va));
        const nb = vb === null || vb === undefined ? null : (typeof vb === 'string' ? vb : Number(vb));
        if (na === null && nb === null) return 0;
        if (na === null) return 1;
        if (nb === null) return -1;
        if (typeof na === 'string' || typeof nb === 'string') {
          return String(na).localeCompare(String(nb), 'zh-CN') * dir;
        }
        return (na - nb) * dir;
      });
      return arr;
    }

    function updateSortHeaders() {
      document.querySelectorAll('thead th[data-k]').forEach((th) => {
        const k = th.getAttribute('data-k');
        const ind = th.querySelector('.sort-ind');
        if (!ind) return;
        th.classList.toggle('sort-active', k === sortKey);
        ind.textContent = k === sortKey ? (sortDir === 1 ? '▲' : '▼') : '';
      });
    }

    function fmtSignedPct(v) {
      if (v === null || v === undefined || Number.isNaN(v)) return '0.00%';
      return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
    }

    function extractHm(label) {
      const s = String(label || '');
      const m = s.match(/(\\d{2}:\\d{2})$/);
      return m ? m[1] : s.slice(-5);
    }

    function priceRange(series) {
      if (!series || !Array.isArray(series.points) || series.points.length === 0) return null;
      const vals = [];
      for (const p of series.points) {
        if (Number.isFinite(p.price)) vals.push(Number(p.price));
        if (Number.isFinite(p.avgPrice)) vals.push(Number(p.avgPrice));
      }
      if (Number.isFinite(series.preClose) && series.preClose > 0) vals.push(Number(series.preClose));
      if (vals.length === 0) return null;
      let min = Math.min.apply(null, vals);
      let max = Math.max.apply(null, vals);
      if (!(max > min)) {
        const pad = Math.max(Math.abs(max) * 0.003, 0.01);
        min -= pad;
        max += pad;
      } else {
        const pad = (max - min) * 0.08;
        min -= pad;
        max += pad;
      }
      return { min, max };
    }

    function getSeriesLastPrice(series) {
      if (!series || !Array.isArray(series.points) || series.points.length === 0) return null;
      const last = series.points[series.points.length - 1];
      const price = Number(last?.price);
      return Number.isFinite(price) ? price : null;
    }

    function getSeriesChangePct(series) {
      if (!series) return null;
      const lastPrice = getSeriesLastPrice(series);
      const preClose = Number(series.preClose || 0);
      if (lastPrice === null || !(preClose > 0)) return null;
      return ((lastPrice - preClose) / preClose) * 100;
    }

    function parseHmToMinute(label) {
      const s = String(label || '');
      const m = s.match(/(\d{2}):(\d{2})$/);
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
      return hh * 60 + mm;
    }

    function tradingMinuteOffset(label) {
      const minute = parseHmToMinute(label);
      if (minute === null) return null;
      const morningStart = 9 * 60 + 30;
      const morningEnd = 11 * 60 + 30;
      const afternoonStart = 13 * 60;
      const afternoonEnd = 15 * 60;
      if (minute <= morningStart) return 0;
      if (minute <= morningEnd) return minute - morningStart;
      if (minute < afternoonStart) return 120;
      if (minute <= afternoonEnd) return 120 + (minute - afternoonStart);
      return 240;
    }

    function drawIntradayChart(canvas, series) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = Math.max(180, Math.floor(canvas.clientWidth || 300));
      const cssHeight = Math.max(180, Math.floor(canvas.clientHeight || 220));
      if (canvas.width !== Math.floor(cssWidth * dpr) || canvas.height !== Math.floor(cssHeight * dpr)) {
        canvas.width = Math.floor(cssWidth * dpr);
        canvas.height = Math.floor(cssHeight * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const range = priceRange(series);
      if (!range) return;
      const left = 42;
      const top = 14;
      const right = cssWidth - 42;
      const bottom = cssHeight - 24;
      const width = Math.max(10, right - left);
      const height = Math.max(10, bottom - top);
      const preClose = Number.isFinite(series.preClose) && series.preClose > 0 ? Number(series.preClose) : null;
      const axis = getComputedStyle(document.documentElement).getPropertyValue('--vscode-panel-border').trim() || 'rgba(127,127,127,.35)';
      const fg = getComputedStyle(document.documentElement).getPropertyValue('--vscode-foreground').trim() || '#ddd';
      const labelColor = getComputedStyle(document.documentElement).getPropertyValue('--vscode-descriptionForeground').trim() || fg;
      const changePct = getSeriesChangePct(series);
      const priceColor = changePct !== null && changePct < 0 ? '#3fb950' : '#f14c4c';
      const avgColor = '#4c8dff';

      let minPrice = range.min;
      let maxPrice = range.max;
      if (preClose !== null) {
        let maxDev = 0;
        for (const p of series.points) {
          const pv = Number(p.price);
          if (Number.isFinite(pv)) maxDev = Math.max(maxDev, Math.abs(pv - preClose));
          const av = Number(p.avgPrice);
          if (Number.isFinite(av)) maxDev = Math.max(maxDev, Math.abs(av - preClose));
        }
        const paddedDev = Math.max(maxDev * 1.08, preClose * 0.003, 0.01);
        minPrice = preClose - paddedDev;
        maxPrice = preClose + paddedDev;
      }
      const priceSpan = Math.max(maxPrice - minPrice, 0.01);

      for (let i = 0; i < 5; i++) {
        const y = top + (height * i) / 4;
        ctx.strokeStyle = axis;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const verticalMarks = [
        { label: '10:30', offset: 60 },
        { label: '11:30/13:00', offset: 120 },
        { label: '14:00', offset: 180 },
      ];
      for (const mark of verticalMarks) {
        const x = left + (mark.offset / 240) * width;
        ctx.strokeStyle = axis;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      if (preClose !== null) {
        const y = top + ((maxPrice - preClose) / priceSpan) * height;
        ctx.strokeStyle = 'rgba(255,255,255,.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }

      const total = Math.max(1, series.points.length - 1);
      const toX = (idx) => {
        const point = series.points[idx];
        const offset = tradingMinuteOffset(point?.timeLabel);
        if (offset === null) {
          return left + (idx / total) * width;
        }
        return left + (offset / 240) * width;
      };
      const toY = (price) => top + ((maxPrice - price) / priceSpan) * height;

      let hasAvgPath = false;
      ctx.strokeStyle = avgColor;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      series.points.forEach((p, idx) => {
        if (!Number.isFinite(p.avgPrice)) return;
        const x = toX(idx);
        const y = toY(Number(p.avgPrice));
        if (!hasAvgPath) {
          ctx.moveTo(x, y);
          hasAvgPath = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      if (hasAvgPath) ctx.stroke();

      ctx.strokeStyle = priceColor;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      series.points.forEach((p, idx) => {
        const x = toX(idx);
        const y = toY(Number(p.price));
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

      const last = series.points[series.points.length - 1];
      if (last) {
        const x = toX(series.points.length - 1);
        const y = toY(Number(last.price));
        ctx.fillStyle = priceColor;
        ctx.beginPath();
        ctx.arc(x, y, 2.8, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = labelColor;
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'top';
      const bottomLabels = [
        { label: '09:30', offset: 0, align: 'left' },
        { label: '10:30', offset: 60, align: 'center' },
        { label: '11:30/13:00', offset: 120, align: 'center' },
        { label: '14:00', offset: 180, align: 'center' },
        { label: '15:00', offset: 240, align: 'right' },
      ];
      for (const item of bottomLabels) {
        const x = left + (item.offset / 240) * width;
        const w = ctx.measureText(item.label).width;
        const drawX = item.align === 'left' ? x : item.align === 'right' ? x - w : x - w / 2;
        ctx.fillText(item.label, drawX, cssHeight - 16);
      }

      ctx.textBaseline = 'middle';
      const yMarks = [maxPrice, preClose, minPrice];
      yMarks.forEach((value, idx) => {
        if (!Number.isFinite(value)) return;
        const y = idx === 0 ? top : idx === 1 ? top + height / 2 : bottom;
        ctx.fillStyle = idx === 1 ? labelColor : fg;
        ctx.fillText(Number(value).toFixed(2), 2, y);
        if (preClose !== null) {
          const pct = ((Number(value) - preClose) / preClose) * 100;
          const pctText = (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
          const pctWidth = ctx.measureText(pctText).width;
          ctx.fillText(pctText, cssWidth - pctWidth - 2, y);
        }
      });

      intradayChartMetrics = { left, top, right, bottom, width, height, toX, toY, preClose, priceColor, avgColor, cssWidth, cssHeight, series };
    }

    function drawCrosshair(metrics, mouseX, mouseY) {
      if (!metrics) return null;
      const { left, top, right, bottom, toX, toY, preClose, priceColor, avgColor, cssWidth, cssHeight, series } = metrics;

      const overlay = document.querySelector('#intradayMount canvas[data-intraday-overlay]');
      const tooltip = document.querySelector('#intradayMount div[data-intraday-tooltip]');
      if (!overlay) return null;

      if (mouseX < left || mouseX > right || mouseY < top || mouseY > bottom) {
        clearCrosshair();
        return null;
      }

      const octx = overlay.getContext('2d');
      if (!octx) return null;
      const dpr = window.devicePixelRatio || 1;
      if (overlay.width !== Math.floor(cssWidth * dpr) || overlay.height !== Math.floor(cssHeight * dpr)) {
        overlay.width = Math.floor(cssWidth * dpr);
        overlay.height = Math.floor(cssHeight * dpr);
      }
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.clearRect(0, 0, cssWidth, cssHeight);

      let nearestIdx = -1;
      let nearestDist = Infinity;
      for (let i = 0; i < series.points.length; i++) {
        const x = toX(i);
        const dist = Math.abs(x - mouseX);
        if (dist < nearestDist) { nearestDist = dist; nearestIdx = i; }
      }
      if (nearestIdx < 0) return null;

      const point = series.points[nearestIdx];
      const px = toX(nearestIdx);
      const py = toY(Number(point.price));
      const axis = getComputedStyle(document.documentElement).getPropertyValue('--vscode-panel-border').trim() || 'rgba(127,127,127,.35)';

      // 竖线上
      octx.strokeStyle = axis;
      octx.lineWidth = 0.8;
      octx.setLineDash([3, 4]);
      octx.beginPath();
      octx.moveTo(px, top);
      octx.lineTo(px, bottom);
      octx.stroke();
      octx.setLineDash([]);

      // 水平价格线
      octx.strokeStyle = priceColor;
      octx.lineWidth = 0.7;
      octx.setLineDash([2, 3]);
      octx.beginPath();
      octx.moveTo(left, py);
      octx.lineTo(right, py);
      octx.stroke();
      octx.setLineDash([]);

      // 价格圆点
      octx.fillStyle = priceColor;
      octx.beginPath();
      octx.arc(px, py, 3.2, 0, Math.PI * 2);
      octx.fill();
      octx.strokeStyle = '#fff';
      octx.lineWidth = 1.4;
      octx.stroke();

      // 均线圆点
      let ay = null;
      if (Number.isFinite(point.avgPrice)) {
        ay = toY(Number(point.avgPrice));
        octx.fillStyle = avgColor;
        octx.beginPath();
        octx.arc(px, ay, 2.6, 0, Math.PI * 2);
        octx.fill();
        octx.strokeStyle = '#fff';
        octx.lineWidth = 1.1;
        octx.stroke();
      }

      // tooltip
      if (tooltip) {
        const price = Number(point.price);
        const change = preClose !== null && Number.isFinite(preClose) && preClose > 0 ? price - preClose : null;
        const changePct = change !== null ? (change / preClose) * 100 : null;
        let html = '<div style="margin-bottom:2px;font-weight:600">' + point.timeLabel + '</div>';
        html += '<div>' + fmtNum(price, 2);
        if (change !== null) {
          const sign = change > 0 ? '+' : '';
          html += '  <span style="color:' + (change >= 0 ? '#f14c4c' : '#3fb950') + '">' + sign + change.toFixed(2) + '  ' + (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%</span>';
        }
        html += '</div>';
        if (ay !== null && Number.isFinite(point.avgPrice)) {
          html += '<div style="color:#4c8dff">' + fmtNum(Number(point.avgPrice), 2) + '</div>';
        }
        tooltip.innerHTML = html;
        tooltip.style.display = '';
        const wrap = document.querySelector('#intradayMount .intraday-chart-wrap');
        const wrapRect = wrap ? wrap.getBoundingClientRect() : null;
        if (wrapRect) {
          let tx = px + 12;
          let ty = py - 8;
          const tw = tooltip.offsetWidth;
          const th = tooltip.offsetHeight;
          if (tx + tw > cssWidth - 4) tx = px - tw - 10;
          if (tx < 4) tx = 4;
          if (ty - th < 4) ty = py + 14;
          if (ty + th > cssHeight - 4) ty = cssHeight - th - 4;
          tooltip.style.left = tx + 'px';
          tooltip.style.top = ty + 'px';
        }
      }

      return point;
    }

    function clearCrosshair() {
      const overlay = document.querySelector('#intradayMount canvas[data-intraday-overlay]');
      if (overlay) {
        const ctx = overlay.getContext('2d');
        if (ctx) { const dpr = window.devicePixelRatio || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, overlay.clientWidth || 300, overlay.clientHeight || 220); }
      }
      const tooltip = document.querySelector('#intradayMount div[data-intraday-tooltip]');
      if (tooltip) { tooltip.style.display = 'none'; tooltip.innerHTML = ''; }
    }

    function wireIntradayHover(mount) {
      const wrap = mount.querySelector('.intraday-chart-wrap');
      if (!wrap) return;
      wrap.onmousemove = function(e) {
        const mainCanvas = wrap.querySelector('.intraday-canvas');
        if (!mainCanvas || !intradayChartMetrics) return;
        const rect = mainCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        drawCrosshair(intradayChartMetrics, mx, my);
      };
      wrap.onmouseleave = function() { clearCrosshair(); };
    }

    function buildIntradayContent(r) {
      const code = r.code;
      const series = intradaySeries.get(code);
      const err = intradayErrors.get(code);
      if (intradayLoading.has(code) && !series) {
        return '<div class="intraday-msg">\u5206\u65f6\u52a0\u8f7d\u4e2d...</div>';
      }
      if (err && !series) {
        return '<div class="intraday-msg">' + err + '</div>';
      }
      if (!series || !Array.isArray(series.points) || series.points.length === 0) {
        return '<div class="intraday-msg">\u6682\u65e0\u5206\u65f6\u6570\u636e</div>';
      }
      const lastPrice = getSeriesLastPrice(series);
      const preClose = Number(series.preClose || 0);
      const changePct = getSeriesChangePct(series) ?? 0;
      const cls = clsForChange(changePct);
      const hasAvg = series.points.some((p) => Number.isFinite(p.avgPrice));
      const openLabel = intradayLoading.has(code) ? '\u5237\u65b0\u4e2d' : '\u5df2\u5c55\u5f00';
      const priceText = fmtNum(lastPrice, 2);
      const preCloseText = fmtNum(preClose, 2);
      const delta = lastPrice !== null && Number.isFinite(preClose) ? lastPrice - preClose : null;
      const deltaText = delta === null ? '--' : (delta > 0 ? '+' : '') + delta.toFixed(2);
      return ''
        + '<div class="intraday-card">'
        +   '<div class="intraday-head">'
        +     '<span class="intraday-title">'
        +       '<span class="intraday-name">' + (series.name || r.name || code) + '</span>'
        +       '<span class="intraday-code">' + code + '</span>'
        +     '</span>'
        +     '<span class="intraday-stat">'
        +       '<span class="intraday-quote-main">'
        +         '<span class="intraday-quote-price ' + cls + '">' + priceText + '</span>'
        +         '<span class="intraday-quote-pct ' + cls + '">' + fmtSignedPct(changePct) + '</span>'
        +       '</span>'
        +       '<span class="intraday-quote-sub">'
        +         '<span>\u6628\u6536 ' + preCloseText + '</span>'
        +         '<span class="' + cls + '">\u6da8\u8dcc ' + deltaText + '</span>'
        +         '<span>' + openLabel + '</span>'
        +       '</span>'
        +     '</span>'
        +   '</div>'
        +   '<div class="intraday-chart-wrap">'
        +     '<canvas class="intraday-canvas" data-intraday-canvas="' + code + '"></canvas>'
        +     '<canvas class="intraday-overlay" data-intraday-overlay="' + code + '"></canvas>'
        +     '<div class="intraday-tooltip" data-intraday-tooltip="' + code + '"></div>'
        +   '</div>'
        +   '<div class="intraday-foot">'
        +     '<span>\u6574\u65e5\u4ea4\u6613\u65f6\u6bb5\u5c55\u793a ? ' + (hasAvg ? '\u84dd\u7ebf\u4e3a\u5747\u4ef7' : '\u6682\u65e0\u5747\u4ef7\u7ebf') + '</span>'
        +     '<span>' + new Date(series.updatedAt || Date.now()).toLocaleTimeString() + '</span>'
        +   '</div>'
        + '</div>';
    }

    function renderIntradayPanel() {
      const panel = document.getElementById('intradayPanel');
      const mount = document.getElementById('intradayMount');
      if (!panel || !mount) return;
      if (!intradayOpenCode) {
        panel.hidden = true;
        mount.replaceChildren();
        return;
      }
      const row = rows.find((it) => it.code === intradayOpenCode);
      if (!row) {
        panel.hidden = true;
        mount.replaceChildren();
        return;
      }
      panel.hidden = false;
      mount.innerHTML = buildIntradayContent(row);
      const canvas = mount.querySelector('canvas[data-intraday-canvas]');
      const series = intradaySeries.get(intradayOpenCode);
      if (canvas && series) {
        drawIntradayChart(canvas, series);
        wireIntradayHover(mount);
      }
    }

    function wireRowClick(tr, code) {
      tr.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('button')) return;
        vscode.postMessage({ type: 'openIntraday', code: code });
      });
      tr.addEventListener('mouseenter', () => {
        if (!tr._txTooltipDirty && tr.title) return;
        const row = tr._txRow;
        if (!row) return;
        tr.title = rowTooltipText(row);
        tr._txTooltipDirty = false;
      });
    }

    function buildActionTd(r) {
      const tdAct = document.createElement('td');
      tdAct.className = 'actions';
      const mkIcon = (title, type, code, svg) => {
        const b = document.createElement('button');
        b.className = 'secondary';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.innerHTML = svg;
        b.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: type, code: code }); });
        return b;
      };
      const chartBtn = document.createElement('button');
      chartBtn.className = 'secondary';
      chartBtn.title = '\u5c55\u5f00\u5206\u65f6\u9884\u89c8';
      chartBtn.setAttribute('aria-label', '\u5c55\u5f00\u5206\u65f6\u9884\u89c8');
      chartBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2.5 12.5h11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M3.5 10.5l2.5-2.5 2 1.6 4-4.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      chartBtn.classList.toggle('active', intradayOpenCode === r.code);
      chartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        intradayOpenCode = intradayOpenCode === r.code ? '' : r.code;
        intradayErrors.delete(r.code);
        if (intradayOpenCode === r.code) {
          intradayLoading.add(r.code);
          vscode.postMessage({ type: 'requestIntraday', code: r.code });
        }
        render();
      });
      tdAct.appendChild(chartBtn);
      tdAct.appendChild(
        mkIcon(
          '编辑持仓',
          'editPosition',
          r.code,
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M11.2 2.8l2 2L6 12H4v-2l7.2-7.2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M3.5 13.5h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        ),
      );
      tdAct.appendChild(
        mkIcon(
          '设置监听',
          'setAlert',
          r.code,
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 14c1 0 1.8-.8 1.8-1.8H6.2C6.2 13.2 7 14 8 14z" fill="currentColor"/><path d="M13 11.5H3c.7-.7 1-1.5 1-2.5V7c0-2.2 1.3-4 3.2-4.6V2c0-.4.3-.7.7-.7s.7.3.7.7v.4C10.7 3 12 4.8 12 7v2c0 1 .3 1.8 1 2.5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>',
        ),
      );
      tdAct.appendChild(
        mkIcon(
          '清理监听',
          'clearAlerts',
          r.code,
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 4l8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12 4L4 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
        ),
      );
      tdAct.appendChild(
        mkIcon(
          '清仓',
          'clearPosition',
          r.code,
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 4l8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12 4L4 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M3.5 13.5h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/></svg>',
        ),
      );
      tdAct.appendChild(
        mkIcon(
          '删除',
          'removeStock',
          r.code,
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 3h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M3.5 4.5h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M6 6.5v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M10 6.5v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M5 4.5l.6 9.2c.03.45.4.8.85.8h3.1c.45 0 .82-.35.85-.8L11 4.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
        ),
      );
      return tdAct;
    }

    function fillDataCells(tr, r) {
      const pctCls = clsForChange(r.changePct);
      const tds = tr.querySelectorAll('td');
      if (tds.length < 4) return;
      tds[0].textContent = r.name ?? '\u2014';
      tds[1].textContent = fmtNum(r.price, 2);
      tds[1].className = 'right';
      tds[2].textContent = fmtNum(r.changePct, 2);
      tds[2].className = 'right ' + pctCls;
      const chartBtn = tds[3] && tds[3].querySelector('button');
      if (chartBtn) {
        const expanded = intradayOpenCode === r.code;
        chartBtn.classList.toggle('active', expanded);
        chartBtn.title = expanded ? '\u6536\u8d77\u5206\u65f6\u9884\u89c8' : '\u5c55\u5f00\u5206\u65f6\u9884\u89c8';
        chartBtn.setAttribute('aria-label', chartBtn.title);
      }
      tr._txRow = r;
      tr._txTooltipDirty = true;
    }

    function createRow(r) {
      const tr = document.createElement('tr');
      tr.className = 'data-row';
      tr.setAttribute('data-code', r.code);
      for (let i = 0; i < 3; i++) {
        tr.appendChild(document.createElement('td'));
      }
      fillDataCells(tr, r);
      tr.appendChild(buildActionTd(r));
      wireRowClick(tr, r.code);
      return tr;
    }

    function render() {
      const tbody = document.getElementById('tbody');
      const wrap = document.getElementById('wrap');
      const empty = document.getElementById('empty');
      const meta = document.getElementById('meta');
      updateSortHeaders();

      if (rows.length === 0) {
        tbody.replaceChildren();
        empty.style.display = 'block';
        wrap.style.display = 'none';
      } else {
        empty.style.display = 'none';
        wrap.style.display = 'block';
        if (intradayOpenCode && !rows.some((r) => r.code === intradayOpenCode)) {
          intradayOpenCode = '';
        }
        const sorted = (skipSortOnce && !userSorted) ? rows.slice() : sortRows();
        skipSortOnce = false;
        const pool = new Map();
        tbody.querySelectorAll('tr[data-code]').forEach((tr) => {
          pool.set(tr.getAttribute('data-code'), tr);
        });
        const frag = document.createDocumentFragment();
        for (const r of sorted) {
          let tr = pool.get(r.code);
          if (tr) {
            fillDataCells(tr, r);
          } else {
            tr = createRow(r);
          }
          frag.appendChild(tr);
        }
        tbody.replaceChildren(frag);
      }
      renderIntradayPanel();

      meta.textContent = quotesLoading
        ? '行情加载中… · ' + new Date(lastUpdatedAt).toLocaleTimeString()
        : '更新：' + new Date(lastUpdatedAt).toLocaleString();
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'indices') {
        if (Array.isArray(msg.indices)) indices = msg.indices;
        if (typeof msg.indicesUpdatedAt === 'number') indicesUpdatedAt = msg.indicesUpdatedAt;
        renderIndicesLine();
        return;
      }
      if (msg.type === 'intradaySeriesLoading' && typeof msg.code === 'string') {
        intradayLoading.add(msg.code);
        intradayErrors.delete(msg.code);
        if (intradayOpenCode === msg.code) render();
        return;
      }
      if (msg.type === 'intradaySeries' && typeof msg.code === 'string') {
        intradayLoading.delete(msg.code);
        intradayErrors.delete(msg.code);
        if (msg.data) intradaySeries.set(msg.code, msg.data);
        if (intradayOpenCode === msg.code) render();
        return;
      }
      if (msg.type === 'intradaySeriesError' && typeof msg.code === 'string') {
        intradayLoading.delete(msg.code);
        intradayErrors.set(msg.code, msg.error || '\u5206\u65f6\u52a0\u8f7d\u5931\u8d25');
        if (intradayOpenCode === msg.code) render();
        return;
      }
      if (msg.type === 'update') {
        rows = msg.rows || [];
        groups = msg.groups || [];
        activeGroupId = msg.activeGroupId || '';
        turnoverDisplay = msg.turnoverDisplay || 'yi';
        quotesLoading = !!msg.quotesLoading;
        stealthMode = !!msg.stealthMode;
        lastUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : Date.now();
        if (Array.isArray(msg.indices)) indices = msg.indices;
        if (typeof msg.indicesUpdatedAt === 'number') indicesUpdatedAt = msg.indicesUpdatedAt;
        if (typeof msg.sortKey === 'string') sortKey = msg.sortKey;
        if (typeof msg.sortDir === 'number') sortDir = msg.sortDir;
        if (typeof msg.reason === 'string' && msg.reason.startsWith('init')) {
          skipSortOnce = true;
        }
      } else if (msg.type === 'patch') {
        applyPatch(msg.upserts || [], msg.removes || []);
        groups = msg.groups || groups;
        activeGroupId = msg.activeGroupId || activeGroupId;
        turnoverDisplay = msg.turnoverDisplay || turnoverDisplay;
        quotesLoading = !!msg.quotesLoading;
        stealthMode = !!msg.stealthMode;
        lastUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : Date.now();
        if (Array.isArray(msg.indices)) indices = msg.indices;
        if (typeof msg.indicesUpdatedAt === 'number') indicesUpdatedAt = msg.indicesUpdatedAt;
        if (typeof msg.sortKey === 'string') sortKey = msg.sortKey;
        if (typeof msg.sortDir === 'number') sortDir = msg.sortDir;
        if (typeof msg.reason === 'string' && msg.reason.startsWith('init')) {
          skipSortOnce = true;
        }
      } else {
        return;
      }

      fillGroupSelect();
      renderIndicesLine();
      document.body.classList.toggle('traderx-stealth-office', stealthMode);
      const err = document.getElementById('err');
      if (msg.error) {
        err.style.display = 'block';
        err.textContent = msg.error;
      } else {
        err.style.display = 'none';
        err.textContent = '';
      }
      render();
    });

    document.querySelectorAll('thead th[data-k]').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.getAttribute('data-k');
        if (!k) return;
        userSorted = true;
        if (sortKey === k) {
          sortDir *= -1;
        } else {
          sortKey = k;
          sortDir = 1;
        }
        vscode.postMessage({ type: 'setSort', sortKey: sortKey, sortDir: sortDir });
        render();
      });
    });

    // 初始化列宽与拖拽调整（含持久化）
    loadColumnWidths();
    setupResizableHeaders();

    window.addEventListener('resize', () => {
      const canvas = document.querySelector('#intradayMount canvas[data-intraday-canvas]');
      if (!canvas || !intradayOpenCode) return;
      const series = intradaySeries.get(intradayOpenCode);
      if (series) { drawIntradayChart(canvas, series); clearCrosshair(); }
    });

    document.getElementById('btnAdd').addEventListener('click', () => vscode.postMessage({ type: 'addStock' }));
    document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('groupSelect').addEventListener('change', () => {
      const sel = document.getElementById('groupSelect');
      const v = sel && sel.value ? String(sel.value) : '';
      vscode.postMessage({ type: 'selectGroup', groupId: v });
    });
    document.getElementById('btnGroupManage').addEventListener('click', () => vscode.postMessage({ type: 'openGroupManage' }));
    document.getElementById('btnGlobalSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  </script>
</body>
</html>`;
  }
}
