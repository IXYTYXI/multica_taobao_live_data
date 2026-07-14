# 淘宝直播数据采集工具

使用 Playwright（Node.js）自动化操作淘宝直播中控台，采集评论与订单数据，并写入飞书多维表格。

适用于**单场或全天直播**场景：工具会持续运行，每隔固定间隔扫描评论区，对新评论逐条尝试「查看订单」，将结果同步到飞书。

---

## 功能概览

| 能力 | 说明 |
|------|------|
| 自动进入中控台 | 打开直播列表，找到「直播中」场次并进入控制台 |
| 评论采集 | 在「全部」标签扫描评论，不来回切换「已下单」等筛选 |
| 查看订单 | 悬停评论行 → 点击「查看订单」→ 读取弹窗中的订单编号与支付时间 |
| 订单去重 | 同一订单号只保留一条带订单的记录（用户下单后后续评论可能重复带出同一订单） |
| 飞书写入 | 批量写入多维表格，失败记录进入 outbox 自动重试 |
| 本地去重 | `dedup.json` / `order-dedup.json` 持久化，重启不重复写入 |

---

## 环境要求

| 项目 | 要求 |
|------|------|
| Node.js | ≥ 18.0.0 |
| 浏览器 | 本机已安装 **Google Chrome** |
| 操作系统 | **Windows 10/11** 或 macOS（Windows 见下方专节） |
| 网络 | 可访问淘宝直播中控台与飞书 Open API |
| 飞书 | 已创建企业自建应用，并授权访问目标多维表格 |

---

## Windows 部署说明

代码已适配 Windows（`win32`），流程与 macOS 相同，仅命令与路径不同。

### 1. 安装 Node.js 与 Git

