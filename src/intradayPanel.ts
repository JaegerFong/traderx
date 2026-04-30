import * as vscode from 'vscode';
import type { NormalizedCode } from './stockCode';
import { getEastmoneyH5IntradayUrl, getIntradayQuoteUrl, type IntradayPageProvider } from './stockUrls';

export type IntradayDisplayMode = 'webviewCanvas' | 'simpleBrowser' | 'systemBrowser';

export function normalizeIntradayDisplayMode(raw: string | undefined): IntradayDisplayMode {
  if (raw === 'systemBrowser') {
    return 'systemBrowser';
  }
  if (raw === 'simpleBrowser') {
    return 'simpleBrowser';
  }
  return 'webviewCanvas';
}

const intradayPanels = new Map<NormalizedCode, vscode.WebviewPanel>();

function getActiveViewColumn(): vscode.ViewColumn {
  return vscode.window.activeTextEditor?.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn ?? vscode.ViewColumn.One;
}

function normalizePageProvider(cfg: vscode.WorkspaceConfiguration): IntradayPageProvider {
  const raw = cfg.get<string>('intradayPageProvider') ?? 'eastmoney_full';
  if (raw === 'eastmoney_discreet') {
    return 'eastmoney_discreet';
  }
  if (raw === 'eastmoney_full' || raw === 'eastmoney' || raw === 'sina' || raw === 'tencent') {
    return 'eastmoney_full';
  }
  return 'eastmoney_full';
}

export async function openIntradayPanel(code: NormalizedCode): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('traderx');
  const mode = normalizeIntradayDisplayMode(cfg.get<string>('intradayDisplayMode'));
  if (mode === 'systemBrowser') {
    await vscode.env.openExternal(vscode.Uri.parse(getIntradayQuoteUrl(code, normalizePageProvider(cfg))));
    return;
  }
  if (mode === 'simpleBrowser') {
    await openQuotePageInSimpleBrowserOrExternal(getIntradayQuoteUrl(code, normalizePageProvider(cfg)));
    return;
  }
  openLeekFundStyleIntradayPanel(code);
}

export async function openIntradayQuotePage(code: NormalizedCode, provider: IntradayPageProvider): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('traderx');
  const mode = normalizeIntradayDisplayMode(cfg.get<string>('intradayDisplayMode'));
  if (mode === 'systemBrowser') {
    await vscode.env.openExternal(vscode.Uri.parse(getIntradayQuoteUrl(code, provider)));
    return;
  }
  if (mode === 'simpleBrowser') {
    await openQuotePageInSimpleBrowserOrExternal(getIntradayQuoteUrl(code, provider));
    return;
  }
  openLeekFundStyleIntradayPanel(code);
}

async function openQuotePageInSimpleBrowserOrExternal(url: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('simpleBrowser.show', url);
  } catch {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

function openLeekFundStyleIntradayPanel(code: NormalizedCode): void {
  const existing = intradayPanels.get(code);
  if (existing) {
    existing.reveal(getActiveViewColumn());
    return;
  }

  const panel = vscode.window.createWebviewPanel('traderx.intradayEastmoney', `股票实时走势(${code})`, getActiveViewColumn(), {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  intradayPanels.set(code, panel);
  panel.onDidDispose(() => intradayPanels.delete(code));

  const nonce = String(Math.random()).slice(2);
  panel.webview.html = buildLeekFundStyleHtml(panel.webview, nonce, code);
}

function buildLeekFundStyleHtml(webview: vscode.Webview, nonce: string, code: NormalizedCode): string {
  const url = getEastmoneyH5IntradayUrl(code);
  const csp = [
    `default-src 'none';`,
    `style-src ${webview.cspSource} 'unsafe-inline';`,
    `script-src 'nonce-${nonce}';`,
    `frame-src https://quote.eastmoney.com;`,
  ].join(' ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>股票走势</title>
  <style>
    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    html.vscode-dark,
    body.vscode-dark,
    html.vscode-high-contrast,
    body.vscode-high-contrast {
      filter: invert(100%) hue-rotate(180deg);
    }
    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: #fff;
    }
  </style>
</head>
<body>
  <iframe src="${url}" referrerpolicy="no-referrer-when-downgrade"></iframe>
  <script nonce="${nonce}"></script>
</body>
</html>`;
}
