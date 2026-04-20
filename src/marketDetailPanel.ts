import * as vscode from 'vscode';
import { fetchIndustryMoneyRankSina } from './providers/sinaIndustryMoneyRank';
import { fetchSinaStockMoneyRank, fetchSinaStockMoneyTrend } from './providers/sinaStockMoneyFlow';
import { fetchTencentGlobalIndices } from './providers/tencentGlobalIndices';
import { fetchTencentIndustryRank } from './providers/tencentIndustryRank';
import type { MarketOpenPayload } from './marketNavigatorTree';
// 指数分时用 Simple Browser 顶层打开更稳定（避免 Webview iframe 被拦截）
import {
  isStealthOfficeEnabled,
  STEALTH_OFFICE_STYLE_SNIPPET,
  stealthOfficeBodyAttrs,
  stealthOfficeContentWrap,
} from './stealthOfficeWebview';

function getTimeoutMs(): number {
  const raw = vscode.workspace.getConfiguration('traderx').get<number>('marketFetchTimeoutMs');
  const n = typeof raw === 'number' ? raw : 15000;
  return Math.max(5000, Math.min(120_000, n));
}

function panelTitle(payload: MarketOpenPayload): string {
  switch (payload.kind) {
    case 'globalIndex':
      return '全球指数';
    case 'industryRise':
      return '行业涨幅排名';
    case 'industryMoney':
      return payload.title;
    case 'stockMoneyRank':
      return `个股资金 · ${payload.title}`;
    case 'stockMoneyTrend':
      return '个股按日资金流向';
    default:
      return '市场行情';
  }
}

const marketPanels = new Map<string, { panel: vscode.WebviewPanel; payload: MarketOpenPayload; lastActiveAt: number }>();
const MAX_RETAINED_MARKET_PANELS = 3;

export function openMarketPage(context: vscode.ExtensionContext, payload: MarketOpenPayload): void {
  if (payload.kind === 'indexKline') {
    void (async () => {
      const url = payload.intradayUrl ?? payload.url;
      try {
        await vscode.commands.executeCommand('simpleBrowser.show', url);
      } catch {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    })();
    return;
  }

  const key = `detail:${payload.kind}:${JSON.stringify(payload)}`;
  const existing = marketPanels.get(key);
  if (existing) {
    existing.payload = payload;
    existing.lastActiveAt = Date.now();
    existing.panel.title = panelTitle(payload);
    existing.panel.reveal(vscode.ViewColumn.One);
  } else {
    disposeStaleHiddenMarketPanels();
    const panel = vscode.window.createWebviewPanel(
      'traderx.marketDetail',
      panelTitle(payload),
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [context.extensionUri] },
    );
    marketPanels.set(key, { panel, payload, lastActiveAt: Date.now() });
    panel.onDidDispose(() => {
      marketPanels.delete(key);
    });
    panel.onDidChangeViewState((e) => {
      const rec = marketPanels.get(key);
      if (!rec) {
        return;
      }
      if (e.webviewPanel.visible || e.webviewPanel.active) {
        rec.lastActiveAt = Date.now();
      }
    });
    panel.webview.onDidReceiveMessage((m) => {
      const rec = marketPanels.get(key);
      if (!rec) {
        return;
      }
      void pushMarketMessage(rec.panel.webview, rec.payload, m as Record<string, unknown>);
    });
  }

  const rec = marketPanels.get(key)!;
  const nonce = String(Math.random()).slice(2);
  rec.panel.webview.html = buildHtml(rec.panel.webview, nonce, payload);
}

function disposeStaleHiddenMarketPanels(): void {
  if (marketPanels.size < MAX_RETAINED_MARKET_PANELS) {
    return;
  }
  const hidden = Array.from(marketPanels.entries())
    .filter(([, rec]) => !rec.panel.visible && !rec.panel.active)
    .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
  while (marketPanels.size >= MAX_RETAINED_MARKET_PANELS && hidden.length > 0) {
    const victim = hidden.shift();
    if (!victim) {
      break;
    }
    victim[1].panel.dispose();
  }
}

