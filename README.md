# 淘宝直播数据采集工具

使用 Playwright（Node.js）自动化操作淘宝直播中控台，采集评论和订单数据并写入飞书多维表格。

## 功能

1. **自动进入直播间** — 打开直播计划列表，找到"直播中"的场次，点击进入中控台
2. **监控成交人数** — 持续监控中控台"实时表现"区域的成交人数变化
3. **采集近期评论** — 成交人数变化时，检查最近 5 分钟的评论
4. **查看订单详情** — 点击评论区"查看订单"图标，提取订单编号和支付时间
5. **写入飞书** — 将数据写入飞书多维表格

## 前置条件

1. **Node.js** ≥ 18.0.0
2. 本机已安装 **Chrome 浏览器**
3. 飞书应用已授权访问目标多维表格

## 安装

```bash
npm install
```

## 浏览器模式

通过 `.env` 中的 `BROWSER_MODE` 选择（默认 `login`）：

### 方式一：`login` — 打开浏览器手动登录（默认）

工具会打开一个浏览器窗口，跳转到淘宝登录页。你在浏览器中完成登录后，工具自动检测到登录成功并继续运行。登录态会保存在本地 `chrome-data/` 目录，下次启动自动恢复。

```bash
# .env
BROWSER_MODE=login
```

### 方式二：`profile` — 继承本机 Chrome 登录态

直接复制你 Chrome 的 cookie 到工具自己的目录，无需重新登录，也不需要关闭正在使用的 Chrome。

```bash
# .env
BROWSER_MODE=profile
# Chrome 用户数据目录（留空则自动检测）
CHROME_USER_DATA_DIR=
```

Windows 默认路径: `C:\Users\<用户名>\AppData\Local\Google\Chrome\User Data`
macOS 默认路径: `~/Library/Application Support/Google/Chrome`

### 方式三：`cdp` — 连接已开启调试端口的 Chrome

需要先以调试端口启动 Chrome（适合已经熟悉这种方式的用户）：

```bash
# Windows
chrome.exe --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

```bash
# .env
BROWSER_MODE=cdp
CHROME_DEBUG_PORT=9222
```

## 配置

复制 `.env.example` 为 `.env` 并填入实际值：

```bash
cp .env.example .env
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书应用 App ID | — |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret | — |
| `FEISHU_BASE_APP_TOKEN` | 多维表格 App Token | `D6JAbvNKZaUgMGsTfkPcgXn2nBd` |
| `FEISHU_TABLE_ID` | 数据表 ID | `tbluFzEQv1KRMsiG` |
| `BROWSER_MODE` | 浏览器模式 | `login` |
| `CHROME_USER_DATA_DIR` | Chrome 用户数据目录 | 自动检测 |
| `CHROME_DEBUG_PORT` | Chrome 调试端口（cdp 模式） | `9222` |
| `MONITOR_INTERVAL` | 监控间隔（秒） | `10` |
| `COMMENT_CHECK_MINUTES` | 评论检查范围（分钟） | `5` |

## 运行

```bash
npm start
```

## 飞书多维表格字段

目标表格包含以下字段：

| 字段名 | 类型 | 说明 |
|--------|------|------|
| 用户ID | 文本 | 评论者的淘宝用户ID |
| 评论时间 | 文本 | 评论时间（北京时间，格式 YYYY-MM-DD HH:mm:ss） |
| 用户评论 | 文本 | 评论文字内容 |
| 订单编号 | 文本 | 淘宝订单号 |
| 支付时间 | 日期 | 支付时间（毫秒时间戳） |

## 时区说明

本工具运行在美国东部时间的机器上，但所有时间判断和记录均基于北京时间（东八区 UTC+8）。使用 `dayjs` + timezone 插件处理时区转换。

## 项目结构

```
src/
├── index.js      # 主入口 — 监控循环和编排
├── config.js     # 配置管理（从 .env 加载）
├── browser.js    # 浏览器自动化（三种模式 + 页面操作）
└── feishu.js     # 飞书 API（多维表格写入）
```
