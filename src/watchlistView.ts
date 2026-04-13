import * as vscode from 'vscode';
import { QuoteService } from './services/quoteService';
import { WatchlistStore } from './storage/watchlistStore';
import type { NormalizedCode } from './stockCode';
import type { QuoteRow } from './types';

export class WatchlistViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'traderx.watchlistView';

  private view?: vscode.WebviewView;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private seq = 0;
  private registeredConfigListener = false;

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
            void this.postRows('config');
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
        prevClose: null,
        cost: pos?.cost,
        shares: pos?.shares,
        pnlYuan: null,
        pnlPct: null,
      };
    });
  }

  private async postRows(reason: string): Promise<void> {
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

    let full: QuoteRow[];
    try {
      full = await this.quoteService.enrichMainForce(codes, basic);
    } catch (e) {
      push({
        rows: basic,
        error: e instanceof Error ? e.message : String(e),
        quotesLoading: false,
        reasonSuffix: '-err-main',
      });
      return;
    }

    if (my !== this.seq) {
      return;
    }
    push({ rows: full, quotesLoading: false, reasonSuffix: '' });
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
      await this.refresh('remove');
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
      await this.refresh('copy');
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
      await this.refresh('move');
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
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }
    thead th {
      position: sticky;
      top: 0;
      background: var(--bg-header);
      border-bottom: 1px solid var(--border);
      text-align: left;
      padding: 6px 8px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
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
      padding: 6px 8px;
      white-space: nowrap;
    }
    tbody tr:hover td {
      background: var(--vscode-list-hoverBackground);
    }
    .right { text-align: right; }
    .cn-up { color: var(--vscode-charts-red, #f14c4c); }
    .cn-down { color: var(--vscode-charts-green, #3fb950); }
    /** 低调办公：整表灰度，隐藏涨跌红绿 */
    body.stealth-mode #wrap {
      filter: grayscale(1);
    }
    .actions button {
      margin-right: 6px;
      padding: 2px 6px;
      font-size: 11px;
    }
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
    details.reserve summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
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
      <thead>
        <tr>
          <th data-k="code">代码<span class="sort-ind" aria-hidden="true"></span></th>
          <th data-k="name">名称<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="price">现价<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="changePct">涨跌幅<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="mainNetInflowWan">主力净流入(万)<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="high">最高<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="low">最低<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="amountYuan">成交额<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="cost">成本<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="shares">持仓<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="pnlYuan">盈亏(元)<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="pnlPct">盈亏%<span class="sort-ind" aria-hidden="true"></span></th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

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
    let sortKey = 'code';
    let sortDir = 1;

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

    function sortRows() {
      const k = sortKey;
      const dir = sortDir;
      const arr = rows.slice();
      const val = (r) => {
        const map = {
          code: r.code,
          name: r.name,
          price: r.price,
          changePct: r.changePct,
          mainNetInflowWan: r.mainNetInflowWan,
          high: r.high,
          low: r.low,
          amountYuan: r.amountYuan,
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
      const mk = (label, type, code) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: type, code: code }); });
        return b;
      };
      tdAct.appendChild(mk('分时', 'openIntraday', r.code));
      tdAct.appendChild(mk('持仓', 'editPosition', r.code));
      tdAct.appendChild(mk('删', 'removeStock', r.code));
      tdAct.appendChild(mk('复制', 'copyStock', r.code));
      tdAct.appendChild(mk('移动', 'moveStock', r.code));
      return tdAct;
    }

    function fillDataCells(tr, r) {
      const pctCls = clsForChange(r.changePct);
      const pnlCls = clsForChange(r.pnlPct ?? null);
      const tds = tr.querySelectorAll('td');
      if (tds.length < 12) return;
      tds[0].textContent = r.code;
      tds[1].textContent = r.name ?? '—';
      tds[2].textContent = fmtNum(r.price, 2);
      tds[2].className = 'right';
      tds[3].textContent = fmtNum(r.changePct, 2);
      tds[3].className = 'right ' + pctCls;
      tds[4].textContent = fmtNum(r.mainNetInflowWan, 2);
      tds[4].className = 'right';
      tds[5].textContent = fmtNum(r.high, 2);
      tds[5].className = 'right';
      tds[6].textContent = fmtNum(r.low, 2);
      tds[6].className = 'right';
      tds[7].textContent = fmtAmountYuan(r.amountYuan);
      tds[7].className = 'right';
      tds[8].textContent = r.cost === undefined ? '—' : fmtNum(r.cost, 2);
      tds[8].className = 'right';
      tds[9].textContent = r.shares === undefined ? '—' : String(r.shares);
      tds[9].className = 'right';
      tds[10].textContent = r.pnlYuan === null || r.pnlYuan === undefined ? '—' : fmtNum(r.pnlYuan, 2);
      tds[10].className = 'right ' + pnlCls;
      tds[11].textContent = r.pnlPct === null || r.pnlPct === undefined ? '—' : fmtNum(r.pnlPct, 2);
      tds[11].className = 'right ' + pnlCls;
    }

    function createRow(r) {
      const tr = document.createElement('tr');
      tr.className = 'data-row';
      tr.setAttribute('data-code', r.code);
      for (let i = 0; i < 12; i++) {
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
        const sorted = sortRows();
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
      if (!msg || msg.type !== 'update') return;
      rows = msg.rows || [];
      groups = msg.groups || [];
      activeGroupId = msg.activeGroupId || '';
      turnoverDisplay = msg.turnoverDisplay || 'yi';
      quotesLoading = !!msg.quotesLoading;
      stealthMode = !!msg.stealthMode;
      lastUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : Date.now();
      if (typeof msg.sortKey === 'string') sortKey = msg.sortKey;
      if (typeof msg.sortDir === 'number') sortDir = msg.sortDir;
      fillGroupSelect();
      document.body.classList.toggle('stealth-mode', stealthMode);
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
