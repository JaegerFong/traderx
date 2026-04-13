import * as vscode from 'vscode';
import type { NormalizedCode } from './stockCode';
import { searchStocksEastmoney } from './providers/stockSuggest';

/**
 * 通过 QuickPick 搜索并选择股票（代码 / 名称 / 拼音首字母）。
 */
export async function pickStockWithSearch(): Promise<NormalizedCode | undefined> {
  const qp = vscode.window.createQuickPick();
  qp.placeholder = '输入代码、股票名称或拼音首字母搜索';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  const runSearch = async (value: string): Promise<void> => {
    const my = ++seq;
    qp.busy = true;
    try {
      const items = await searchStocksEastmoney(value);
      if (my !== seq) {
        return;
      }
      qp.items = items.map((x) => ({
        label: `${x.code}  ${x.name}`,
        description: x.name,
        code: x.code,
      })) as (vscode.QuickPickItem & { code: NormalizedCode })[];
    } catch {
      if (my === seq) {
        qp.items = [];
      }
    } finally {
      if (my === seq) {
        qp.busy = false;
      }
    }
  };

  qp.onDidChangeValue((v) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      void runSearch(v);
    }, 220);
  });

  return await new Promise<NormalizedCode | undefined>((resolve) => {
    let finished = false;
    const done = (v: NormalizedCode | undefined): void => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(v);
      qp.dispose();
    };

    qp.onDidAccept(() => {
      const it = qp.selectedItems[0] as vscode.QuickPickItem & { code?: NormalizedCode };
      done(it?.code);
    });

    qp.onDidHide(() => done(undefined));

    qp.show();
    void runSearch('');
  });
}
