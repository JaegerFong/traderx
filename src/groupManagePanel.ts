import * as vscode from 'vscode';
import { DEFAULT_GROUP_ID, type WatchlistStore } from './storage/watchlistStore';
import {
  isStealthOfficeEnabled,
  STEALTH_OFFICE_STYLE_SNIPPET,
  stealthOfficeBodyAttrs,
  stealthOfficeContentWrap,
} from './stealthOfficeWebview';

let groupManagePanel: vscode.WebviewPanel | undefined;
let groupManageStore: WatchlistStore | undefined;
let groupManageOnGroupsChanged: (() => void) | undefined;

export function openGroupManagePanel(
  store: WatchlistStore,
  onGroupsChanged: () => void,
): void {
  groupManageStore = store;
  groupManageOnGroupsChanged = onGroupsChanged;
  if (groupManagePanel) {
    groupManagePanel.reveal(vscode.ViewColumn.One);
  } else {
    groupManagePanel = vscode.window.createWebviewPanel(
      'traderx.groupManage',
      'TraderX 分组管理',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    groupManagePanel.onDidDispose(() => {
      groupManagePanel = undefined;
      groupManageStore = undefined;
      groupManageOnGroupsChanged = undefined;
    });
    groupManagePanel.webview.onDidReceiveMessage(
      async (msg: { type?: string; id?: string; name?: string; order?: string[] }) => {
        const panel = groupManagePanel;
        const store = groupManageStore;
        const onGroupsChanged = groupManageOnGroupsChanged;
        if (!panel || !store || !onGroupsChanged) {
          return;
        }
        const pushState = (): void => {
          const groups = store.getGroups();
          panel.webview.postMessage({ type: 'state', groups });
        };
        if (msg.type === 'ready') {
          pushState();
          return;
        }
        if (msg.type === 'create') {
          const name = await vscode.window.showInputBox({ title: '新建分组', prompt: '分组名称' });
          if (name !== undefined && name.trim()) {
            await store.createGroup(name);
            onGroupsChanged();
            pushState();
          }
          return;
        }
        if (msg.type === 'rename' && msg.id) {
          const g = store.getGroupById(msg.id);
          if (!g) {
            return;
          }
          const name = await vscode.window.showInputBox({ title: '重命名分组', value: g.name });
          if (name !== undefined && name.trim()) {
            await store.renameGroup(msg.id, name);
            onGroupsChanged();
            pushState();
          }
          return;
        }
        if (msg.type === 'delete' && msg.id) {
          if (msg.id === DEFAULT_GROUP_ID) {
            vscode.window.showWarningMessage('默认分组「自选」不可删除');
            return;
          }
          const ok = await vscode.window.showWarningMessage(
            `确定删除分组？其中股票将合并到「自选」。`,
            { modal: true },
            '删除',
          );
          if (ok === '删除') {
            try {
              await store.deleteGroup(msg.id);
              onGroupsChanged();
              pushState();
            } catch (e) {
              vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
            }
          }
          return;
        }
        if (msg.type === 'reorder' && Array.isArray(msg.order)) {
          await store.reorderGroups(msg.order);
          onGroupsChanged();
          pushState();
          return;
        }
      },
      undefined,
      [],
    );
  }

  groupManagePanel.webview.html = buildGroupManageHtml(isStealthOfficeEnabled());
  // 触发刷新（若页面已加载则会立刻更新）
  const groups = store.getGroups();
  void groupManagePanel.webview.postMessage({ type: 'state', groups });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildGroupManageHtml(stealth: boolean): string {
  const nonce = String(Math.random()).slice(2);
  const main = `
  <h1>分组管理</h1>
  <p class="hint">默认分组「自选」不可删除；删除分组时，其中股票会合并到「自选」。</p>
  <button id="btnNew">新建分组</button>
  <table>
    <thead><tr><th style="width:26px"></th><th>名称</th><th>股票数</th><th>操作</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>分组管理</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; margin: 0; }
    h1 { font-size: 16px; margin: 0 0 12px 0; }
    .hint { color: var(--vscode-descriptionForeground); margin-bottom: 12px; line-height: 1.5; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 2px; cursor: pointer; margin-right: 8px; margin-bottom: 8px; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    .actions button { margin: 0 6px 0 0; padding: 4px 8px; font-size: 12px; }
    tr.dragging { opacity: .6; }
    td.handle { width: 26px; color: var(--vscode-descriptionForeground); cursor: grab; user-select:none; }
    td.handle:active { cursor: grabbing; }
    ${STEALTH_OFFICE_STYLE_SNIPPET}
  </style>
</head>
<body${stealthOfficeBodyAttrs(stealth)}>
  ${stealthOfficeContentWrap(stealth, main)}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let groupsCache = [];
    function render(groups) {
      groupsCache = groups || [];
      const tb = document.getElementById('tbody');
      tb.innerHTML = '';
      for (const g of groups) {
        const tr = document.createElement('tr');
        const isDefault = g.id === ${JSON.stringify(DEFAULT_GROUP_ID)};
        tr.setAttribute('data-gid', g.id);
        tr.draggable = !isDefault;
        tr.innerHTML = '<td class="handle" title="拖动排序（默认分组固定置顶）">≡</td><td>' + esc(g.name) + '</td><td>' + g.codes.length + '</td><td class="actions"></td>';
        const td = tr.querySelector('.actions');
        if (!td) continue;
        const b1 = document.createElement('button');
        b1.className = 'secondary';
        b1.textContent = '重命名';
        b1.onclick = () => vscode.postMessage({ type: 'rename', id: g.id });
        td.appendChild(b1);
        if (!isDefault) {
          const b2 = document.createElement('button');
          b2.className = 'secondary';
          b2.textContent = '删除';
          b2.onclick = () => vscode.postMessage({ type: 'delete', id: g.id });
          td.appendChild(b2);
        }
        tb.appendChild(tr);
      }
    }
    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'state' && e.data.groups) {
        render(e.data.groups);
      }
    });
    let dragId = null;
    function currentOrderIds() {
      const ids = [];
      document.querySelectorAll('#tbody tr[data-gid]').forEach((tr) => {
        const id = tr.getAttribute('data-gid');
        if (id) ids.push(id);
      });
      return ids;
    }
    document.addEventListener('dragstart', (e) => {
      const tr = e.target && e.target.closest ? e.target.closest('tr[data-gid]') : null;
      if (!tr) return;
      const gid = tr.getAttribute('data-gid');
      if (!gid || gid === ${JSON.stringify(DEFAULT_GROUP_ID)}) {
        e.preventDefault();
        return;
      }
      dragId = gid;
      tr.classList.add('dragging');
      e.dataTransfer && (e.dataTransfer.effectAllowed = 'move');
    });
    document.addEventListener('dragend', (e) => {
      document.querySelectorAll('tr.dragging').forEach((x) => x.classList.remove('dragging'));
      dragId = null;
    });
    document.addEventListener('dragover', (e) => {
      if (!dragId) return;
      const tr = e.target && e.target.closest ? e.target.closest('tr[data-gid]') : null;
      if (!tr) return;
      const overId = tr.getAttribute('data-gid');
      if (!overId || overId === dragId) return;
      if (overId === ${JSON.stringify(DEFAULT_GROUP_ID)}) return; // 默认分组固定
      e.preventDefault();
      const tb = document.getElementById('tbody');
      const dragging = tb.querySelector('tr[data-gid=\"' + dragId + '\"]');
      if (!dragging) return;
      const rect = tr.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      if (before) tb.insertBefore(dragging, tr);
      else tb.insertBefore(dragging, tr.nextSibling);
    });
    document.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const ids = currentOrderIds();
      vscode.postMessage({ type: 'reorder', order: ids });
    });
    document.getElementById('btnNew').onclick = () => vscode.postMessage({ type: 'create' });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
