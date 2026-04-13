import * as vscode from 'vscode';
import { fetchClsMarketHome, fetchClsTelegraphList } from '../providers/goStockMarket/cls';

let panelSingleton: vscode.WebviewPanel | undefined;

export function openMarketPanel(ctx: vscode.ExtensionContext): void {
  if (panelSingleton) {
    panelSingleton.reveal(undefined, true);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'traderx.market',
    '市场行情',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [ctx.extensionUri],
    },
  );
  panelSingleton = panel;

  const nonce = String(Math.random()).slice(2);
  panel.webview.html = buildHtml(panel.webview, nonce);

  const postState = async (reason: string): Promise<void> => {
    try {
      const [home, clsNews] = await Promise.all([
        fetchClsMarketHome(15000),
        fetchClsTelegraphList(30, 15000),
      ]);
      panel.webview.postMessage({
        type: 'market:update',
        reason,
        fetchedAt: Date.now(),
        home,
        clsNews,
      });
    } catch (e) {
      panel.webview.postMessage({
        type: 'market:error',
        reason,
        fetchedAt: Date.now(),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  void postState('init');

  panel.webview.onDidReceiveMessage((msg) => {
    if (!msg || typeof msg !== 'object') return;
    const t = (msg as any).type;
    if (t === 'market.refresh') {
      void postState('refresh');
    }
    if (t === 'market.close') {
      panel.dispose();
      return;
    }
    if (t === 'market.openLink' && typeof (msg as any).url === 'string') {
      void vscode.env.openExternal(vscode.Uri.parse((msg as any).url));
    }
  });

  panel.onDidDispose(() => {
    panelSingleton = undefined;
  });
}

function buildHtml(webview: vscode.Webview, nonce: string): string {
  const csp = [
    `default-src 'none';`,
    `style-src ${webview.cspSource} 'unsafe-inline';`,
    `script-src 'nonce-${nonce}';`,
    `img-src ${webview.cspSource} https: data:;`,
    `connect-src https:;`,
  ].join(' ');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>市场行情</title>
  <style>
    :root{
      --border: var(--vscode-panel-border, rgba(128,128,128,.35));
      --muted: var(--vscode-descriptionForeground);
      --bg: var(--vscode-editor-background);
      --bg2: var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04));
    }
    body{ margin:0; padding:10px; background:var(--bg); color:var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 12px; }
    .bar{ display:flex; gap:8px; align-items:center; margin-bottom:10px; }
    button{ background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:1px solid transparent; border-radius: 4px; padding:6px 10px; cursor:pointer; }
    button.secondary{ background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .meta{ color:var(--muted); }
    .grid{ display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom: 10px; }
    .card{ border:1px solid var(--border); border-radius:6px; padding:10px; background: color-mix(in srgb, var(--bg2) 70%, transparent); }
    .card h3{ margin:0 0 8px 0; font-size: 12px; font-weight: 600; }
    table{ width:100%; border-collapse: separate; border-spacing: 0; }
    th,td{ padding:6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
    th{ text-align:left; position:sticky; top:0; background: var(--bg2); z-index: 1; }
    .right{text-align:right;}
    .err{ color: var(--vscode-errorForeground); white-space: pre-wrap; margin: 8px 0; }
    a{ color: var(--vscode-textLink-foreground); text-decoration:none; }
    a:hover{ text-decoration:underline; }
  </style>
</head>
<body>
  <div class="bar">
    <button id="btnRefresh">刷新</button>
    <span class="meta" id="meta">—</span>
    <span style="flex:1"></span>
    <button class="secondary" id="btnClose">关闭</button>
  </div>
  <div class="err" id="err" style="display:none"></div>

  <div class="grid">
    <div class="card">
      <h3>指数行情（CLS）</h3>
      <div style="overflow:auto; max-height: 240px;">
        <table>
          <thead><tr><th>指数</th><th class="right">最新</th><th class="right">涨跌%</th><th class="right">涨跌点</th><th class="right">涨/跌/平</th></tr></thead>
          <tbody id="tbIndex"></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <h3>涨跌分布（CLS）</h3>
      <div id="upDown" class="meta">—</div>
    </div>
  </div>

  <div class="card">
    <h3>市场快讯：财联社电报</h3>
    <div style="overflow:auto; max-height: 420px;">
      <table>
        <thead><tr><th style="width:90px;">时间</th><th>标题/内容</th></tr></thead>
        <tbody id="tbCls"></tbody>
      </table>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const meta = document.getElementById('meta');
    const err = document.getElementById('err');
    const tbIndex = document.getElementById('tbIndex');
    const tbCls = document.getElementById('tbCls');
    const upDown = document.getElementById('upDown');

    document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'market.refresh' }));
    document.getElementById('btnClose').addEventListener('click', () => vscode.postMessage({ type: 'market.close' }));

    function fmt(n, d){ if (n === null || n === undefined || Number.isNaN(n)) return '—'; return Number(n).toFixed(d); }

    function renderIndex(rows){
      tbIndex.replaceChildren();
      for (const r of (rows || [])) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); td1.textContent = (r.secuName || r.secuCode || '—'); tr.appendChild(td1);
        const td2 = document.createElement('td'); td2.className='right'; td2.textContent = fmt(r.lastPx, 2); tr.appendChild(td2);
        const td3 = document.createElement('td'); td3.className='right'; td3.textContent = fmt((r.change||0)*100, 2); tr.appendChild(td3);
        const td4 = document.createElement('td'); td4.className='right'; td4.textContent = fmt(r.changePx, 2); tr.appendChild(td4);
        const td5 = document.createElement('td'); td5.className='right'; td5.textContent = String(r.upNum||0) + '/' + String(r.downNum||0) + '/' + String(r.flatNum||0); tr.appendChild(td5);
        tbIndex.appendChild(tr);
      }
    }

    function renderUpDown(d){
      if (!d) { upDown.textContent = '—'; return; }
      upDown.innerHTML =
        '涨停：' + d.upNum + '，跌停：' + d.downNum + '，平盘：' + d.flatNum + '<br/>' +
        '上涨：' + d.riseNum + '，下跌：' + d.fallNum + '，平均涨幅：' + fmt((d.averageRise||0)*100, 2) + '%';
    }

    function renderClsNews(list){
      tbCls.replaceChildren();
      for (const it of (list || [])) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); td1.textContent = it.time || '—'; tr.appendChild(td1);
        const td2 = document.createElement('td');
        const title = document.createElement('div');
        title.textContent = it.title || '';
        title.style.fontWeight = it.isRed ? '600' : '400';
        const content = document.createElement('div');
        content.textContent = it.content || '';
        content.className = 'meta';
        td2.appendChild(title);
        td2.appendChild(content);
        if (it.url) {
          td2.style.cursor = 'pointer';
          td2.title = it.url;
          td2.addEventListener('click', () => vscode.postMessage({ type: 'market.openLink', url: it.url }));
        }
        tr.appendChild(td2);
        tbCls.appendChild(tr);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'market:error') {
        err.style.display = 'block';
        err.textContent = msg.error || '加载失败';
        meta.textContent = '更新失败：' + new Date(msg.fetchedAt || Date.now()).toLocaleTimeString();
        return;
      }
      if (msg.type === 'market:update') {
        err.style.display = 'none';
        err.textContent = '';
        meta.textContent = '更新：' + new Date(msg.fetchedAt || Date.now()).toLocaleTimeString();
        renderIndex(msg.home && msg.home.indexQuote);
        renderUpDown(msg.home && msg.home.upDownDis);
        renderClsNews(msg.clsNews || []);
        return;
      }
    });
  </script>
</body>
</html>`;
}

