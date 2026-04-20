import * as vscode from 'vscode';
import { pickStockWithSearch } from './addStockPicker';
import { openGroupManagePanel } from './groupManagePanel';
import { openIntradayPanel, openIntradayQuotePage } from './intradayPanel';
import type { IntradayPageProvider } from './stockUrls';
import type { NormalizedCode } from './stockCode';
import { QuoteService } from './services/quoteService';
import { openTraderxSettingsPanel } from './settingsPanel';
import { DEFAULT_GROUP_ID, WatchlistStore } from './storage/watchlistStore';
import { openMarketPage } from './marketDetailPanel';
import { MarketNavigatorProvider, type MarketOpenPayload } from './marketNavigatorTree';
import { WatchlistViewProvider } from './watchlistView';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new WatchlistStore(context);
  await store.ready();

  const quoteService = new QuoteService();
  const watchView = new WatchlistViewProvider(context, store, quoteService);
  context.subscriptions.push(watchView);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WatchlistViewProvider.viewId, watchView),
    vscode.window.registerWebviewViewProvider(WatchlistViewProvider.viewIdPanel, watchView),
  );

  const marketNav = new MarketNavigatorProvider();
  context.subscriptions.push(
    vscode.window.createTreeView(MarketNavigatorProvider.viewId, { treeDataProvider: marketNav }),
    vscode.window.createTreeView(MarketNavigatorProvider.viewIdPanel, { treeDataProvider: marketNav }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.openMarket', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.traderx');
    }),
    vscode.commands.registerCommand('traderx.openTraderxPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.traderx-panel');
    }),
    vscode.commands.registerCommand('traderx.backToEditor', async () => {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }),
    vscode.commands.registerCommand('traderx.openExplorerView', async () => {
      await vscode.commands.executeCommand('workbench.view.explorer');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.market.openPage', (payload: MarketOpenPayload) => {
      openMarketPage(context, payload);
    }),
  );

  const refreshWatch = (): void => {
    void watchView.refresh('external');
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.addStock', async () => {
      const picked = await pickStockWithSearch();
      if (!picked) {
        return;
      }
      const gid = store.getActiveGroupId();
      await store.addCodeToGroup(gid, picked);
      vscode.window.showInformationMessage(`已添加到分组：${store.getGroupById(gid)?.name ?? gid} / ${picked}`);
      // 仅增量更新新增行，避免全列表刷新
      if (gid === store.getActiveGroupId()) {
        await watchView.addStockIncremental(picked);
      } else {
        await watchView.refresh('addStock');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.removeStock', async () => {
      const gid = store.getActiveGroupId();
      const codes = store.getCodesForActiveGroup();
      if (codes.length === 0) {
        vscode.window.showInformationMessage('当前分组没有自选');
        return;
      }
      const picked = await vscode.window.showQuickPick(codes, { placeHolder: '从当前分组删除（不影响其他分组同名股票）' });
      if (!picked) {
        return;
      }
      await store.removeCodeFromGroup(gid, picked);
      vscode.window.showInformationMessage(`已从当前分组删除：${picked}`);
      await watchView.removeStockIncremental(picked);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.editPosition', async (codeArg?: string) => {
      let code = codeArg;
      if (!code) {
        const codes = store.getCodesForActiveGroup();
        if (codes.length === 0) {
          vscode.window.showInformationMessage('当前分组没有自选');
          return;
        }
        const picked = await vscode.window.showQuickPick(codes, { placeHolder: '选择股票' });
        if (!picked) {
          return;
        }
        code = picked;
      } else if (!store.hasCodeInAnyGroup(code)) {
        vscode.window.showWarningMessage('该代码不在任何自选分组中');
        return;
      }

      const costStr = await vscode.window.showInputBox({
        title: `编辑成本价：${code}`,
        prompt: '成本价（元/股），留空表示不记录',
        value: store.getPositions()[code!]?.cost !== undefined ? String(store.getPositions()[code!]!.cost) : '',
      });
      if (costStr === undefined) {
        return;
      }

      const sharesStr = await vscode.window.showInputBox({
        title: `编辑持仓股数：${code}`,
        prompt: '持仓股数（股），留空表示不记录',
        value: store.getPositions()[code!]?.shares !== undefined ? String(store.getPositions()[code!]!.shares) : '',
      });
      if (sharesStr === undefined) {
        return;
      }

      const cost = costStr.trim() === '' ? undefined : Number(costStr);
      const shares = sharesStr.trim() === '' ? undefined : Number(sharesStr);

      if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) {
        vscode.window.showErrorMessage('成本价无效');
        return;
      }
      if (shares !== undefined && (!Number.isFinite(shares) || shares < 0 || !Number.isInteger(shares))) {
        vscode.window.showErrorMessage('持仓股数应为非负整数');
        return;
      }

      await store.setPosition(code!, { cost, shares });
      vscode.window.showInformationMessage(`已保存持仓：${code}`);
      await watchView.editPositionIncremental(code!);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.refreshQuotes', async () => {
      await watchView.refresh('command');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.createGroup', async () => {
      const name = await vscode.window.showInputBox({ title: '新建分组', prompt: '分组名称' });
      if (name === undefined) {
        return;
      }
      await store.createGroup(name);
      vscode.window.showInformationMessage('已创建分组');
      await watchView.refresh('createGroup');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.renameGroup', async () => {
      const groups = store.getGroups();
      const picked = await vscode.window.showQuickPick(
        groups.map((g) => ({ label: g.name, gid: g.id })),
        { placeHolder: '选择要重命名的分组' },
      );
      if (!picked || !('gid' in picked)) {
        return;
      }
      const name = await vscode.window.showInputBox({ title: '重命名分组', value: picked.label });
      if (name === undefined) {
        return;
      }
      await store.renameGroup(picked.gid as string, name);
      await watchView.refresh('renameGroup');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.deleteGroup', async () => {
      const groups = store.getGroups().filter((g) => g.id !== DEFAULT_GROUP_ID);
      if (groups.length === 0) {
        vscode.window.showInformationMessage('没有可删除的分组（默认分组不可删）');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        groups.map((g) => ({ label: g.name, gid: g.id, description: `${g.codes.length} 只` })),
        { placeHolder: '删除分组：其中股票将合并到「自选」' },
      );
      if (!picked || !('gid' in picked)) {
        return;
      }
      try {
        await store.deleteGroup(picked.gid as string);
        vscode.window.showInformationMessage(`已删除分组，股票已合并到「自选」`);
        await watchView.refresh('deleteGroup');
      } catch (e) {
        vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.openIntraday', async (codeArg?: NormalizedCode) => {
      let code = codeArg;
      if (!code) {
        const codes = store.getCodesForActiveGroup();
        if (codes.length === 0) {
          vscode.window.showInformationMessage('当前分组没有自选');
          return;
        }
        const picked = await vscode.window.showQuickPick(codes, { placeHolder: '选择股票查看分时' });
        if (!picked) {
          return;
        }
        code = picked as NormalizedCode;
      }
      await openIntradayPanel(code);
    }),
  );

  const intradayPlatformChoices: { label: string; description: string; provider: IntradayPageProvider }[] = [
    { label: '东方财富完整行情', description: 'PC 个股页', provider: 'eastmoney_full' },
    { label: '东方财富低调分时页', description: 'h5chart 分时', provider: 'eastmoney_discreet' },
  ];

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.openIntradayPickPlatform', async (codeArg?: NormalizedCode) => {
      let code = codeArg;
      if (!code) {
        const codes = store.getCodesForActiveGroup();
        if (codes.length === 0) {
          vscode.window.showInformationMessage('当前分组没有自选');
          return;
        }
        const picked = await vscode.window.showQuickPick(codes, { placeHolder: '选择股票' });
        if (!picked) {
          return;
        }
        code = picked as NormalizedCode;
      }
      if (vscode.workspace.getConfiguration('traderx').get<boolean>('intradayStealthMode') === true) {
        await openIntradayPanel(code);
        return;
      }
      const site = await vscode.window.showQuickPick(intradayPlatformChoices, {
        placeHolder: '选择要打开的行情站点（内置 Simple Browser，失败则系统浏览器）',
      });
      if (!site) {
        return;
      }
      await openIntradayQuotePage(code, site.provider);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.openGroupManage', () => {
      openGroupManagePanel(store, refreshWatch);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('traderx.openSettings', () => {
      // 保存设置后先轻量同步 UI，避免立即全量拉行情造成等待
      openTraderxSettingsPanel(() => watchView.refreshUiOnly('settingsSaved'));
    }),
  );
}

export function deactivate(): void {}
