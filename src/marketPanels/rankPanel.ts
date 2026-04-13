import * as vscode from 'vscode';
import type { MarketListKind, RankRow } from '../types';
import { fetchConceptTopStocks, fetchLimitDown, fetchLimitUp, fetchTopConcepts, fetchTopIndustries, searchConcepts } from '../providers/market';

type ListState = { loading: boolean; error?: string; rows: Array<RankRow & { limitTime?: string | null }>; picked?: { code: string; name: string } | null; suggest?: { items: { code: string; name: string }[]; loading: boolean; error?: string } };

const PANEL_TYPE = 'traderx.rankPanel';

const titleByKind: Record<MarketListKind, string> = {
  topConcepts: '概念Top10',
  topIndustries: '板块Top10',
  limitUp: '涨停',
  limitDown: '跌停',
  conceptTopStocks: '指定概念Top10',
};

export function openRankPanel(ctx: vscode.ExtensionContext, kind: MarketListKind): void {
  const panel = vscode.window.createWebviewPanel(PANEL_TYPE, `市场行情 - ${titleByKind[kind]}`, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [ctx.extensionUri],
  });

  const nonce = String(Math.random()).slice(2);
  panel.webview.html = buildHtml(panel.webview, nonce, kind);

  const state: ListState = { loading: true, rows: [], picked: null, suggest: { items: [], loading: false, error: '' } };

  const post = (): void => {
    const bossMode = vscode.workspace.getConfiguration('traderx').get<boolean>('bossMode') === true;
    panel.webview.postMessage({ type: 'rank:update', kind, bossMode, state: { ...state }, updatedAt: Date.now() });
  };

  const load = async (): Promise<void> => {
    state.loading = true;
    state.error = '';
    state.rows = [];
    post();
    try {
      let rows: any[] = [];
      if (kind === 'topConcepts') rows = await fetchTopConcepts();
      else if (kind === 'topIndustries') rows = await fetchTopIndustries();
      else if (kind === 'limitUp') rows = await fetchLimitUp();
      else if (kind === 'limitDown') rows = await fetchLimitDown();
      else if (kind === 'conceptTopStocks') {
        if (!state.picked?.code) {
          rows = [];
        } else {
          rows = await fetchConceptTopStocks(state.picked.code);
        }
      }
      state.rows = rows as any;
      state.loading = false;
      post();
    } catch (e) {
      state.loading = false;
      state.error = e instanceof Error ? e.message : String(e);
      post();
    }
  };

  void load();

  const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('traderx.bossMode')) return;
    post();
  });
  panel.onDidDispose(() => cfgSub.dispose());

  panel.webview.onDidReceiveMessage((msg) => {
    if (!msg || typeof msg !== 'object') return;
    const t = (msg as any).type;
    if (t === 'rank.refresh') {
      void load();
      return;
    }
    if (t === 'rank.close') {
      panel.dispose();
      return;
    }
    if (t === 'concept.search' && kind === 'conceptTopStocks') {
      const q = String((msg as any).q || '').trim();
      if (!q) {
        state.suggest = { items: [], loading: false, error: '' };
        post();
        return;
      }
      state.suggest = { items: [], loading: true, error: '' };
      post();
      void (async () => {
        try {
          const items = await searchConcepts(q);
          state.suggest = { items, loading: false, error: '' };
          post();
        } catch (e) {
          state.suggest = { items: [], loading: false, error: e instanceof Error ? e.message : String(e) };
          post();
        }
      })();
      return;
    }
    if (t === 'concept.pick' && kind === 'conceptTopStocks') {
      const code = String((msg as any).code || '');
      const name = String((msg as any).name || '');
      if (!code || !name) return;
      state.picked = { code, name };
      post();
      void load();
    }
  });
}

