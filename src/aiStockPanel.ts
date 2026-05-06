import * as vscode from 'vscode';
import { AiCandidateProvider, type AiCandidateScope } from './ai/candidateProvider';
import { clearAiApiKey, readAiRuntimeConfig, saveAiApiKey } from './ai/config';
import { AiStockAgentService, type AiStockPickResult } from './ai/stockAgentService';
import type { QuoteService } from './services/quoteService';
import { isStealthOfficeEnabled, STEALTH_OFFICE_STYLE_SNIPPET, stealthOfficeBodyAttrs, stealthOfficeContentWrap } from './stealthOfficeWebview';
import { normalizeStockInput, type NormalizedCode } from './stockCode';
import type { WatchlistStore } from './storage/watchlistStore';

let aiStockPanel: vscode.WebviewPanel | undefined;
let aiStockPanelMessageDisposable: vscode.Disposable | undefined;

interface AiPanelDeps {
  context: vscode.ExtensionContext;
  store: WatchlistStore;
  quoteService: QuoteService;
  onAdded: (code: NormalizedCode) => Promise<void>;
}

type AiPanelMessage =
  | { type?: 'ready' }
  | { type?: 'run'; prompt?: string; scope?: AiCandidateScope }
  | { type?: 'setApiKey' }
  | { type?: 'clearApiKey' }
  | { type?: 'testConnection' }
  | { type?: 'addStock'; code?: string }
  | { type?: 'addAll'; codes?: string[] };

export function openAiStockPanel(deps: AiPanelDeps): void {
  if (aiStockPanel) {
    aiStockPanel.reveal(vscode.ViewColumn.One);
  } else {
    aiStockPanel = vscode.window.createWebviewPanel(
      'traderx.aiStockPicker',
      'TraderX AI 选股',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [deps.context.extensionUri] },
    );
    aiStockPanel.onDidDispose(() => {
      aiStockPanelMessageDisposable?.dispose();
      aiStockPanelMessageDisposable = undefined;
      aiStockPanel = undefined;
    });
  }

  const provider = new AiCandidateProvider(deps.store, deps.quoteService);
  const agent = new AiStockAgentService(deps.context, provider);
  const panel = aiStockPanel;
  aiStockPanelMessageDisposable?.dispose();
  aiStockPanelMessageDisposable = panel.webview.onDidReceiveMessage((msg: AiPanelMessage) => {
    void handleMessage(panel.webview, msg, deps, agent);
  });
  panel.webview.html = buildAiStockHtml(panel.webview, isStealthOfficeEnabled());
}

