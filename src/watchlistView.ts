import * as vscode from 'vscode';
import { isCnAshareAutoRefreshWindow } from './marketHours';
import { QuoteService } from './services/quoteService';
import { WatchlistStore } from './storage/watchlistStore';
import type { NormalizedCode } from './stockCode';
import type { QuoteRow } from './types';
import { fetchEastmoneyMainForceOne, mapLimit } from './providers/eastmoney';
import { STEALTH_OFFICE_STYLE_SNIPPET } from './stealthOfficeWebview';

export class WatchlistViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'traderx.watchlistView';

  private view?: vscode.WebviewView;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private seq = 0;
  private registeredConfigListener = false;
  private rowCache = new Map<string, QuoteRow>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: WatchlistStore,
    private readonly quoteService: QuoteService,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
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
      this.clearRefreshTimer();
      this.view = undefined;
    });

    webviewView.onDidChangeVisibility(() => {
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
    const sec = vscode.workspace.getConfiguration('traderx').get<number>('refreshIntervalSeconds') ?? 3;
    const ms = Math.max(3000, Math.min(300_000, sec * 1000));
    this.refreshTimer = setInterval(() => {
      void this.postRows('timer');
    }, ms);
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

    this.view?.webview.postMessage({
      type: 'update',
      reason,
      rows,
      turnoverDisplay,
      updatedAt: Date.now(),
      groups,
      activeGroupId: gid,
      quotesLoading: false,
      stealthMode,
      sortKey: sort.key,
      sortDir: sort.dir,
    });
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
      this.view?.webview.postMessage({
        type: 'update',
        reason: reason + payload.reasonSuffix,
        rows: payload.rows,
        turnoverDisplay,
        error: payload.error,
        updatedAt: Date.now(),
        groups,
        activeGroupId: gid,
        quotesLoading: payload.quotesLoading,
        stealthMode,
        sortKey: sort.key,
        sortDir: sort.dir,
      });
    };

    if (!quietRefresh && codes.length > 0) {
      push({ rows: this.buildSkeletonRows(codes, positions), quotesLoading: true, reasonSuffix: '-skeleton' });
    }

    if (codes.length === 0) {
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

    if (my !== this.seq) {
      return;
    }

    // 主力净流入后台并发补齐：每拿到一只就 patch 该行
    void this.enrichMainForceStreaming(codes, basic, my);
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
    this.view?.webview.postMessage({
      type: 'patch',
      reason: payload.reason,
      upserts: payload.upserts ?? [],
      removes: payload.removes ?? [],
      quotesLoading: !!payload.quotesLoading,
      error: payload.error,
      updatedAt: Date.now(),
      groups: snap.groups,
      activeGroupId: snap.activeGroupId,
      turnoverDisplay: snap.turnoverDisplay,
      stealthMode: snap.stealthMode,
      sortKey: snap.sortKey,
      sortDir: snap.sortDir,
    });
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
    if (type === 'editPosition' && typeof msg.code === 'string') {
      await vscode.commands.executeCommand('traderx.editPosition', msg.code);
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
      --freeze-w4: 104px;
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
      border: 1px dashed var(--border);
      border-radius: 4px;
      padding: 8px;
      color: var(--muted);
    }
    details.reserve:first-of-type {
      margin-top: 0;
    }
    details.reserve summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

  </style>
</head>
<body>
  <div class="traderx-stealth-scrim" aria-hidden="true"></div>
  <div class="traderx-stealth-inner">
  <details class="reserve" id="watchlistDetails">
    <summary>自选栏</summary>
    <div class="watchlist-body">
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
            <col style="width:104px" />
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
    let quotesLoading = false;
    let stealthMode = false;
    let turnoverDisplay = 'yi';
    let sortKey = 'name';
    let sortDir = 1;
    let userSorted = false;
    let skipSortOnce = true;

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

    function wireRowClick(tr, code) {
      tr.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('button')) return;
        vscode.postMessage({ type: 'openIntraday', code: code });
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
      // 分时：保留“点击整行打开分时”，不在操作栏占按钮位
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
          '清仓（清空成本/持仓）',
          'clearPosition',
          r.code,
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 4l8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12 4L4 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M3.5 13.5h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/></svg>',
        ),
      );
      // 删除放最后
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
      tds[0].textContent = r.name ?? '—';
      tds[1].textContent = fmtNum(r.price, 2);
      tds[1].className = 'right';
      tds[2].textContent = fmtNum(r.changePct, 2);
      tds[2].className = 'right ' + pctCls;
      tr.title = rowTooltipText(r);
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
            const oldAct = tr.querySelector('td.actions');
            if (oldAct) oldAct.replaceWith(buildActionTd(r));
          } else {
            tr = createRow(r);
          }
          frag.appendChild(tr);
        }
        tbody.replaceChildren(frag);
      }

      meta.textContent = quotesLoading
        ? '行情加载中… · ' + new Date(lastUpdatedAt).toLocaleTimeString()
        : '更新：' + new Date(lastUpdatedAt).toLocaleString();
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'update') {
        rows = msg.rows || [];
        groups = msg.groups || [];
        activeGroupId = msg.activeGroupId || '';
        turnoverDisplay = msg.turnoverDisplay || 'yi';
        quotesLoading = !!msg.quotesLoading;
        stealthMode = !!msg.stealthMode;
        lastUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : Date.now();
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
        if (typeof msg.sortKey === 'string') sortKey = msg.sortKey;
        if (typeof msg.sortDir === 'number') sortDir = msg.sortDir;
        if (typeof msg.reason === 'string' && msg.reason.startsWith('init')) {
          skipSortOnce = true;
        }
      } else {
        return;
      }

      fillGroupSelect();
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

    document.getElementById('btnAdd').addEventListener('click', () => vscode.postMessage({ type: 'addStock' }));
    document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('groupSelect').addEventListener('change', (e) => {
      const v = e.target.value;
      vscode.postMessage({ type: 'selectGroup', groupId: v });
    });
    document.getElementById('btnGroupManage').addEventListener('click', () => vscode.postMessage({ type: 'openGroupManage' }));
    document.getElementById('btnGlobalSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  </script>
</body>
</html>`;
  }
}
