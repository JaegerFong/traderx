import * as vscode from 'vscode';
import type { NormalizedCode } from './stockCode';
import { DividendService } from './services/dividendService';
import type { DividendEvent, DividendYearAttribution, DividendYearlySummary } from './types';

interface PanelRecord {
  panel: vscode.WebviewPanel;
  code: NormalizedCode;
  lastActiveAt: number;
}

const panels = new Map<NormalizedCode, PanelRecord>();
const MAX_RETAINED = 3;

function disposeStaleHidden(): void {
  if (panels.size < MAX_RETAINED) {
    return;
  }
  const hidden = Array.from(panels.entries())
    .filter(([, rec]) => !rec.panel.visible && !rec.panel.active)
    .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
  while (panels.size >= MAX_RETAINED && hidden.length > 0) {
    const victim = hidden.shift();
    if (!victim) {
      break;
    }
    victim[1].panel.dispose();
  }
}

interface PushPayload {
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
  loading?: boolean;
}

function pushDetail(panel: vscode.WebviewPanel, payload: PushPayload): void {
  void panel.webview.postMessage({ type: 'data', payload });
}

export function openDividendDetailPanel(
  context: vscode.ExtensionContext,
  service: DividendService,
  code: NormalizedCode,
): void {
  const existing = panels.get(code);
  if (existing) {
    existing.lastActiveAt = Date.now();
    existing.panel.reveal(vscode.ViewColumn.One);
    pushDetail(existing.panel, buildPayload(service, code));
    return;
  }
  disposeStaleHidden();

  const panel = vscode.window.createWebviewPanel(
    'traderx.dividendDetail',
    `股息详情 · ${code}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [context.extensionUri],
    },
  );
  const rec: PanelRecord = { panel, code, lastActiveAt: Date.now() };
  panels.set(code, rec);

  panel.onDidDispose(() => {
    panels.delete(code);
  });
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.visible || e.webviewPanel.active) {
      rec.lastActiveAt = Date.now();
    }
  });
  panel.webview.onDidReceiveMessage(async (msg) => {
    const t = (msg as { type?: string } | undefined)?.type;
    if (t === 'ready') {
      pushDetail(panel, buildPayload(service, code));
      return;
    }
    if (t === 'refresh') {
      pushDetail(panel, { ...buildPayload(service, code), loading: true });
      try {
        await service.refreshOne(code, true);
      } catch {
        // service 内部已记录错误
      }
      pushDetail(panel, buildPayload(service, code));
      return;
    }
    if (t === 'editHolding') {
      await vscode.commands.executeCommand('traderx.dividend.editHolding', code);
      pushDetail(panel, buildPayload(service, code));
      return;
    }
  });

  const nonce = String(Math.random()).slice(2);
  panel.webview.html = buildHtml(panel.webview, nonce, code);
  panel.title = `股息详情 · ${code}`;
}

function buildPayload(service: DividendService, code: NormalizedCode): PushPayload {
  const detail = service.getDetail(code);
  return {
    code: detail.code,
    name: detail.name,
    events: detail.events,
    yearly: detail.yearly,
    estimate: detail.estimate,
    yearAttribution: detail.yearAttribution,
    fetchedAt: detail.fetchedAt,
    error: detail.error,
  };
}

function buildHtml(webview: vscode.Webview, nonce: string, code: NormalizedCode): string {
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
  <title>股息详情 · ${escapeHtml(code)}</title>
  <style>
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      line-height: 1.5;
    }
    h2 { margin: 0 0 4px; font-size: 14px; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .bar { display: flex; align-items: center; gap: 8px; margin: 4px 0 12px; flex-wrap: wrap; }
    .bar .grow { flex: 1; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid transparent;
      border-radius: 2px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .err {
      color: var(--vscode-errorForeground);
      margin: 6px 0;
      padding: 8px 10px;
      border-radius: 4px;
      background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #4f1f1f) 30%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 24%, transparent);
    }
    section { margin-bottom: 18px; }
    section h3 { font-size: 12px; margin: 0 0 6px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .06em; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 8px;
    }
    .summary-card {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
      border-radius: 4px;
      padding: 8px 10px;
      background: var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04));
    }
    .summary-card .k { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .summary-card .v { font-size: 13px; font-weight: 600; }
    .summary-card .sub { color: var(--vscode-descriptionForeground); font-size: 11px; }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
      border-radius: 4px;
      overflow: hidden;
    }
    th, td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    th {
      background: var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04));
      font-weight: 600;
    }
    td.right, th.right { text-align: right; font-variant-numeric: tabular-nums; }
    .status-tag {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 2px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .status-implemented { color: var(--vscode-charts-blue, #4c8dff); border-color: color-mix(in srgb, var(--vscode-charts-blue, #4c8dff) 35%, transparent); }
    .status-plan { color: var(--vscode-charts-yellow, #d6a14b); border-color: color-mix(in srgb, var(--vscode-charts-yellow, #d6a14b) 35%, transparent); }
    .fallback-mark {
      display: inline-block;
      margin-left: 4px;
      padding: 0 4px;
      border-radius: 2px;
      background: color-mix(in srgb, var(--vscode-charts-yellow, #d6a14b) 18%, transparent);
      color: var(--vscode-charts-yellow, #d6a14b);
      font-size: 10px;
    }
    .empty { color: var(--vscode-descriptionForeground); padding: 12px; }
  </style>
</head>
<body>
  <h2 id="title">股息详情 · ${escapeHtml(code)}</h2>
  <div class="muted" id="subtitle"></div>
  <div class="bar">
    <div class="grow"></div>
    <button class="secondary" type="button" id="btnEdit">编辑持仓…</button>
    <button type="button" id="btnRefresh">强制刷新</button>
  </div>
  <div id="err" class="err" style="display:none"></div>

  <section>
    <h3>估算（基于持仓）</h3>
    <div class="summary-grid" id="estCards"></div>
  </section>

  <section>
    <h3>年度汇总（<span id="attrLabel">按派息年</span>）</h3>
    <div id="yearlyWrap"></div>
  </section>

  <section>
    <h3>事件明细</h3>
    <div id="eventsWrap"></div>
  </section>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function fmtNum(n, d) {
      if (n === null || n === undefined || Number.isNaN(n)) return '—';
      return Number(n).toFixed(d);
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
      return '—';
    }
    function statusClass(s) {
      if (s === 'implemented') return 'status-tag status-implemented';
      if (s === 'plan') return 'status-tag status-plan';
      return 'status-tag';
    }

    function renderCards(p) {
      const root = document.getElementById('estCards');
      const cards = [];
      const sharesText = p.estimate.shares !== undefined && p.estimate.shares !== null
        ? p.estimate.shares + ' 股'
        : '未录入';
      const cps = p.estimate.perShareLast1y;
      const ann = p.estimate.annualEstYuan;
      cards.push({
        k: '持仓股数',
        v: sharesText,
        sub: '复用自选持仓',
      });
      cards.push({
        k: '近 1 年现金分红',
        v: cps === null ? '—' : fmtNum(cps, 4) + ' 元/股（税前）',
        sub: '已实施合计',
      });
      const annLabel = p.estimate.afterTax ? '税后估算（' + (p.estimate.taxRate * 100).toFixed(0) + '%）' : '税前估算';
      cards.push({
        k: '年度估算',
        v: ann === null ? '—' : fmtYuan(ann) + ' 元',
        sub: annLabel,
      });
      root.replaceChildren();
      for (const c of cards) {
        const div = document.createElement('div');
        div.className = 'summary-card';
        div.innerHTML = '<div class="k">' + esc(c.k) + '</div><div class="v">' + esc(c.v) + '</div><div class="sub">' + esc(c.sub) + '</div>';
        root.appendChild(div);
      }
    }

    function renderYearly(p) {
      const root = document.getElementById('yearlyWrap');
      document.getElementById('attrLabel').textContent = attrLabel(p.yearAttribution);
      if (!Array.isArray(p.yearly) || p.yearly.length === 0) {
        root.innerHTML = '<div class="empty">暂无已实施分红年度数据。</div>';
        return;
      }
      const rows = p.yearly.map((y) => {
        const fb = y.fallback ? '<span class="fallback-mark" title="该年使用了降级口径（首选日期缺失，回退到 ex/record/announce）">降级</span>' : '';
        return '<tr><td>' + esc(y.year) + fb + '</td><td class="right">' + fmtNum(y.cashPerShare, 4) + '</td><td class="right">' + esc(y.count) + '</td></tr>';
      }).join('');
      root.innerHTML = '<table><thead><tr><th>年度</th><th class="right">累计现金分红(元/股，税前)</th><th class="right">事件数</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function renderEvents(p) {
      const root = document.getElementById('eventsWrap');
      if (!Array.isArray(p.events) || p.events.length === 0) {
        root.innerHTML = '<div class="empty">暂无事件明细。可能是数据未拉取或该股无分红记录。</div>';
        return;
      }
      const rows = p.events.map((ev) => {
        const cps = (typeof ev.cashPerShare === 'number') ? ev.cashPerShare
          : (typeof ev.cashPer10Shares === 'number' ? ev.cashPer10Shares / 10 : null);
        const per10 = (typeof ev.cashPer10Shares === 'number') ? ev.cashPer10Shares : (cps !== null ? cps * 10 : null);
        const bonus = (typeof ev.bonusPer10Shares === 'number' && ev.bonusPer10Shares > 0) ? ('送 ' + ev.bonusPer10Shares + '/10') : '';
        const trans = (typeof ev.transferPer10Shares === 'number' && ev.transferPer10Shares > 0) ? ('转 ' + ev.transferPer10Shares + '/10') : '';
        const extra = [bonus, trans].filter(Boolean).join(' · ');
        return '<tr>'
          + '<td>' + esc(ev.reportDate || '—') + '</td>'
          + '<td>' + esc(ev.announceDate || '—') + '</td>'
          + '<td>' + esc(ev.recordDate || '—') + '</td>'
          + '<td>' + esc(ev.exDate || '—') + '</td>'
          + '<td>' + esc(ev.payDate || '—') + '</td>'
          + '<td class="right">' + (per10 === null ? '—' : fmtNum(per10, 4)) + '</td>'
          + '<td class="right">' + (cps === null ? '—' : fmtNum(cps, 4)) + '</td>'
          + '<td>' + esc(extra || '—') + '</td>'
          + '<td><span class="' + statusClass(ev.status) + '">' + statusLabel(ev.status) + '</span></td>'
          + '</tr>';
      }).join('');
      root.innerHTML = '<table><thead><tr><th>报告期</th><th>公告日</th><th>登记日</th><th>除权日</th><th>派息日</th><th class="right">每10股(元)</th><th class="right">每股(元)</th><th>送转</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function render(p) {
      const sub = (p.name ? p.name + ' · ' : '') + p.code
        + ' · ' + (p.fetchedAt ? '更新于 ' + new Date(p.fetchedAt).toLocaleString() : '未刷新');
      document.getElementById('subtitle').textContent = sub + (p.loading ? '（加载中…）' : '');
      const err = document.getElementById('err');
      if (p.error) {
        err.style.display = 'block';
        err.textContent = '数据异常：' + p.error + '（仅展示已缓存内容）';
      } else {
        err.style.display = 'none';
        err.textContent = '';
      }
      renderCards(p);
      renderYearly(p);
      renderEvents(p);
    }

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || m.type !== 'data') return;
      render(m.payload || {});
    });

    document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('btnEdit').addEventListener('click', () => vscode.postMessage({ type: 'editHolding' }));

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