async function handleMessage(
  webview: vscode.Webview,
  msg: AiPanelMessage,
  deps: AiPanelDeps,
  agent: AiStockAgentService,
): Promise<void> {
  try {
    if (msg.type === 'ready') {
      await pushState(webview, deps.context);
      return;
    }
    if (msg.type === 'setApiKey') {
      await promptAndSaveApiKey(deps.context);
      await pushState(webview, deps.context);
      return;
    }
    if (msg.type === 'clearApiKey') {
      const cfg = await readAiRuntimeConfig(deps.context);
      await clearAiApiKey(deps.context, cfg.provider);
      vscode.window.showInformationMessage(`已清除 ${cfg.providerLabel} API Key`);
      await pushState(webview, deps.context);
      return;
    }
    if (msg.type === 'testConnection') {
      const message = await agent.testConnection();
      webview.postMessage({ type: 'notice', message });
      return;
    }
    if (msg.type === 'run') {
      const result = await agent.selectStocks(msg.prompt ?? '', normalizeScope(msg.scope));
      webview.postMessage({ type: 'result', result });
      return;
    }
    if (msg.type === 'addStock' && msg.code) {
      await addStock(deps, msg.code);
      webview.postMessage({ type: 'notice', message: `已加入当前分组：${msg.code}` });
      return;
    }
    if (msg.type === 'addAll' && Array.isArray(msg.codes)) {
      let count = 0;
      for (const code of msg.codes) {
        if (await addStock(deps, code, false)) {
          count++;
        }
      }
      if (count > 0) {
        vscode.window.showInformationMessage(`已加入当前分组：${count} 只`);
      }
      webview.postMessage({ type: 'notice', message: `已加入当前分组：${count} 只` });
      return;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    webview.postMessage({ type: 'error', message });
  }
}

async function promptAndSaveApiKey(ctx: vscode.ExtensionContext): Promise<void> {
  const cfg = await readAiRuntimeConfig(ctx);
  const value = await vscode.window.showInputBox({
    title: `配置 ${cfg.providerLabel} API Key`,
    prompt: 'API Key 只保存在 VS Code SecretStorage，不会写入 settings.json',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return;
  }
  await saveAiApiKey(ctx, cfg.provider, value);
  vscode.window.showInformationMessage(`已保存 ${cfg.providerLabel} API Key`);
}

async function addStock(deps: AiPanelDeps, rawCode: string, notify = true): Promise<boolean> {
  const n = normalizeStockInput(rawCode);
  if (!n.ok) {
    throw new Error(n.message);
  }
  const gid = deps.store.getActiveGroupId();
  const existed = deps.store.getGroupById(gid)?.codes.includes(n.code) === true;
  await deps.store.addCodeToGroup(gid, n.code);
  if (!existed) {
    await deps.onAdded(n.code);
  }
  if (notify) {
    vscode.window.showInformationMessage(existed ? `当前分组已存在：${n.code}` : `已加入当前分组：${n.code}`);
  }
  return !existed;
}

async function pushState(webview: vscode.Webview, ctx: vscode.ExtensionContext): Promise<void> {
  const cfg = await readAiRuntimeConfig(ctx);
  webview.postMessage({
    type: 'state',
    state: {
      providerLabel: cfg.providerLabel,
      model: cfg.model || '未配置',
      baseUrl: cfg.baseUrl || '未配置',
      hasApiKey: cfg.hasApiKey,
    },
  });
}

function normalizeScope(scope: unknown): AiCandidateScope {
  if (scope === 'activeGroup' || scope === 'allWatchlist' || scope === 'hotMarket' || scope === 'mixed') {
    return scope;
  }
  return 'mixed';
}

function buildAiStockHtml(webview: vscode.Webview, stealth: boolean): string {
  const nonce = String(Math.random()).slice(2);
  const csp = [
    `default-src 'none';`,
    `style-src ${webview.cspSource} 'unsafe-inline';`,
    `script-src 'nonce-${nonce}';`,
  ].join(' ');
  const main = `
  <div class="shell">
    <header>
      <h1>AI 选股</h1>
      <p>输入一句话，TraderX 会先整理候选股票，再调用你配置的 OpenAI-compatible 模型筛选。结果仅供信息筛选，不构成投资建议。</p>
    </header>
    <section class="card">
      <div class="status" id="status">正在读取模型配置...</div>
      <div class="toolbar">
        <button id="setKey">配置 API Key</button>
        <button class="secondary" id="clearKey">清除 Key</button>
        <button class="secondary" id="test">测试连接</button>
      </div>
      <label for="prompt">选股描述</label>
      <textarea id="prompt" rows="4" placeholder="例如：帮我选 5 只今天放量上涨、主力资金流入明显、风险不要太高的股票"></textarea>
      <div class="row">
        <label class="inline" for="scope">候选池</label>
        <select id="scope">
          <option value="mixed">自选 + 市场热门</option>
          <option value="activeGroup">当前分组</option>
          <option value="allWatchlist">全部自选</option>
          <option value="hotMarket">市场热门</option>
        </select>
        <button id="run">开始筛选</button>
      </div>
    </section>
    <section class="card result-card">
      <div class="bar">
        <strong>筛选结果</strong>
        <button class="secondary" id="addAll" disabled>全部加入当前分组</button>
      </div>
      <div id="message" class="muted">等待输入选股描述。</div>
      <div id="result"></div>
    </section>
  </div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI 选股</title>
  <style>
    body {
      margin: 0;
      padding: 18px;
      color: var(--vscode-foreground);
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 10%, transparent) 0, transparent 42%),
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 94%, black 6%) 0%, var(--vscode-editor-background) 100%);
      font-family: var(--vscode-font-family);
      font-size: 13px;
      line-height: 1.55;
    }
    .shell { max-width: 980px; margin: 0 auto; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    header p, .muted { color: var(--vscode-descriptionForeground); }
    .card {
      margin-top: 14px;
      padding: 16px;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
      background: color-mix(in srgb, var(--vscode-editor-background) 94%, white 6%);
      border-radius: 14px;
      box-shadow: 0 12px 32px rgba(0,0,0,.08);
    }
    label { display: block; margin: 14px 0 6px; color: var(--vscode-descriptionForeground); font-weight: 700; }
    label.inline { margin: 0; }
    textarea, select {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid color-mix(in srgb, var(--vscode-input-border) 70%, transparent);
      border-radius: 10px;
      outline: none;
      font-family: var(--vscode-font-family);
    }
    textarea:focus, select:focus { border-color: var(--vscode-focusBorder); }
    .row, .toolbar, .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; }
    .row select { max-width: 220px; }
    button {
      background: color-mix(in srgb, var(--vscode-button-background) 88%, white 12%);
      color: var(--vscode-button-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 14%, transparent);
      padding: 8px 14px;
      border-radius: 10px;
      cursor: pointer;
    }
    button.secondary {
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 82%, white 18%);
      color: var(--vscode-button-secondaryForeground);
    }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .status {
      padding: 10px 12px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04)) 78%, white 4%);
      color: var(--vscode-descriptionForeground);
    }
    .error { color: var(--vscode-errorForeground); }
    .pick {
      padding: 12px;
      margin-top: 10px;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 78%, transparent);
      border-radius: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 96%, white 4%);
    }
    .pick-head { display:flex; gap:8px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
    .code { font-variant-numeric: tabular-nums; font-weight: 700; }
    .tag { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .reason { margin-top: 8px; }
    ul { margin: 8px 0 0 18px; padding: 0; color: var(--vscode-descriptionForeground); }
    ${STEALTH_OFFICE_STYLE_SNIPPET}
  </style>
</head>
<body${stealthOfficeBodyAttrs(stealth)}>
  ${stealthOfficeContentWrap(stealth, main)}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let lastCodes = [];
    const $ = (id) => document.getElementById(id);
    const setBusy = (busy) => {
      $('run').disabled = busy;
      $('test').disabled = busy;
      $('run').textContent = busy ? '筛选中...' : '开始筛选';
    };
    function setMessage(text, isError) {
      const el = $('message');
      el.textContent = text;
      el.className = isError ? 'error' : 'muted';
    }
    function renderState(state) {
      $('status').textContent = '模型：' + state.providerLabel + ' / ' + state.model + ' / Key：' + (state.hasApiKey ? '已配置' : '未配置') + ' / Base URL：' + state.baseUrl;
    }
    function renderResult(result) {
      lastCodes = (result.picks || []).map((x) => x.code);
      $('addAll').disabled = lastCodes.length === 0;
      setMessage(result.summary + '（候选 ' + result.candidateCount + ' 只，模型 ' + result.providerLabel + ' / ' + result.model + '）', false);
      const root = $('result');
      root.innerHTML = '';
      if (result.warnings && result.warnings.length) {
        const w = document.createElement('ul');
        result.warnings.forEach((msg) => {
          const li = document.createElement('li');
          li.textContent = msg;
          w.appendChild(li);
        });
        root.appendChild(w);
      }
      if (!result.picks || result.picks.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = '模型没有筛出匹配股票，可以换一个描述或扩大候选池。';
        root.appendChild(empty);
        return;
      }
      for (const pick of result.picks) {
        const box = document.createElement('div');
        box.className = 'pick';
        const head = document.createElement('div');
        head.className = 'pick-head';
        const title = document.createElement('div');
        title.innerHTML = '<span class="code"></span> <span></span> <span class="tag"></span>';
        title.querySelector('.code').textContent = pick.code;
        title.querySelector('span:nth-child(2)').textContent = pick.name;
        title.querySelector('.tag').textContent = '置信度 ' + Math.round((pick.confidence || 0) * 100) + '% · ' + pick.source;
        const btn = document.createElement('button');
        btn.className = 'secondary';
        btn.textContent = '加入当前分组';
        btn.onclick = () => vscode.postMessage({ type: 'addStock', code: pick.code });
        head.appendChild(title);
        head.appendChild(btn);
        const reason = document.createElement('div');
        reason.className = 'reason';
        reason.textContent = pick.reason;
        box.appendChild(head);
        box.appendChild(reason);
        const notes = [...(pick.matchedRules || []), ...(pick.riskNotes || []).map((x) => '风险：' + x)];
        if (notes.length) {
          const ul = document.createElement('ul');
          notes.forEach((msg) => {
            const li = document.createElement('li');
            li.textContent = msg;
            ul.appendChild(li);
          });
          box.appendChild(ul);
        }
        root.appendChild(box);
      }
    }
    $('setKey').onclick = () => vscode.postMessage({ type: 'setApiKey' });
    $('clearKey').onclick = () => vscode.postMessage({ type: 'clearApiKey' });
    $('test').onclick = () => vscode.postMessage({ type: 'testConnection' });
    $('addAll').onclick = () => vscode.postMessage({ type: 'addAll', codes: lastCodes });
    $('run').onclick = () => {
      setBusy(true);
      setMessage('正在准备候选池并调用模型...', false);
      $('result').innerHTML = '';
      vscode.postMessage({ type: 'run', prompt: $('prompt').value, scope: $('scope').value });
    };
    window.addEventListener('message', (e) => {
      const msg = e.data || {};
      if (msg.type === 'state') renderState(msg.state);
      if (msg.type === 'result') { setBusy(false); renderResult(msg.result); }
      if (msg.type === 'error') { setBusy(false); setMessage(msg.message || '操作失败', true); }
      if (msg.type === 'notice') setMessage(msg.message || '操作完成', false);
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