1. 安装 [Node.js](https://nodejs.org/) LTS（≥ 18）
2. 安装 [Git for Windows](https://git-scm.com/download/win)（自带 Git Bash，推荐在此终端操作）

验证：

```powershell
node -v
npm -v
```

### 2. 克隆与安装

**PowerShell / CMD：**

```powershell
git clone https://gitlab.yc345.tv/fengyang1/taobao_live_data.git
cd taobao_live_data
npm install
copy .env.example .env
notepad .env
```

**Git Bash：**

```bash
git clone https://gitlab.yc345.tv/fengyang1/taobao_live_data.git
cd taobao_live_data
npm install
cp .env.example .env
```

### 3. 推荐浏览器模式

| 模式 | Windows 建议 |
|------|----------------|
| **`login`（推荐）** | 工具自带 Chrome 窗口，登录态存项目下 `chrome-data\`，与日常 Chrome 互不干扰 |
| `profile` | 复制本机 Chrome Cookie；若 Chrome 正在运行，部分文件可能被锁定（代码会尝试 `robocopy` 兜底） |
| `cdp` | 需单独用调试端口启动 Chrome，步骤见下文 |

`.env` 示例：

```ini
BROWSER_MODE=login
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
FEISHU_BASE_APP_TOKEN=your_base_app_token
FEISHU_TABLE_ID=your_table_id
MONITOR_INTERVAL=10
COMMENT_CHECK_MINUTES=5
```

### 4. 启动

```powershell
npm start
```

首次会弹出 Chrome，在窗口内登录淘宝直播中控台即可。

### 5. Windows 下 Chrome 路径

| 用途 | 路径 |
|------|------|
| 已安装 Chrome（常见） | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| profile 模式用户数据 | `C:\Users\<用户名>\AppData\Local\Google\Chrome\User Data` |
| login 模式登录态 | 项目目录 `chrome-data\` |

### 6. CDP 模式（可选）

先**完全退出**任务栏/托盘里的 Chrome，再在 **CMD** 中执行：

```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%USERPROFILE%\chrome-debug-profile"
```

`.env`：

```ini
BROWSER_MODE=cdp
CHROME_DEBUG_PORT=9222
```

### 7. 长期运行（Windows）

**方式 A：pm2（推荐）**

```powershell
npm install -g pm2
cd C:\path\to\taobao_live_data
pm2 start npm --name taobao-live -- start
pm2 save
pm2 startup
```

**方式 B：计划任务**

新建「登录时运行」任务，程序填 `node`，参数填项目内 `src\index.js` 的完整路径，起始于填项目目录。

### 8. Windows 常见问题

| 现象 | 处理 |
|------|------|
| `chrome-data` 被占用 | 任务管理器结束旧 `node.exe` / Chrome 后重试 |
| 防火墙拦截 | 允许 Node.js、Chrome 访问网络 |
| 电脑休眠 | 电源选项 → 关闭休眠/睡眠，或「从不」休眠 |
| 路径含中文 | 项目尽量放在纯英文路径（如 `D:\tools\taobao_live_data`） |

---

## 快速部署

### 1. 获取代码

```bash
git clone https://github.com/IXYTYXI/multica_taobao_live_data.git
cd multica_taobao_live_data
```

或使用 GitLab 镜像：

```bash
git clone https://gitlab.yc345.tv/fengyang1/taobao_live_data.git
cd taobao_live_data
```

### 2. 安装依赖

```bash
npm install
```

首次运行会自动下载 Playwright 所需的 Chrome 驱动（若尚未安装）。

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入飞书凭证与表格信息：

```bash
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
FEISHU_BASE_APP_TOKEN=your_base_app_token
FEISHU_TABLE_ID=your_table_id

BROWSER_MODE=login
MONITOR_INTERVAL=10
COMMENT_CHECK_MINUTES=5
```

> **注意**：`.env` 含敏感信息，勿提交到 Git。`.env.example` 仅保留占位符。

### 4. 准备飞书多维表格

目标数据表需包含以下字段（列名须一致）：

| 字段名 | 类型 | 写入内容 |
|--------|------|----------|
| 用户ID | 文本 | 评论者昵称/显示名（如 `bettybettybetty666`） |
| 用户实际id | 文本 | 淘宝账号 ID（如 `bettyyhj`） |
| 评论时间 | 文本 | 北京时间，格式 `YYYY-MM-DD HH:mm:ss` |
| 用户评论 | 文本 | 评论正文 |
| 订单编号 | 文本 | 订单号（无订单时为空） |
| 支付时间 | 日期 | 支付时间（无订单时不写） |

其他列（学段、购买 SKU 等）可由人工或公式维护，工具不会写入。

#### 飞书应用权限

应用需开通至少以下权限（租户身份）：

- 获取 `tenant_access_token`
- 多维表格：读写记录（`bitable:app` 或等效权限）

若需通过 API 自动建列，还需 `base:field:create`；一般建议在表格中**手动添加**「用户实际id」列。

#### 授权表格

在飞书开放平台 → 应用 → 权限管理 → 多维表格，将目标 Base 授权给该应用。

### 5. 首次启动

```bash
npm start
```

**`login` 模式（推荐）** 首次运行会弹出 Chrome 窗口：

1. 在浏览器中完成淘宝/直播中控台登录
2. 登录成功后工具自动进入直播列表
3. 若有「直播中」场次，自动进入中控台并开始监控

登录态保存在项目目录 `chrome-data/`，下次启动通常无需重新登录。

### 6. 直播期间注意事项

- **保持 Playwright 打开的 Chrome 窗口不要关闭**
- 中控台停留在 **直播互动 → 全部** 标签（工具会自动确保，但不要手动切走）
- 工具会在评论行上悬停并点击「查看订单」，属于正常行为
- 直播进行中建议保持 `SCROLL_ON_SYNC` 未开启（默认 `false`），避免滚动干扰界面

---

## 浏览器模式

通过 `.env` 中 `BROWSER_MODE` 选择，**同一时间只启用一种**。

### `login`（默认，推荐）

独立 Chrome 实例，登录态保存在 `chrome-data/`。

```bash
BROWSER_MODE=login
```

适合：专用采集机、长期运行、与日常办公 Chrome 隔离。

### `profile`

复制本机 Chrome 的用户数据（Cookie），无需重新登录。

```bash
BROWSER_MODE=profile
# 留空则自动检测
CHROME_USER_DATA_DIR=
```

| 系统 | 默认路径 |
|------|----------|
| macOS | `~/Library/Application Support/Google/Chrome` |
| Windows | `C:\Users\<用户名>\AppData\Local\Google\Chrome\User Data` |

### `cdp`

连接已开启调试端口的 Chrome。

**macOS 启动 Chrome：**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-debug-profile"
```

**Windows 启动 Chrome：**

```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%USERPROFILE%\chrome-debug-profile"
```

```bash
BROWSER_MODE=cdp
CHROME_DEBUG_PORT=9222
```

> 需先完全退出 Chrome 再以调试端口启动，否则端口可能不监听。

---

## 配置说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书应用 App ID | — |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret | — |
| `FEISHU_BASE_APP_TOKEN` | 多维表格 App Token | — |
| `FEISHU_TABLE_ID` | 数据表 ID（`tbl` 开头） | — |
| `BROWSER_MODE` | `login` / `profile` / `cdp` | `login` |
| `CHROME_USER_DATA_DIR` | profile 模式 Chrome 目录 | 自动检测 |
| `CHROME_DEBUG_PORT` | cdp 模式调试端口 | `9222` |
| `MONITOR_INTERVAL` | 监控间隔（秒） | `10` |
| `COMMENT_CHECK_MINUTES` | 每轮扫描的时间窗口（分钟） | `5` |
| `SCROLL_ON_SYNC` | 首次同步是否滚动评论列表 | `false`（未设置即 false） |

### 采集逻辑说明

- **首次进入中控台**：同步当前可见的全部评论（不受 `COMMENT_CHECK_MINUTES` 限制）
- **后续每轮**：只处理「最近 N 分钟」内的新评论（N = `COMMENT_CHECK_MINUTES`）
- **每条新评论**：悬停 → 点「查看订单」→ 有订单则写入，无则只写评论
- **同一 `orderId`**：全表只保留一条带订单的记录

---

## 长期运行（7×24）

工具主循环为 `while (true)`，设计上支持整场直播甚至全天运行，但需满足：

| 条件 | 原因 |
|------|------|
| 机器不休眠 | 休眠期间无法采集 |
| 不关闭采集用 Chrome | 关闭后报 `page has been closed` |
| 进程守护 | Node 崩溃后需自动拉起 |

### 使用 pm2 守护（推荐）

```bash
npm install -g pm2

cd /path/to/multica_taobao_live_data
pm2 start npm --name taobao-live -- start
pm2 save
pm2 startup   # 按提示配置开机自启
```

常用命令：

```bash
pm2 logs taobao-live    # 查看日志
pm2 restart taobao-live # 重启
pm2 stop taobao-live    # 停止
```

### 优雅退出

按 `Ctrl+C` 或发送 `SIGTERM`，工具会保存 `dedup.json` / `order-dedup.json` / `outbox.json` 后退出。

---

## 本地数据文件

运行时会在 `data/` 目录生成（已加入 `.gitignore`）：

| 文件 | 用途 |
|------|------|
| `dedup.json` | 已写入飞书的评论去重键 |
| `order-dedup.json` | 已记录的订单号，防止重复写订单 |
| `outbox.json` | 飞书写入失败时的待重试队列 |
| `page-dump.html` | 启动时页面 DOM 快照（调试用） |
| `debug-scan.json` | 评论扫描诊断信息 |

如需**重新采集**某条评论，可从 `dedup.json` 中删除对应行后重启（可能导致飞书出现重复行，仅测试时使用）。

---

## 故障排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| `page has been closed` | Chrome 被手动关闭 | 重启 `npm start`，勿关浏览器 |
| `正在现有的浏览器会话中打开` | `chrome-data` 被占用 | 关闭旧 Chrome 窗口或旧 node 进程后重启 |
| 评论采到了但订单为空 | 该用户确实无订单，或评论行匹配偏差 | 看日志是否有「点击「查看订单」」；同分钟多条评论偶发点错行 |
| 飞书 `FieldNameNotFound` | 表格缺少列 | 确认存在「用户实际id」等必需字段 |
| 登录态失效 | Cookie 过期 | 删除 `chrome-data/` 后重新 `npm start` 登录 |
| 找不到直播场次 | 当前无「直播中」 | 工具每 30 秒重试，开播后自动进入 |
| CDP 连不上 | 9222 未监听 | 完全退出 Chrome 后用 `--remote-debugging-port=9222` 启动 |

---

## 项目结构

```
multica_taobao_live_data/
├── src/
│   ├── index.js      # 主入口：监控循环、去重、outbox
│   ├── browser.js    # Playwright：登录、进中控台、采评论/订单
│   ├── feishu.js     # 飞书 API：写入与远端对账
│   └── config.js     # 环境变量加载
├── __tests__/        # 单元测试
├── data/             # 运行时数据（不提交 Git）
├── chrome-data/      # login 模式浏览器数据（不提交 Git）
├── .env.example      # 环境变量模板
└── package.json
```

---

## 开发与测试

```bash
npm test
```

---

## 时区

所有评论时间、订单时间均使用**北京时间（Asia/Shanghai, UTC+8）**，与运行机器的本地时区无关。

---

## 仓库

- GitHub: https://github.com/IXYTYXI/multica_taobao_live_data
- GitLab: https://gitlab.yc345.tv/fengyang1/taobao_live_data
