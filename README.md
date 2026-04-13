# TraderX（A 股自选）

这是一个用于在 VS Code 侧边栏查看 **A 股自选行情** 的扩展：展示现价、涨跌幅、**主力净流入（万元）**、当日高/低、成交额，并支持为每只股票记录 **成本价与持仓股数** 以估算 **浮动盈亏**。

## 免责声明

- 本扩展 **不提供投资建议**；行情与资金数据来自公开 HTTP 接口聚合，可能存在延迟、缺失、字段变更或访问限制。
- **非官方数据源无 SLA**，请勿用于关键交易决策；使用本扩展的风险由使用者自行承担。
- 成本与持仓仅保存在本机 VS Code 全局状态中，**不会上传到任何服务器**。

## 功能

- **分组自选**：支持新建 / 重命名 / 删除分组；删除分组时其中股票会 **合并到默认分组「自选」**。同一股票可存在于多个分组（复制到其他分组）；「移动」会从当前分组移除并加入目标分组。
- 侧栏 **分组下拉** 与 **添加（+）**、**刷新** 在同一行；**更多功能** 中可打开 **分组管理**、**全局设置** 页面。
- **添加自选**：支持按 **代码、股票名称、拼音首字母** 等通过东方财富搜索建议选型（亦可直接输入 6 位代码等）。
- 自动刷新：可在 **全局设置** 或 `settings.json` 中调整间隔（**默认 3 秒**，最小 3 秒）。
- 排序：点击表头按列排序；当前列与 **升序 ▲ / 降序 ▼** 会显示在表头；**每个分组单独记忆**，下次启动沿用。
- 持仓盈亏：命令 `TraderX: 编辑成本与持仓`，或在侧栏点「持仓」。
- **分时行情**：点击行或「分时」，用 **Simple Browser** 或 **系统浏览器** 打开东财页面；与 [LeekHub/leek-fund](https://github.com/LeekHub/leek-fund) 一致，站点仅两种：**东方财富完整行情**（`quote.eastmoney.com/shXXXXXX.html`）与 **东方财富低调模式**（`basic/h5chart-iframe.html`，LeekFund 沪深分时同款）。
- **低调办公**：侧栏 **灰度**；分时固定为 **h5chart-iframe** 低调页（失败则系统浏览器同 URL）。

## 数据源说明（实现概要）

- **基础行情**：优先使用 **新浪财经** `hq.sinajs.cn`，失败时按设置尝试 **腾讯财经** `qt.gtimg.cn`。
- **主力净流入**：**东方财富** `push2.eastmoney.com/api/qt/stock/get`（带 `ut` 等参数），优先 **f169**，必要时用 **f62/f184** 换算为万元。
- **搜索建议**：东方财富 `searchadapter.eastmoney.com/api/suggest/get`。
- **分时数据**：侧栏行情与主力净流入仍由新浪/腾讯/东财接口聚合；**打开分时**时通过浏览器访问上述第三方页面，不在扩展内自绘。

## 配置项

- `traderx.refreshIntervalSeconds`：自动刷新间隔（秒），默认 `3`
- `traderx.quoteProviderOrder`：基础行情源顺序（`sina` / `tencent`）
- `traderx.turnoverDisplay`：成交额展示为 `万` 或 `亿`
- `traderx.intradayStealthMode`：低调办公（默认 `false`）；为 `true` 时忽略下面两项
- `traderx.intradayDisplayMode`：`simpleBrowser`（默认）/ `systemBrowser`
- `traderx.intradayPageProvider`：`eastmoney_full`（完整 PC 个股页）/ `eastmoney_discreet`（h5chart-iframe）

## 本地开发与调试

1. 安装依赖：`npm install`
2. 编译：`npm run compile`（或 `npm run watch`）
3. 在 VS Code 中打开本项目，按 **F5** 启动扩展开发宿主

## 命令

- `TraderX: 添加自选`（加入当前分组，打开搜索列表）
- `TraderX: 从当前分组删除自选`
- `TraderX: 编辑成本与持仓`
- `TraderX: 刷新行情`
- `TraderX: 新建分组` / `TraderX: 重命名分组` / `TraderX: 删除分组`
- `TraderX: 打开分时行情` / `TraderX: 选择站点打开分时`（临时选东方财富 / 新浪 / 腾讯等）
- `TraderX: 分组管理` / `TraderX: 全局设置`
