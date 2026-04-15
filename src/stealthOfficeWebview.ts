import * as vscode from 'vscode';

/**
 * 全局「低调办公」开关（与分时 h5chart、侧栏一致）。
 * 低调显示：遮罩层 + 内容灰度，弱化红绿与彩色。
 */
export function isStealthOfficeEnabled(): boolean {
  return vscode.workspace.getConfiguration('traderx').get<boolean>('intradayStealthMode') === true;
}

/** 仅遮罩（不灰度），用于内嵌东财 iframe：祖先 `filter` 会导致页内 Canvas 不绘制 */
export const STEALTH_SCRIM_SNIPPET = `
    .traderx-stealth-scrim {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      pointer-events: none;
      background: rgba(72, 72, 72, 0.14);
      box-shadow: inset 0 0 120px rgba(0, 0, 0, 0.08);
    }
    body.traderx-stealth-office .traderx-stealth-scrim {
      display: block;
    }
`;

/** 内容灰度：需配合 `.traderx-stealth-inner`（勿用于包裹 iframe 分时图） */
export const STEALTH_INNER_GRAY_SNIPPET = `
    body.traderx-stealth-office .traderx-stealth-inner {
      position: relative;
      z-index: 0;
      filter: grayscale(1) saturate(0);
      -webkit-filter: grayscale(1) saturate(0);
    }
`;

/** 嵌入各 Webview：遮罩 + 内层灰度（表格/设置等 DOM 页面） */
export const STEALTH_OFFICE_STYLE_SNIPPET = STEALTH_SCRIM_SNIPPET + STEALTH_INNER_GRAY_SNIPPET;

/** 独立面板用：整页低调办公时给 body 加类并包一层 inner */
export function stealthOfficeBodyAttrs(stealth: boolean): string {
  return stealth ? ' class="traderx-stealth-office"' : '';
}

export function stealthOfficeContentWrap(stealth: boolean, innerHtml: string): string {
  if (!stealth) {
    return innerHtml;
  }
  return `<div class="traderx-stealth-scrim" aria-hidden="true"></div><div class="traderx-stealth-inner">${innerHtml}</div>`;
}

/**
 * 分时/指数 iframe：只加遮罩，**不要**包 `.traderx-stealth-inner`（避免 filter 导致图表空白）。
 */
export function stealthOfficeChartWrap(stealth: boolean, innerHtml: string): string {
  if (!stealth) {
    return innerHtml;
  }
  return `<div class="traderx-stealth-scrim" aria-hidden="true"></div>${innerHtml}`;
}

/** 东财 iframe 铺满 Webview 视口（与 body 直接子级配合） */
export const STEALTH_CHART_IFRAME_LAYOUT_SNIPPET = `
    html, body {
      height: 100%;
      margin: 0;
      overflow: hidden;
      box-sizing: border-box;
    }
    iframe.traderx-chart-iframe {
      position: fixed;
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
      width: 100%;
      height: 100%;
      max-width: 100%;
      max-height: 100%;
      border: 0;
      z-index: 0;
      background: var(--vscode-editor-background);
    }
`;