async function pushMarketMessage(
  webview: vscode.Webview,
  payload: MarketOpenPayload,
  msg: Record<string, unknown>,
): Promise<void> {
  const timeoutMs = getTimeoutMs();
  try {
    if (msg.type === 'ready') {
      await sendInitialData(webview, payload, timeoutMs);
      return;
    }
    if (msg.type === 'industrySort' && payload.kind === 'industryRise') {
      const sort = msg.sort === '1' ? '1' : '0';
      const data = await fetchTencentIndustryRank(sort, 150, timeoutMs);
      webview.postMessage({ type: 'data', kind: 'industryRise', sort, payload: data });
      return;
    }
    if (msg.type === 'trendQuery' && payload.kind === 'stockMoneyTrend') {
      const code = typeof msg.code === 'string' ? msg.code.trim() : '';
      const days = typeof msg.days === 'number' ? msg.days : 30;
      const data = await fetchSinaStockMoneyTrend(code, days, timeoutMs);
      webview.postMessage({ type: 'data', kind: 'stockMoneyTrend', payload: data });
      return;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    webview.postMessage({ type: 'error', message });
  }
}

async function sendInitialData(
  webview: vscode.Webview,
  payload: MarketOpenPayload,
  timeoutMs: number,
): Promise<void> {
  try {
    switch (payload.kind) {
      case 'globalIndex': {
        const data = await fetchTencentGlobalIndices(timeoutMs);
        webview.postMessage({ type: 'data', kind: 'globalIndex', payload: data });
        break;
      }
      case 'industryRise': {
        const data = await fetchTencentIndustryRank('0', 150, timeoutMs);
        webview.postMessage({ type: 'data', kind: 'industryRise', sort: '0', payload: data });
        break;
      }
      case 'industryMoney': {
        const data = await fetchIndustryMoneyRankSina(payload.fenlei, 'netamount', timeoutMs);
        webview.postMessage({ type: 'data', kind: 'industryMoney', payload: data });
        break;
      }
      case 'stockMoneyRank': {
        const data = await fetchSinaStockMoneyRank(payload.sort, timeoutMs);
        webview.postMessage({ type: 'data', kind: 'stockMoneyRank', payload: data });
        break;
      }
      case 'stockMoneyTrend': {
        webview.postMessage({ type: 'data', kind: 'stockMoneyTrend', payload: null });
        break;
      }
      default:
        break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    webview.postMessage({ type: 'error', message });
  }
}

function buildHtml(webview: vscode.Webview, nonce: string, payload: MarketOpenPayload): string {
  const kind = payload.kind;
  const stealth = isStealthOfficeEnabled();
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
  <title>${escapeHtml(panelTitle(payload))}</title>
  <style>
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-foreground);
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 10%, transparent) 0, transparent 40%),
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 92%, black 8%) 0%, var(--vscode-editor-background) 100%);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      line-height: 1.45;
    }
    .err {
      color: var(--vscode-errorForeground);
      margin: 8px 0;
      padding: 10px 12px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #4f1f1f) 42%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 24%, transparent);
    }
    .muted {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-bottom: 10px;
      line-height: 1.6;
    }
    table {
      border-collapse: separate;
      border-spacing: 0;
      width: 100%;
      font-size: 11px;
      background: color-mix(in srgb, var(--vscode-editor-background) 95%, white 5%);
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.08);
    }
    th, td {
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: color-mix(in srgb, var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04)) 74%, white 6%);
      white-space: nowrap;
      font-weight: 700;
    }
    tbody tr:hover td {
      background: color-mix(in srgb, var(--vscode-list-hoverBackground) 78%, white 4%);
    }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .wrap { overflow-x: auto; margin-bottom: 10px; }
    .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
    button {
      background: color-mix(in srgb, var(--vscode-button-background) 88%, white 12%);
      color: var(--vscode-button-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 14%, transparent);
      border-radius: 10px;
      padding: 7px 12px;
      cursor: pointer;
      font-size: 12px;
      transition: background .16s ease, border-color .16s ease, transform .16s ease;
    }
    button.secondary { background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 82%, white 18%); color: var(--vscode-button-secondaryForeground); }
    button:hover { border-color: color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 30%, transparent); }
    button:active { transform: translateY(1px); }
    input {
      padding: 8px 10px;
      background: color-mix(in srgb, var(--vscode-input-background) 90%, white 10%);
      color: var(--vscode-input-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-input-border) 70%, transparent);
      border-radius: 10px;
    }
    .region-title {
      margin: 12px 0 6px;
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    ${STEALTH_OFFICE_STYLE_SNIPPET}
  </style>
</head>
<body${stealthOfficeBodyAttrs(stealth)}>
  ${stealthOfficeContentWrap(stealth, '<div id="root"></div>')}
  <script nonce="${nonce}">
(function() {
  var vscode = acquireVsCodeApi();
  var KIND = ${JSON.stringify(kind)};
  var STOCK_TITLE = ${payload.kind === 'stockMoneyRank' ? JSON.stringify(payload.title) : '""'};

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function stateText(s) {
    var v = String(s || '').toLowerCase().trim();
    if (v === 'open') return '开市';
    if (v === 'close') return '休市';
    return v ? v : '-';
  }
  function pctRatio(s) {
    var n = parseFloat(s);
    return isFinite(n) ? (n * 100).toFixed(2) + '%' : String(s || '-');
  }
  function pctChg(s) {
    var n = parseFloat(s);
    return isFinite(n) ? (n * 100).toFixed(2) + '%' : String(s || '-');
  }
  function wanYuan(raw) {
    var n = parseFloat(raw);
    return isFinite(n) ? (n / 10000).toFixed(2) : String(raw || '-');
  }

  function renderGlobal(data) {
    var el = document.getElementById('root');
    if (!data || !data.regions || !data.regions.length) {
      el.innerHTML = '<div class="muted">暂无全球指数数据</div>';
      return;
    }
    var parts = [];
    parts.push('<div class="muted">数据来源：腾讯财经 · 更新于 ' + new Date(data.fetchedAt).toLocaleString() + '</div>');
    data.regions.forEach(function (region) {
      parts.push('<div class="region-title">' + esc(region.title) + '</div>');
      parts.push('<div class="wrap"><table><thead><tr><th>指数</th><th>地区</th><th class="num">点位</th><th class="num">涨跌幅%</th><th>状态</th></tr></thead><tbody>');
      region.rows.forEach(function (r) {
        parts.push('<tr><td>' + esc(r.name) + '</td><td>' + esc(r.location) + '</td><td class="num">' + esc(r.zxj) + '</td><td class="num">' + esc(r.zdf) + '</td><td>' + stateText(r.state) + '</td></tr>');
      });
      parts.push('</tbody></table></div>');
    });
    el.innerHTML = parts.join('');
  }

  function renderIndustryRise(data, sort) {
    var el = document.getElementById('root');
    var bar = '<div class="bar"><span class="muted">行业涨幅排序（0 降序 / 1 升序）</span>' +
      '<button class="secondary" id="b0" type="button">涨幅降序 (0)</button>' +
      '<button class="secondary" id="b1" type="button">涨幅升序 (1)</button></div>';
    if (!data || !data.rows || !data.rows.length) {
      el.innerHTML = bar + '<div class="muted">暂无数据</div>';
      bindSort();
      return;
    }
    var parts = [bar];
    parts.push('<div class="muted">当前 o=' + esc(sort) + ' · 更新于 ' + new Date(data.fetchedAt).toLocaleString() + '</div>');
    parts.push('<div class="wrap"><table><thead><tr><th>板块</th><th class="num">板块涨跌%</th><th class="num">5日%</th><th class="num">20日%</th><th>领涨股</th><th class="num">领涨%</th><th class="num">最新价</th></tr></thead><tbody>');
    data.rows.forEach(function (r) {
      parts.push('<tr><td>' + esc(r.bdName) + '</td><td class="num">' + esc(r.bdZdf) + '</td><td class="num">' + esc(r.bdZdf5) + '</td><td class="num">' + esc(r.bdZdf20) + '</td><td>' + esc(r.nzgName) + '<div class="muted">' + esc(r.nzgCode) + '</div></td><td class="num">' + esc(r.nzgZdf) + '</td><td class="num">' + esc(r.nzgZxj) + '</td></tr>');
    });
    parts.push('</tbody></table></div>');
    el.innerHTML = parts.join('');
    bindSort();
    function bindSort() {
      var b0 = document.getElementById('b0');
      var b1 = document.getElementById('b1');
      if (b0) b0.onclick = function () { vscode.postMessage({ type: 'industrySort', sort: '0' }); };
      if (b1) b1.onclick = function () { vscode.postMessage({ type: 'industrySort', sort: '1' }); };
    }
  }

  function renderIndustryMoney(data) {
    var el = document.getElementById('root');
    if (!data || !data.rows || !data.rows.length) {
      el.innerHTML = '<div class="muted">暂无数据</div>';
      return;
    }
    var parts = [];
    parts.push('<div class="muted">fenlei=' + esc(data.fenlei) + ' sort=' + esc(data.sort) + ' · 更新于 ' + new Date(data.fetchedAt).toLocaleString() + '</div>');
    parts.push('<div class="wrap"><table><thead><tr><th>板块</th><th class="num">涨跌%</th><th class="num">流入(万)</th><th class="num">流出(万)</th><th class="num">净流入(万)</th><th class="num">净流入率</th><th>领涨股</th><th class="num">涨跌%</th><th class="num">现价</th><th class="num">净流入率</th></tr></thead><tbody>');
    data.rows.forEach(function (r) {
      parts.push('<tr><td>' + esc(r.name) + '</td><td class="num">' + pctChg(r.avgChangeratio) + '</td><td class="num">' + wanYuan(r.inamount) + '</td><td class="num">' + wanYuan(r.outamount) + '</td><td class="num">' + wanYuan(r.netamount) + '</td><td class="num">' + pctRatio(r.ratioamount) + '</td><td>' + esc(r.tsName) + '<div class="muted">' + esc(r.tsSymbol) + '</div></td><td class="num">' + pctChg(r.tsChangeratio) + '</td><td class="num">' + esc(r.tsTrade) + '</td><td class="num">' + pctRatio(r.tsRatioamount) + '</td></tr>');
    });
    parts.push('</tbody></table></div>');
    el.innerHTML = parts.join('');
  }

  function renderStockRank(data) {
    var el = document.getElementById('root');
    if (!data || !data.rows || !data.rows.length) {
      el.innerHTML = '<div class="muted">暂无数据</div>';
      return;
    }
    var parts = [];
    parts.push('<div class="muted">' + esc(STOCK_TITLE) + ' sort=' + esc(data.sort) + ' · 更新于 ' + new Date(data.fetchedAt).toLocaleString() + '</div>');
    parts.push('<div class="wrap"><table><thead><tr><th>代码</th><th>名称</th><th class="num">现价</th><th class="num">涨跌幅</th><th class="num">换手%</th><th class="num">成交额(万)</th><th class="num">流出(万)</th><th class="num">流入(万)</th><th class="num">净流入(万)</th><th class="num">净占比</th><th class="num">主力流出</th><th class="num">主力流入</th><th class="num">主力净流入</th><th class="num">主力净占比</th><th class="num">散户流出</th><th class="num">散户流入</th><th class="num">散户净流入</th><th class="num">散户净占比</th></tr></thead><tbody>');
    data.rows.forEach(function (r) {
      parts.push('<tr><td>' + esc(r.symbol) + '</td><td>' + esc(r.name) + '</td><td class="num">' + esc(r.trade) + '</td><td class="num">' + pctChg(r.changeratio) + '</td><td class="num">' + (parseFloat(r.turnover)/100).toFixed(2) + '</td>');
      parts.push('<td class="num">' + wanYuan(r.amount) + '</td><td class="num">' + wanYuan(r.outamount) + '</td><td class="num">' + wanYuan(r.inamount) + '</td><td class="num">' + wanYuan(r.netamount) + '</td><td class="num">' + pctRatio(r.ratioamount) + '</td>');
      parts.push('<td class="num">' + wanYuan(r.r0Out) + '</td><td class="num">' + wanYuan(r.r0In) + '</td><td class="num">' + wanYuan(r.r0Net) + '</td><td class="num">' + pctRatio(r.r0Ratio) + '</td>');
      parts.push('<td class="num">' + wanYuan(r.r3Out) + '</td><td class="num">' + wanYuan(r.r3In) + '</td><td class="num">' + wanYuan(r.r3Net) + '</td><td class="num">' + pctRatio(r.r3Ratio) + '</td></tr>');
    });
    parts.push('</tbody></table></div>');
    el.innerHTML = parts.join('');
  }

  function showTrendForm() {
    document.getElementById('root').innerHTML = '<div class="bar"><label>代码</label><input type="text" id="code" placeholder="sh600519" style="width:100px"/>' +
      '<label>天数</label><input type="number" id="days" value="30" min="5" max="120" style="width:56px"/>' +
      '<button type="button" id="q">查询</button></div><div id="tbl"><div class="muted">输入新浪格式代码后查询</div></div>';
    document.getElementById('q').onclick = function () {
      var c = document.getElementById('code').value.trim();
      var d = parseInt(document.getElementById('days').value, 10) || 30;
      vscode.postMessage({ type: 'trendQuery', code: c, days: d });
    };
  }

  function fillTrendTable(data) {
    var host = document.getElementById('tbl');
    if (!host) return;
    if (!data || !data.rows || !data.rows.length) {
      host.innerHTML = '<div class="muted">暂无数据</div>';
      return;
    }
    var p = [];
    p.push('<div class="muted">' + esc(data.code) + ' · 更新于 ' + new Date(data.fetchedAt).toLocaleString() + '</div>');
    p.push('<div class="wrap"><table><thead><tr><th>日期</th><th class="num">收盘</th><th class="num">涨跌幅</th><th class="num">净流入(亿)</th><th class="num">净占比</th><th class="num">主力净额(亿)</th></tr></thead><tbody>');
    data.rows.forEach(function (r) {
      var na = parseFloat(r.netamount);
      var r0 = parseFloat(r.r0Net);
      p.push('<tr><td>' + esc(r.opendate) + '</td><td class="num">' + esc(r.trade) + '</td><td class="num">' + pctChg(r.changeratio) + '</td><td class="num">' + (isFinite(na)?(na/1e8).toFixed(2):'-') + '</td><td class="num">' + esc(r.ratioamount) + '</td><td class="num">' + (isFinite(r0)?(r0/1e8).toFixed(2):'-') + '</td></tr>');
    });
    p.push('</tbody></table></div>');
    host.innerHTML = p.join('');
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m) return;
    if (m.type === 'error') {
      document.getElementById('root').innerHTML = '<div class="err">' + esc(m.message || '加载失败') + '</div>';
      return;
    }
    if (m.type === 'data' && m.kind === 'globalIndex') renderGlobal(m.payload);
    if (m.type === 'data' && m.kind === 'industryRise') renderIndustryRise(m.payload, m.sort);
    if (m.type === 'data' && m.kind === 'industryMoney') renderIndustryMoney(m.payload);
    if (m.type === 'data' && m.kind === 'stockMoneyRank') renderStockRank(m.payload);
    if (m.type === 'data' && m.kind === 'stockMoneyTrend') {
      if (m.payload) {
        if (document.getElementById('tbl')) fillTrendTable(m.payload);
        else { showTrendForm(); fillTrendTable(m.payload); }
      } else showTrendForm();
    }
  });

  document.getElementById('root').innerHTML = '<div class="muted">加载中…</div>';
  vscode.postMessage({ type: 'ready' });
})();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
