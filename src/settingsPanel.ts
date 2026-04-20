import * as vscode from 'vscode';
import { normalizeIntradayDisplayMode, type IntradayDisplayMode } from './intradayPanel';
import type { IntradayPageProvider } from './stockUrls';
import {
  STEALTH_OFFICE_STYLE_SNIPPET,
  stealthOfficeBodyAttrs,
  stealthOfficeContentWrap,
} from './stealthOfficeWebview';

function normalizeStoredPageProvider(raw: string | undefined): IntradayPageProvider {
  if (raw === 'eastmoney_discreet') {
    return 'eastmoney_discreet';
  }
  return 'eastmoney_full';
}

let settingsPanel: vscode.WebviewPanel | undefined;
let settingsOnSaved: (() => void) | undefined;

export function openTraderxSettingsPanel(onSaved: () => void): void {
  settingsOnSaved = onSaved;
  if (settingsPanel) {
    settingsPanel.reveal(vscode.ViewColumn.One);
  } else {
    settingsPanel = vscode.window.createWebviewPanel(
      'traderx.settings',
      'TraderX 全局设置',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    settingsPanel.onDidDispose(() => {
      settingsPanel = undefined;
    });
    settingsPanel.webview.onDidReceiveMessage(
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
        settingsOnSaved?.();
        pushHtml();
      },
      undefined,
      [],
    );
  }

  const pushHtml = (): void => {
    const cfg = vscode.workspace.getConfiguration('traderx');
    const sec = cfg.get<number>('refreshIntervalSeconds') ?? 3;
    const rawMode = cfg.get<string>('intradayDisplayMode');
    const displayMode = normalizeIntradayDisplayMode(rawMode);
    const pageProvider = normalizeStoredPageProvider(cfg.get<string>('intradayPageProvider'));
    const stealth = cfg.get<boolean>('intradayStealthMode') === true;
    settingsPanel!.webview.html = buildSettingsHtml(sec, displayMode, pageProvider, stealth);
  };

  pushHtml();
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
  const settingsMain = `
  <h1>全局设置</h1>
  <label for="sec">行情自动刷新间隔（秒）</label>
  <input type="number" id="sec" min="3" max="300" step="1" value="${refreshSeconds}" />
  <p class="hint">范围 3～300，保存后立即作用于侧栏自动刷新。</p>
  <label>分时与侧栏</label>
  <div class="row">
    <input type="checkbox" id="stealth" ${stealthChecked} />
    <span>低调办公</span>
  </div>
  <p class="hint">开启后：页面显示更低调；分时固定打开低调分时页。开启时忽略下方「查看方式 / 站点」。</p>
  <label for="mode">分时查看方式（未开启低调办公时生效）</label>
  <select id="mode">${sel(displayMode, [
    { v: 'simpleBrowser', t: '内置 Simple Browser' },
    { v: 'systemBrowser', t: '系统默认浏览器' },
  ])}</select>
  <p class="hint">内置浏览器不可用时将自动改用系统浏览器。</p>
  <label for="site">行情页站点</label>
  <select id="site">${sel(pageProvider, [
    { v: 'eastmoney_full', t: '东方财富完整行情（PC 个股页）' },
    { v: 'eastmoney_discreet', t: '东方财富低调分时页' },
  ])}</select>
  <button id="save">保存</button>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>全局设置</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 96%, black 4%) 0%, var(--vscode-editor-background) 100%);
      padding: 18px;
      margin: 0;
    }
    h1 {
      font-size: 18px;
      margin: 0 0 14px 0;
      letter-spacing: .02em;
    }
    .traderx-settings-card {
      max-width: 560px;
      padding: 18px;
      border-radius: 0;
      background: linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 97%, white 3%) 0%, color-mix(in srgb, var(--vscode-editor-background) 99%, black 1%) 100%);
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
      box-shadow: none;
    }
    label {
      display: block;
      margin: 14px 0 6px;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    input[type="number"], select {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      background: color-mix(in srgb, var(--vscode-input-background) 90%, white 10%);
      color: var(--vscode-input-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-input-border) 70%, transparent);
      border-radius: 0;
      outline: none;
    }
    input[type="number"]:focus, select:focus {
      border-color: color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 40%, transparent);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 0;
      background: color-mix(in srgb, var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,.04)) 82%, black 2%);
      border-left: 2px solid color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 32%, transparent);
    }
    button {
      margin-top: 18px;
      background: color-mix(in srgb, var(--vscode-button-background) 88%, white 12%);
      color: var(--vscode-button-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 14%, transparent);
      padding: 9px 18px;
      border-radius: 0;
      cursor: pointer;
      transition: background .16s ease, border-color .16s ease;
    }
    button:hover { border-color: color-mix(in srgb, var(--vscode-focusBorder, #4c8dff) 30%, transparent); }
    button:active { background: color-mix(in srgb, var(--vscode-button-background) 82%, black 18%); }
    .hint {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-top: 6px;
      line-height: 1.6;
      padding-left: 10px;
      border-left: 2px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
    }
    ${STEALTH_OFFICE_STYLE_SNIPPET}
  </style>
</head>
<body${stealthOfficeBodyAttrs(stealth)}>
  ${stealthOfficeContentWrap(stealth, `<div class="traderx-settings-card">${settingsMain}</div>`)}
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