function buildHtml(webview: vscode.Webview, nonce: string, kind: MarketListKind): string {
  const csp = [
    `default-src 'none';`,
    `style-src ${webview.cspSource} 'unsafe-inline';`,
    `script-src 'nonce-${nonce}';`,
    `connect-src https:;`,
  ].join(' ');
  const title = titleByKind[kind];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root{ --border: var(--vscode-panel-border, rgba(128,128,128,.35)); --muted: var(--vscode-descriptionForeground); --bg2: var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04)); }
    body{ margin:0; padding:10px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 12px; }
    .bar{ display:flex; gap:8px; align-items:center; margin-bottom:10px; }
    button{ background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:1px solid transparent; border-radius:4px; padding:6px 10px; cursor:pointer; }
    button.secondary{ background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .meta{ color: var(--muted); }
    .err{ color: var(--vscode-errorForeground); white-space: pre-wrap; margin:8px 0; }
    .table{ border:1px solid var(--border); border-radius:6px; overflow:auto; }
    table{ width:100%; border-collapse: separate; border-spacing: 0; min-width: 560px; }
    th,td{ padding:6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
    th{ text-align:left; position: sticky; top: 0; background: var(--bg2); z-index: 1; }
    .right{text-align:right;}
    .rowbtn{ display:inline-flex; gap:6px; flex-wrap:wrap; }
    input{ width:100%; box-sizing:border-box; padding:6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius:4px; }
    .boss-wrap{ position:relative; }
    .boss-wrap.boss-mode{ filter: grayscale(1) contrast(.9) brightness(.92); }
    .boss-overlay{ display:none; position:absolute; inset:0; background: color-mix(in srgb, var(--vscode-editor-background) 55%, transparent); border-radius: 6px; pointer-events: all; cursor: not-allowed; }
    .boss-wrap.boss-mode .boss-overlay{ display:block; }
    .boss-text{ position:absolute; top:10px; right:10px; font-size: 11px; color: var(--muted); background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent); border: 1px solid var(--border); border-radius: 999px; padding: 4px 8px; }
  </style>
</head>
<body>
  <div class="boss-wrap" id="bossWrap">
    <div class="boss-overlay"><div class="boss-text">老板模式：已置灰</div></div>
    <div class="bar">
      <button id="btnRefresh">刷新</button>
      <span class="meta" id="meta">—</span>
      <span style="flex:1"></span>
      <button class="secondary" id="btnClose">关闭</button>
    </div>
    <div class="err" id="err" style="display:none"></div>

    <div id="conceptBox" style="display:none; margin-bottom:10px;">
      <div class="meta" style="margin-bottom:6px;">搜索概念并选择后加载 Top10</div>
      <input id="conceptQ" placeholder="输入概念关键字…" />
      <div id="conceptSuggest" class="rowbtn" style="margin-top:8px;"></div>
    </div>

    <div class="table">
      <table>
        <thead id="thead"></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const kind = ${JSON.stringify(kind)};
    const meta = document.getElementById('meta');
    const err = document.getElementById('err');
    const thead = document.getElementById('thead');
    const tbody = document.getElementById('tbody');
    const conceptBox = document.getElementById('conceptBox');
    const conceptQ = document.getElementById('conceptQ');
    const conceptSuggest = document.getElementById('conceptSuggest');

    document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'rank.refresh' }));
    document.getElementById('btnClose').addEventListener('click', () => vscode.postMessage({ type: 'rank.close' }));

    function fmt(n,d){ if (n === null || n === undefined || Number.isNaN(n)) return '—'; return Number(n).toFixed(d); }
    function amt(y){ if (y === null || y === undefined || Number.isNaN(y)) return '—'; const v = Number(y); if (!Number.isFinite(v)) return '—'; if (v >= 1e8) return (v/1e8).toFixed(2)+'亿'; if (v >= 1e4) return (v/1e4).toFixed(2)+'万'; return String(Math.round(v)); }

    function setHeader(){
      if (kind === 'limitUp' || kind === 'limitDown') {
        thead.innerHTML = '<tr><th>代码</th><th>名称</th><th class=\"right\">价格</th><th class=\"right\">涨跌%</th><th>时间</th><th class=\"right\">成交额</th></tr>';
      } else {
        thead.innerHTML = '<tr><th>代码</th><th>名称</th><th class=\"right\">价格</th><th class=\"right\">涨跌%</th><th class=\"right\">成交额</th></tr>';
      }
    }

    function renderSuggest(st){
      if (kind !== 'conceptTopStocks') return;
      conceptBox.style.display = 'block';
      conceptSuggest.replaceChildren();
      const sug = st.suggest || { items: [], loading: false, error: '' };
      if (sug.loading) {
        const span = document.createElement('span'); span.className='meta'; span.textContent='搜索中…'; conceptSuggest.appendChild(span); return;
      }
      if (sug.error) {
        const span = document.createElement('span'); span.className='meta'; span.textContent=sug.error; conceptSuggest.appendChild(span); return;
      }
      const items = Array.isArray(sug.items) ? sug.items.slice(0,10) : [];
      for (const it of items) {
        const b = document.createElement('button');
        b.className = 'secondary';
        b.textContent = it.name;
        b.title = it.code;
        b.addEventListener('click', () => vscode.postMessage({ type: 'concept.pick', code: it.code, name: it.name }));
        conceptSuggest.appendChild(b);
      }
      if (!items.length) {
        const span = document.createElement('span'); span.className='meta'; span.textContent='—'; conceptSuggest.appendChild(span);
      }
    }

    function renderTable(st){
      tbody.replaceChildren();
      if (st.loading) {
        const tr=document.createElement('tr'); const td=document.createElement('td'); td.colSpan=6; td.className='meta'; td.textContent='加载中…'; tr.appendChild(td); tbody.appendChild(tr); return;
      }
      if (st.error) {
        const tr=document.createElement('tr'); const td=document.createElement('td'); td.colSpan=6; td.className='meta'; td.textContent=st.error; tr.appendChild(td); tbody.appendChild(tr); return;
      }
      const rows = Array.isArray(st.rows) ? st.rows : [];
      for (const r of rows) {
        const tr=document.createElement('tr');
        const add=(t,cls)=>{ const td=document.createElement('td'); td.textContent=t; if(cls) td.className=cls; tr.appendChild(td); };
        add(String(r.code||'—'));
        add(String(r.name||'—'));
        add(r.price==null?'—':fmt(r.price,2),'right');
        add(r.changePct==null?'—':fmt(r.changePct,2),'right');
        if (kind==='limitUp' || kind==='limitDown') add(String(r.limitTime||'')); 
        add(amt(r.amountYuan), 'right');
        tbody.appendChild(tr);
      }
    }

    setHeader();

    let conceptTimer;
    if (conceptQ) {
      conceptQ.addEventListener('input', () => {
        if (kind !== 'conceptTopStocks') return;
        if (conceptTimer) clearTimeout(conceptTimer);
        conceptTimer = setTimeout(() => vscode.postMessage({ type: 'concept.search', q: conceptQ.value || '' }), 260);
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'rank:update') return;
      const bw = document.getElementById('bossWrap');
      if (bw) bw.classList.toggle('boss-mode', !!msg.bossMode);
      const st = msg.state || { loading:false, rows:[] };
      meta.textContent = '更新：' + new Date(msg.updatedAt || Date.now()).toLocaleTimeString();
      err.style.display = 'none'; err.textContent = '';
      renderSuggest(st);
      renderTable(st);
    });
  </script>
</body>
</html>`;
}

