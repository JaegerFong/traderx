import * as vscode from 'vscode';
import { normalizeIntradayDisplayMode, type IntradayDisplayMode } from './intradayPanel';
import type { IntradayPageProvider } from './stockUrls';

function normalizeStoredPageProvider(raw: string | undefined): IntradayPageProvider {
  if (raw === 'eastmoney_discreet') {
    return 'eastmoney_discreet';
  }
  return 'eastmoney_full';
}

export function openTraderxSettingsPanel(onSaved: () => void): void {
  const panel = vscode.window.createWebviewPanel(
    'traderx.settings',
    'TraderX 全局设置',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const pushHtml = (): void => {
    const cfg = vscode.workspace.getConfiguration('traderx');
    const sec = cfg.get<number>('refreshIntervalSeconds') ?? 3;
    const rawMode = cfg.get<string>('intradayDisplayMode');
    const displayMode = normalizeIntradayDisplayMode(rawMode);
    const pageProvider = normalizeStoredPageProvider(cfg.get<string>('intradayPageProvider'));
    const stealth = cfg.get<boolean>('intradayStealthMode') === true;
    panel.webview.html = buildSettingsHtml(sec, displayMode, pageProvider, stealth);
  };

  pushHtml();

  panel.webview.onDidReceiveMessage(
    async (msg: {
      type?: string;
      refreshIntervalSeconds?: number;
      intradayDisplayMode?: string;
      intradayPageProvider?: string;
      intradayStealthMode?: boolean;
    }) => {
      if (msg.type !== 'save') {
        return;
      }
      const cfg = vscode.workspace.getConfiguration('traderx');
      if (typeof msg.refreshIntervalSeconds === 'number') {
        const v = Math.round(msg.refreshIntervalSeconds);
        const clamped = Math.max(3, Math.min(300, v));
        await cfg.update('refreshIntervalSeconds', clamped, vscode.ConfigurationTarget.Global);
      }
      if (typeof msg.intradayStealthMode === 'boolean') {
        await cfg.update('intradayStealthMode', msg.intradayStealthMode, vscode.ConfigurationTarget.Global);
      }
      if (msg.intradayDisplayMode === 'simpleBrowser' || msg.intradayDisplayMode === 'systemBrowser') {
        await cfg.update('intradayDisplayMode', msg.intradayDisplayMode, vscode.ConfigurationTarget.Global);
      }
      if (msg.intradayPageProvider === 'eastmoney_full' || msg.intradayPageProvider === 'eastmoney_discreet') {
        await cfg.update('intradayPageProvider', msg.intradayPageProvider, vscode.ConfigurationTarget.Global);
      }
      vscode.window.showInformationMessage('已保存设置');
      onSaved();
      pushHtml();
    },
    undefined,
    [],
  );
}

function buildSettingsHtml(
  refreshSeconds: number,
  displayMode: IntradayDisplayMode,
  pageProvider: IntradayPageProvider,
  stealth: boolean,
): string {
  const nonce = String(Math.random()).slice(2);
  const stealthChecked = stealth ? 'checked' : '';
  const sel = (value: string, options: { v: string; t: string }[]): string =>
    options.map((o) => `<option value="${o.v}"${o.v === value ? ' selected' : ''}>${o.t}</option>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>全局设置</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; margin: 0; max-width: 480px; }
    h1 { font-size: 16px; margin: 0 0 12px 0; }
    label { display: block; margin: 12px 0 6px; color: var(--vscode-descriptionForeground); }
    input[type="number"], select { width: 100%; box-sizing: border-box; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; }
    .row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    button { margin-top: 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; border-radius: 2px; cursor: pointer; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 6px; }
  </style>
</head>
<body>
  <h1>全局设置</h1>
  <label for="sec">行情自动刷新间隔（秒）</label>
  <input type="number" id="sec" min="3" max="300" step="1" value="${refreshSeconds}" />
  <p class="hint">范围 3～300，保存后立即作用于侧栏自动刷新。</p>
  <label>分时与侧栏</label>
  <div class="row">
    <input type="checkbox" id="stealth" ${stealthChecked} />
    <span>低调办公</span>
  </div>
  <p class="hint">开启后：① 侧栏以<strong>灰度</strong>显示；② 分时固定为韭菜盒子 LeekFund 同源页面（GitHub: LeekHub/leek-fund）<code>quote.eastmoney.com/basic/h5chart-iframe.html</code>（内置 Simple Browser，失败则系统浏览器）。开启时忽略下方选项。</p>
  <label for="mode">分时查看方式（未开启低调办公时生效）</label>
  <select id="mode">${sel(displayMode, [
    { v: 'simpleBrowser', t: '内置 Simple Browser' },
    { v: 'systemBrowser', t: '系统默认浏览器' },
  ])}</select>
  <p class="hint">内置浏览器不可用时将自动改用系统浏览器。</p>
  <label for="site">行情页站点</label>
  <select id="site">${sel(pageProvider, [
    { v: 'eastmoney_full', t: '东方财富完整行情（PC 个股页）' },
    { v: 'eastmoney_discreet', t: '东方财富低调模式（h5chart-iframe，LeekFund 同源）' },
  ])}</select>
  <button id="save">保存</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function syncStealth() {
      const st = document.getElementById('stealth').checked;
      document.getElementById('mode').disabled = st;
      document.getElementById('site').disabled = st;
    }
    document.getElementById('stealth').addEventListener('change', syncStealth);
    syncStealth();
    document.getElementById('save').onclick = () => {
      const v = Number(document.getElementById('sec').value);
      const intradayStealthMode = document.getElementById('stealth').checked;
      const intradayDisplayMode = document.getElementById('mode').value;
      const intradayPageProvider = document.getElementById('site').value;
      vscode.postMessage({ type: 'save', refreshIntervalSeconds: v, intradayStealthMode, intradayDisplayMode, intradayPageProvider });
    };
  </script>
</body>
</html>`;
}
