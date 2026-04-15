import * as vscode from 'vscode';
import { GLOBAL_STOCK_KLINE_LINKS, MAJOR_INDEX_KLINE_LINKS } from './marketIndexLinks';

/** 与 marketDetailPanel.openMarketPage 约定一致 */
export type MarketOpenPayload =
  | { kind: 'globalIndex' }
  | { kind: 'indexKline'; title: string; url: string; intradayUrl?: string }
  | { kind: 'industryRise' }
  | { kind: 'industryMoney'; fenlei: '0' | '1' | '2'; title: string }
  | { kind: 'stockMoneyRank'; sort: string; title: string }
  | { kind: 'stockMoneyTrend' };

const STOCK_MONEY_RANKS: { sort: string; title: string }[] = [
  { sort: 'netamount', title: '净流入额排名' },
  { sort: 'outamount', title: '流出资金排名' },
  { sort: 'ratioamount', title: '净流入率排名' },
  { sort: 'r0_net', title: '主力净流入额排名' },
  { sort: 'r0_out', title: '主力流出排名' },
  { sort: 'r0_ratio', title: '主力净流入率排名' },
  { sort: 'r3_net', title: '散户净流入额排名' },
  { sort: 'r3_out', title: '散户流出排名' },
  { sort: 'r3_ratio', title: '散户净流入率排名' },
];

export class MarketItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly nodeId: string,
    public readonly openPayload?: MarketOpenPayload,
  ) {
    super(label, collapsibleState);
    this.tooltip = label;
    if (openPayload && collapsibleState === vscode.TreeItemCollapsibleState.None) {
      this.command = {
        command: 'traderx.market.openPage',
        title: '打开',
        arguments: [openPayload],
      };
    }
  }
}

export class MarketNavigatorProvider implements vscode.TreeDataProvider<MarketItem> {
  public static readonly viewId = 'traderx.marketNavigator';

  private readonly _onDidChange = new vscode.EventEmitter<MarketItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: MarketItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: MarketItem): Thenable<MarketItem[]> {
    if (!element) {
      return Promise.resolve([
        new MarketItem('全球股指', vscode.TreeItemCollapsibleState.Collapsed, 'mkt.global'),
        new MarketItem('行业排名', vscode.TreeItemCollapsibleState.Collapsed, 'mkt.industry'),
        new MarketItem('个股资金流向', vscode.TreeItemCollapsibleState.Collapsed, 'mkt.stock'),
      ]);
    }
    switch (element.nodeId) {
      case 'mkt.global':
        return Promise.resolve([
          new MarketItem('全球指数', vscode.TreeItemCollapsibleState.None, 'mkt.g.idx', { kind: 'globalIndex' }),
          new MarketItem('全球股指-K线', vscode.TreeItemCollapsibleState.Collapsed, 'mkt.g.k'),
          new MarketItem('重大指数', vscode.TreeItemCollapsibleState.Collapsed, 'mkt.g.major'),
        ]);
      case 'mkt.g.k':
        return Promise.resolve(
          GLOBAL_STOCK_KLINE_LINKS.map(
            (x, i) =>
              new MarketItem(x.label, vscode.TreeItemCollapsibleState.None, `mkt.g.k.${i}`, {
                kind: 'indexKline',
                title: x.label,
                url: x.url,
                intradayUrl: x.intradayUrl,
              }),
          ),
        );
      case 'mkt.g.major':
        return Promise.resolve(
          MAJOR_INDEX_KLINE_LINKS.map(
            (x, i) =>
              new MarketItem(x.label, vscode.TreeItemCollapsibleState.None, `mkt.g.m.${i}`, {
                kind: 'indexKline',
                title: x.label,
                url: x.url,
                intradayUrl: x.intradayUrl,
              }),
          ),
        );
      case 'mkt.industry':
        return Promise.resolve([
          new MarketItem('行业涨幅排名', vscode.TreeItemCollapsibleState.None, 'mkt.ind.rise', { kind: 'industryRise' }),
          new MarketItem('行业资金排名(净流入)', vscode.TreeItemCollapsibleState.None, 'mkt.ind.m0', {
            kind: 'industryMoney',
            fenlei: '0',
            title: '行业资金排名(净流入)',
          }),
          new MarketItem('证监会行业资金排名(净流入)', vscode.TreeItemCollapsibleState.None, 'mkt.ind.m2', {
            kind: 'industryMoney',
            fenlei: '2',
            title: '证监会行业资金排名(净流入)',
          }),
          new MarketItem('概念板块资金排名(净流入)', vscode.TreeItemCollapsibleState.None, 'mkt.ind.m1', {
            kind: 'industryMoney',
            fenlei: '1',
            title: '概念板块资金排名(净流入)',
          }),
        ]);
      case 'mkt.stock':
        return Promise.resolve([
          ...STOCK_MONEY_RANKS.map(
            (x, i) =>
              new MarketItem(x.title, vscode.TreeItemCollapsibleState.None, `mkt.st.r.${i}`, {
                kind: 'stockMoneyRank',
                sort: x.sort,
                title: x.title,
              }),
          ),
          new MarketItem('个股按日资金流向', vscode.TreeItemCollapsibleState.None, 'mkt.st.trend', { kind: 'stockMoneyTrend' }),
        ]);
      default:
        return Promise.resolve([]);
    }
  }
}
