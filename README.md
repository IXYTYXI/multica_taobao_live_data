# 淘宝直播数据采集工具

使用 Playwright（Node.js）连接本地已登录的 Chrome 浏览器（有头模式），自动化操作淘宝直播中控台，采集评论和订单数据并写入飞书多维表格。

## 功能

1. **自动进入直播间** — 打开直播计划列表，找到"直播中"的场次，点击进入中控台
2. **监控成交人数** — 持续监控中控台"实时表现"区域的成交人数变化
3. **采集近期评论** — 成交人数变化时，检查最近 5 分钟的评论
4. **查看订单详情** — 点击评论区"查看订单"图标，提取订单编号和支付时间
5. **写入飞书** — 将数据写入飞书多维表格

## 前置条件

1. **Node.js** ≥ 18.0.0
2. **Chrome 浏览器**以远程调试模式启动：
   ```bash
   # Windows
   chrome.exe --remote-debugging-port=9222

   # macOS
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

   # Linux
   google-chrome --remote-debugging-port=9222
   ```
3. 在 Chrome 中**已登录淘宝直播中控台**
4. 飞书应用已授权访问目标多维表格

## 安装

```bash
npm install
```

## 配置

复制 `.env.example` 为 `.env` 并填入实际值：

```bash
cp .env.example .env
```

配置项说明：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书应用 App ID | — |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret | — |
| `FEISHU_BASE_APP_TOKEN` | 多维表格 App Token | `D6JAbvNKZaUgMGsTfkPcgXn2nBd` |
| `FEISHU_TABLE_ID` | 数据表 ID | `tbluFzEQv1KRMsiG` |
| `CHROME_DEBUG_PORT` | Chrome 调试端口 | `9222` |
| `MONITOR_INTERVAL` | 监控间隔（秒） | `10` |
| `COMMENT_CHECK_MINUTES` | 评论检查范围（分钟） | `5` |

## 运行

```bash
npm start
```

## 飞书多维表格字段

目标表格应包含以下字段：

| 字段名 | 类型 | 说明 |
|--------|------|------|
| 评论者ID | 文本 | 评论者的淘宝用户ID |
| 评论时间 | 文本 | 评论时间（北京时间，格式 YYYY-MM-DD HH:mm:ss） |
| 评论内容 | 文本 | 评论文字内容 |
| 订单编号 | 文本 | 淘宝订单号 |
| 下单时间 | 文本 | 支付时间（北京时间） |

## 时区说明

本工具运行在美国东部时间的机器上，但所有时间判断和记录均基于北京时间（东八区 UTC+8）。使用 `dayjs` + timezone 插件处理时区转换。

## 项目结构

```
src/
├── index.js      # 主入口 — 监控循环和编排
├── config.js     # 配置管理（从 .env 加载）
├── browser.js    # 浏览器自动化（Playwright）
└── feishu.js     # 飞书 API（多维表格写入）
```

## 工作原理

```
┌─────────────┐     ┌────────────────┐     ┌───────────┐
│  Chrome      │────>│  Playwright    │────>│  飞书 API  │
│  (已登录)    │     │  自动化控制     │     │  写入表格  │
└─────────────┘     └────────────────┘     └───────────┘
       │                    │
       │    ┌───────────────┘
       │    │
       v    v
  淘宝直播中控台
  ├── 实时表现 → 成交人数监控
  └── 直播互动 → 评论采集 + 订单查看
```
