import * as vscode from 'vscode';
import { pickStockWithSearch } from './addStockPicker';
import type { NormalizedCode } from './stockCode';
import { QuoteService } from './services/quoteService';
import { isCnAshareCallAuctionWindow } from './marketHours';
import type { QuoteRow } from './types';

const MAX_SLOTS = 3;
const CONFIG_SECTION = 'traderx';

function fmtNum(n: number | null | undefined, digits: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toFixed(digits);
}

function fmtAmountYuan(yuan: number | null | undefined): string {
  if (yuan === null || yuan === undefined || Number.isNaN(yuan)) return '—';
  const turnoverDisplay = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('turnoverDisplay') ?? 'yi';
  if (turnoverDisplay === 'wan') return (yuan / 1e4).toFixed(2) + '万';
  return (yuan / 1e8).toFixed(2) + '亿';
}

function buildTooltip(r: QuoteRow): string {
  const lines = [
    '代码：' + (r.code ?? '—'),
    '名称：' + (r.name ?? '—'),
    '现价：' + fmtNum(r.price, 2),
    '涨跌幅%：' + fmtNum(r.changePct, 2),
  ];
  if (r.prevClose !== null && r.prevClose !== undefined && !Number.isNaN(r.prevClose)) {
    lines.push('昨收：' + fmtNum(r.prevClose, 2));
  }
  if (isCnAshareCallAuctionWindow(new Date())) {
    if (r.bidPrice !== null && r.bidPrice !== undefined && !Number.isNaN(r.bidPrice)) {
      lines.push('竞买价：' + fmtNum(r.bidPrice, 2));
    }
    if (r.askPrice !== null && r.askPrice !== undefined && !Number.isNaN(r.askPrice)) {
      lines.push('竞卖价：' + fmtNum(r.askPrice, 2));
    }
  }
  lines.push(
    '最高：' + fmtNum(r.high, 2),
    '最低：' + fmtNum(r.low, 2),
  );
  if (isCnAshareCallAuctionWindow(new Date())) {
    lines.push('竞价成交额：' + fmtAmountYuan(r.amountYuan));
  } else {
    lines.push('成交额：' + fmtAmountYuan(r.amountYuan));
  }
  return lines.join('\n');
}

export class StatusBarManager {
  private items: vscode.StatusBarItem[] = [];
  private quoteService: QuoteService;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(context: vscode.ExtensionContext, quoteService: QuoteService) {
    this.quoteService = quoteService;

    context.subscriptions.push(
      vscode.commands.registerCommand('traderx.statusBar.pickStock', async (slot: number) => {
        await this.pickStockForSlot(slot);
      }),
    );

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('traderx.statusBar')) {
          this.rebuild();
        }
      }),
    );

    context.subscriptions.push({ dispose: () => this.dispose() });

    this.rebuild();
  }

  private getStatusBarConfig() {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const enabled = cfg.get<boolean>('statusBar.enabled') ?? false;
    const stocks: string[] = (cfg.get<string[]>('statusBar.stocks') ?? []).slice(0, MAX_SLOTS);
    return { enabled, stocks };
  }

  private async updateConfigStocks(stocks: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await cfg.update('statusBar.stocks', stocks, vscode.ConfigurationTarget.Global);
  }

  private getRefreshIntervalMs(): number {
    const sec = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('refreshIntervalSeconds') ?? 3;
    return Math.max(3, Math.min(300, sec)) * 1000;
  }

  private disposeItems(): void {
    for (const item of this.items) {
      item.dispose();
    }
    this.items = [];
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  rebuild(): void {
    this.disposeItems();
    this.stopTimer();

    const { enabled, stocks } = this.getStatusBarConfig();
    if (!enabled) return;

    const validCodes = stocks.filter(Boolean) as NormalizedCode[];

    for (let i = 0; i < MAX_SLOTS; i++) {
      const code = validCodes[i];
      const item = vscode.window.createStatusBarItem(
        `traderx.statusBar.stock${i}`,
        vscode.StatusBarAlignment.Right,
        100 - i,
      );
      item.command = {
        title: code ? '更换股票' : '添加股票',
        command: 'traderx.statusBar.pickStock',
        arguments: [i],
      };

      if (code) {
        item.text = `$(graph) ${code} —`;
        item.tooltip = '加载中…';
      } else {
        item.text = `$(add) 添加`;
        item.tooltip = '点击添加状态栏股票';
      }
      item.show();
      this.items.push(item);
    }

    if (validCodes.length > 0) {
      this.startPolling(validCodes);
    }
  }

  private startPolling(codes: NormalizedCode[]): void {
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        const rows = await this.quoteService.fetchRowsBasic(codes, {});
        for (let i = 0; i < Math.min(rows.length, this.items.length); i++) {
          const row = rows[i];
          const item = this.items[i];
          if (!item) continue;

          if (row.price === null && row.changePct === null) {
            item.text = `$(warning) ${row.code} —`;
          } else {
            const pct = row.changePct ?? 0;
            const sign = pct > 0 ? '+' : '';
            item.text = `$(graph) ${row.code} ${sign}${fmtNum(pct, 2)}%`;
          }
          item.tooltip = buildTooltip(row);
        }
      } catch {
        // 静默处理刷新错误，保留上次数据
      }
    };

    void tick();
    this.timer = setInterval(() => {
      void tick();
    }, this.getRefreshIntervalMs());
  }

  private async pickStockForSlot(slot: number): Promise<void> {
    const picked = await pickStockWithSearch();
    if (!picked) return;

    const { stocks } = this.getStatusBarConfig();
    const arr = [...stocks];
    while (arr.length <= slot) {
      arr.push('');
    }
    arr[slot] = picked;
    // 去除尾部空位
    while (arr.length > 0 && !arr[arr.length - 1]) {
      arr.pop();
    }
    // 去重：同代码只保留第一个
    const seen = new Set<string>();
    const deduped = arr.filter((c) => {
      if (!c || seen.has(c)) return false;
      seen.add(c);
      return true;
    });
    await this.updateConfigStocks(deduped);
  }

  dispose(): void {
    this.running = false;
    this.stopTimer();
    this.disposeItems();
  }
}
