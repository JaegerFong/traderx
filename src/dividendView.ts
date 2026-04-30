import * as vscode from 'vscode';
import { DividendService } from './services/dividendService';
import { DividendStore } from './storage/dividendStore';
import type { NormalizedCode } from './stockCode';
import type { DividendRow } from './types';

export class DividendViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'traderx.dividendView';
  public static readonly viewIdPanel = 'traderx.dividendView.panel';

  private readonly webviews = new Set<vscode.WebviewView>();
  private registeredConfigListener = false;
  private isRefreshing = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: DividendStore,
    private readonly service: DividendService,
  ) {}

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
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postSnapshot('visible');
        // 后台懒刷新（非强制）
        void this.refresh(false, 'visible');
      }
    });

    if (!this.registeredConfigListener) {
      this.registeredConfigListener = true;
      this.ctx.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration('traderx.dividend') || e.affectsConfiguration('traderx.turnoverDisplay')) {
            this.postSnapshot('config');
          }
        }),
      );
    }

    this.postSnapshot('init');
    void this.refresh(false, 'init');
  }

  public dispose(): void {
    this.webviews.clear();
  }

  /**
   * 触发刷新：force=true 强制忽略 TTL；本身在网络期间允许多次合并
   */
  public async refresh(force: boolean, reason = 'manual'): Promise<void> {
    if (this.isRefreshing && !force) {
      return;
    }
    this.isRefreshing = true;
    this.postSnapshot(`${reason}-loading`, true);
    try {
      await this.service.refreshAll(force);
    } catch (e) {
      // 网络层错误不应让整个面板崩溃；service 内部已对每只股票兜底，这里仅记录
      const msg = e instanceof Error ? e.message : String(e);
      this.postSnapshot(`${reason}-err`, false, msg);
      this.isRefreshing = false;
      return;
    }
    this.postSnapshot(reason, false);
    this.isRefreshing = false;
  }

  /** 添加新股票时增量刷新该行 */
  public async addOneIncremental(code: NormalizedCode): Promise<void> {
    this.postSnapshot('addStock-skeleton', true);
    try {
      await this.service.refreshOne(code, true);
    } catch {
      // service 内部已记录错误
    }
    this.postSnapshot('addStock', false);
  }

  /** 移除股票后立即推送 */
  public async removeOneIncremental(_code: NormalizedCode): Promise<void> {
    await this.service.pruneCache();
    this.postSnapshot('removeStock', false);
  }

  /** 持仓变更后重算估算（无需重新拉网络） */
  public refreshEstimateOnly(_code: NormalizedCode): void {
    this.postSnapshot('editPosition', false);
  }

  private postSnapshot(reason: string, loading = false, error?: string): void {
    if (this.webviews.size === 0) {
      return;
    }
    const cfg = this.service.getConfig();
    const rows = this.service.getRowsFromCache();
    const lastRefreshAt = this.store.getLastRefreshAt();
    const sort = this.store.getSort();
    const payload = {
      type: 'update',
      reason,
      rows,
      loading,
      error,
      sortKey: sort.key,
      sortDir: sort.dir,
      yearAttribution: cfg.yearAttribution,
      showAfterTax: cfg.showAfterTax,
      taxRate: cfg.taxRate,
      lastRefreshAt,
    };
    for (const wv of this.webviews) {
      void wv.webview.postMessage(payload);
    }
  }

  private async onMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type;
    if (type === 'addStock') {
      await vscode.commands.executeCommand('traderx.dividend.addStock');
      return;
    }
    if (type === 'removeStock' && typeof msg.code === 'string') {
      await this.store.removeCode(msg.code as NormalizedCode);
      await this.removeOneIncremental(msg.code as NormalizedCode);
      vscode.window.showInformationMessage(`已从股息关注移除：${msg.code}`);
      return;
    }
    if (type === 'refresh') {
      await this.refresh(true, 'webview');
      return;
    }
    if (type === 'openDetail' && typeof msg.code === 'string') {
      await vscode.commands.executeCommand('traderx.dividend.openDetail', msg.code);
      return;
    }
    if (type === 'editHolding' && typeof msg.code === 'string') {
      await vscode.commands.executeCommand('traderx.dividend.editHolding', msg.code);
      return;
    }
    if (type === 'openSettings') {
      await vscode.commands.executeCommand('traderx.openSettings');
      return;
    }
    if (type === 'setSort' && typeof msg.sortKey === 'string' && typeof msg.sortDir === 'number') {
      await this.store.setSort({ key: msg.sortKey, dir: msg.sortDir === -1 ? -1 : 1 });
      this.postSnapshot('setSort');
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
  <title>TraderX 股息</title>
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
    .bar-row .flex-grow { flex: 1; min-width: 0; }
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
    .meta { color: var(--muted); font-size: 11px; }
    .meta-line { display: flex; justify-content: space-between; align-items: center; margin: 2px 0 8px; gap: 8px; }
    .error { color: var(--vscode-errorForeground); margin: 6px 0; white-space: pre-wrap; }
    .config-line { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; color: var(--muted); font-size: 11px; }
    .config-line .badge {
      padding: 2px 6px;
      border-radius: 2px;
      background: var(--bg-header);
      border: 1px solid var(--border);
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
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--bg-header);
      border-bottom: 1px solid var(--border);
      text-align: left;
      padding: 6px 8px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    thead th .sort-ind {
      display: inline-block;
      min-width: 1.1em;
      font-size: 10px;
      line-height: 1;
      opacity: 0.4;
      margin-left: 3px;
      vertical-align: middle;
    }
    thead th.sort-active { font-weight: 600; }
    thead th.sort-active .sort-ind { opacity: 1; }
    tbody td {
      border-bottom: 1px solid var(--border);
      padding: 4px 8px;
      white-space: nowrap;
    }
    tbody tr.data-row { cursor: pointer; }
    tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
    .right { text-align: right; }
    .actions { white-space: nowrap; }
    .actions button {
      margin-right: 4px;
      padding: 2px 6px;
      font-size: 11px;
      width: 26px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .actions button svg { display: block; }
    .empty { padding: 16px; color: var(--muted); }
    .status-tag {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 2px;
      border: 1px solid var(--border);
      font-size: 11px;
      color: var(--muted);
    }
    .status-implemented { color: var(--vscode-charts-blue, #4c8dff); border-color: color-mix(in srgb, var(--vscode-charts-blue, #4c8dff) 35%, transparent); }
    .status-plan { color: var(--vscode-charts-yellow, #d6a14b); border-color: color-mix(in srgb, var(--vscode-charts-yellow, #d6a14b) 35%, transparent); }
    .row-err {
      color: var(--vscode-errorForeground);
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div class="bar-row">
    <span class="meta" style="flex-shrink:0;font-weight:600;">股息关注</span>
    <div class="flex-grow"></div>
    <button type="button" class="icon-btn" id="btnAdd" title="添加股息关注" aria-label="添加股息关注">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <button type="button" class="icon-btn secondary" id="btnRefresh" title="强制刷新（忽略缓存）" aria-label="强制刷新">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13 6a6 6 0 00-9.9-3.5M3 10a6 6 0 009.9 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12 2v4h-4M4 14v-4h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button type="button" class="icon-btn secondary" id="btnSettings" title="全局设置" aria-label="全局设置">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6L3.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
    </button>
  </div>

  <div class="config-line" id="configLine"></div>
  <div class="meta-line"><span class="meta" id="meta"></span></div>
  <div class="error" id="err" style="display:none"></div>
  <div id="empty" class="empty" style="display:none">暂无股息关注。点击「+」添加。</div>
  <div class="table-wrap" id="wrap" style="display:none">
    <table>
      <thead>
        <tr>
          <th data-k="name">名称<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="last1y">近1年(元/股)<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="last3y">近3年(元/股)<span class="sort-ind" aria-hidden="true"></span></th>
          <th class="right" data-k="estAnnual">年度估算(元)<span class="sort-ind" aria-hidden="true"></span></th>
          <th data-k="nextEventDate">下一事件<span class="sort-ind" aria-hidden="true"></span></th>
          <th data-k="status">状态<span class="sort-ind" aria-hidden="true"></span></th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    /** @type {any[]} */
    let rows = [];
    let loading = false;
    let lastRefreshAt = 0;
    let yearAttribution = 'payYear';
    let showAfterTax = false;
    let taxRate = 0.1;
    let sortKey = 'name';
    let sortDir = 1;
    let userSorted = false;

    function fmtNum(n, digits) {
      if (n === null || n === undefined || Number.isNaN(n)) return '—';
      return Number(n).toFixed(digits);
    }

    function fmtYuan(n) {
      if (n === null || n === undefined || Number.isNaN(n)) return '—';
      const v = Number(n);
      if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿';
      if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + '万';
      return v.toFixed(2);
    }

    function attrLabel(a) {
      if (a === 'recordYear') return '按登记年';
      if (a === 'announceYear') return '按公告年';
      return '按派息年';
    }

    function statusLabel(s) {
      if (s === 'implemented') return '实施';
      if (s === 'plan') return '预案/待实施';
      if (s === 'unknown') return '—';
      return '—';
    }

    function statusClass(s) {
      if (s === 'implemented') return 'status-tag status-implemented';
      if (s === 'plan') return 'status-tag status-plan';
      return 'status-tag';
    }

    function sortRows() {
      const arr = rows.slice();
      const k = sortKey;
      const dir = sortDir;
      const val = (r) => {
        switch (k) {
          case 'name': return r.name;
          case 'last1y': return r.last1yCashPerShare;
          case 'last3y': return r.last3yCashPerShare;
          case 'estAnnual': return r.estAnnualYuan;
          case 'nextEventDate': return r.nextEventDate;
          case 'status': return r.nextEventStatus;
          default: return r.name;
        }
      };
      arr.sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        const na = va === null || va === undefined ? null : va;
        const nb = vb === null || vb === undefined ? null : vb;
        if (na === null && nb === null) return 0;
        if (na === null) return 1;
        if (nb === null) return -1;
        if (typeof na === 'string' || typeof nb === 'string') {
          return String(na).localeCompare(String(nb), 'zh-CN') * dir;
        }
        return (Number(na) - Number(nb)) * dir;
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

    function render() {
      const tbody = document.getElementById('tbody');
      const wrap = document.getElementById('wrap');
      const empty = document.getElementById('empty');
      const meta = document.getElementById('meta');
      const cfgLine = document.getElementById('configLine');
      updateSortHeaders();

      cfgLine.replaceChildren();
      const b1 = document.createElement('span');
      b1.className = 'badge';
      b1.textContent = attrLabel(yearAttribution);
      const b2 = document.createElement('span');
      b2.className = 'badge';
      b2.textContent = showAfterTax ? '估算·税后(' + (taxRate * 100).toFixed(0) + '%)' : '估算·税前';
      cfgLine.appendChild(b1);
      cfgLine.appendChild(b2);

      if (rows.length === 0) {
        tbody.replaceChildren();
        empty.style.display = 'block';
        wrap.style.display = 'none';
      } else {
        empty.style.display = 'none';
        wrap.style.display = 'block';
        const sorted = userSorted ? sortRows() : rows.slice();
        const frag = document.createDocumentFragment();
        for (const r of sorted) {
          frag.appendChild(buildRow(r));
        }
        tbody.replaceChildren(frag);
      }

      const lastStr = lastRefreshAt ? new Date(lastRefreshAt).toLocaleString() : '—';
      meta.textContent = (loading ? '加载中… · ' : '上次刷新：') + lastStr;
    }

    function buildRow(r) {
      const tr = document.createElement('tr');
      tr.className = 'data-row';
      tr.setAttribute('data-code', r.code);
      const tdName = document.createElement('td');
      const nameDiv = document.createElement('div');
      nameDiv.textContent = r.name || r.code;
      tdName.appendChild(nameDiv);
      const sub = document.createElement('div');
      sub.className = 'meta';
      sub.textContent = r.code + (r.shares ? ' · 持仓 ' + r.shares + ' 股' : '');
      tdName.appendChild(sub);
      if (r.error) {
        const e = document.createElement('div');
        e.className = 'row-err';
        e.textContent = '数据异常：' + r.error;
        tdName.appendChild(e);
      }
      tr.appendChild(tdName);

      const td1 = document.createElement('td');
      td1.className = 'right';
      td1.textContent = fmtNum(r.last1yCashPerShare, 4);
      tr.appendChild(td1);

      const td3 = document.createElement('td');
      td3.className = 'right';
      td3.textContent = fmtNum(r.last3yCashPerShare, 4);
      tr.appendChild(td3);

      const tdEst = document.createElement('td');
      tdEst.className = 'right';
      tdEst.textContent = fmtYuan(r.estAnnualYuan);
      if (r.estAnnualYuan === null && (!r.shares || r.shares <= 0)) {
        tdEst.title = '未录入持仓股数（在自选中编辑成本与持仓后将自动估算）';
      }
      tr.appendChild(tdEst);

      const tdDate = document.createElement('td');
      tdDate.textContent = r.nextEventDate || '—';
      tr.appendChild(tdDate);

      const tdStatus = document.createElement('td');
      const tag = document.createElement('span');
      tag.className = statusClass(r.nextEventStatus);
      tag.textContent = statusLabel(r.nextEventStatus);
      tdStatus.appendChild(tag);
      tr.appendChild(tdStatus);

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
      tdAct.appendChild(
        mkIcon(
          '编辑持仓',
          'editHolding',
          r.code,
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M11.2 2.8l2 2L6 12H4v-2l7.2-7.2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M3.5 13.5h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        ),
      );
      tdAct.appendChild(
        mkIcon(
          '移除',
          'removeStock',
          r.code,
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 3h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M3.5 4.5h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M6 6.5v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M10 6.5v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M5 4.5l.6 9.2c.03.45.4.8.85.8h3.1c.45 0 .82-.35.85-.8L11 4.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
        ),
      );
      tr.appendChild(tdAct);

      tr.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('button')) return;
        vscode.postMessage({ type: 'openDetail', code: r.code });
      });
      return tr;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'update') return;
      rows = Array.isArray(msg.rows) ? msg.rows : [];
      loading = !!msg.loading;
      lastRefreshAt = typeof msg.lastRefreshAt === 'number' ? msg.lastRefreshAt : 0;
      yearAttribution = typeof msg.yearAttribution === 'string' ? msg.yearAttribution : 'payYear';
      showAfterTax = !!msg.showAfterTax;
      taxRate = typeof msg.taxRate === 'number' ? msg.taxRate : 0.1;
      if (typeof msg.sortKey === 'string') sortKey = msg.sortKey;
      if (typeof msg.sortDir === 'number') sortDir = msg.sortDir;
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

    document.getElementById('btnAdd').addEventListener('click', () => vscode.postMessage({ type: 'addStock' }));
    document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('btnSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  </script>
</body>
</html>`;
  }
}
