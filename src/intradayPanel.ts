import * as vscode from 'vscode';
import type { NormalizedCode } from './stockCode';
import { getIntradayQuoteUrl, type IntradayPageProvider } from './stockUrls';
/**
 * 分时查看方式（与 package.json 一致）。
 * 历史值 `webviewCanvas` 会当作 `simpleBrowser`。
 */
export type IntradayDisplayMode = 'simpleBrowser' | 'systemBrowser';

export function normalizeIntradayDisplayMode(raw: string | undefined): IntradayDisplayMode {
  if (raw === 'systemBrowser') {
    return 'systemBrowser';
  }
  return 'simpleBrowser';
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

/**
 * - **低调办公**：固定打开低调分时页
 * - **非低调**：按配置站点 + Simple Browser / 系统浏览器
 */
export async function openIntradayPanel(code: NormalizedCode): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('traderx');
  if (cfg.get<boolean>('intradayStealthMode') === true) {
    const url = getIntradayQuoteUrl(code, 'eastmoney_discreet');
    await openQuotePageInSimpleBrowserOrExternal(url);
    return;
  }

  const mode = normalizeIntradayDisplayMode(cfg.get<string>('intradayDisplayMode'));
  const provider = normalizePageProvider(cfg);
  const url = getIntradayQuoteUrl(code, provider);

  if (mode === 'systemBrowser') {
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }
  if (provider === 'eastmoney_discreet') {
    await openQuotePageInSimpleBrowserOrExternal(url);
    return;
  }
  await openQuotePageInSimpleBrowserOrExternal(url);
}

export async function openIntradayQuotePage(code: NormalizedCode, provider: IntradayPageProvider): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('traderx');
  if (cfg.get<boolean>('intradayStealthMode') === true) {
    await openIntradayPanel(code);
    return;
  }
  const url = getIntradayQuoteUrl(code, provider);
  const mode = normalizeIntradayDisplayMode(cfg.get<string>('intradayDisplayMode'));
  if (mode === 'systemBrowser') {
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }
  if (provider === 'eastmoney_discreet') {
    await openQuotePageInSimpleBrowserOrExternal(url);
    return;
  }
  await openQuotePageInSimpleBrowserOrExternal(url);
}

async function openQuotePageInSimpleBrowserOrExternal(url: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('simpleBrowser.show', url);
  } catch {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}
