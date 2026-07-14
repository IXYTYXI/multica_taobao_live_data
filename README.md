# 淘宝直播数据采集工具

使用 Playwright（Node.js）自动化操作淘宝直播中控台，采集评论与订单数据，并写入飞书多维表格。

适用于**单场或全天直播**场景：工具会持续运行，每隔固定间隔扫描评论区，对新评论逐条尝试「查看订单」，将结果同步到飞书。

**目录**

- [功能概览](#功能概览)
- [环境要求](#环境要求)
- [Windows 部署说明](#windows-部署说明)
- [快速部署](#快速部署)
- [浏览器模式](#浏览器模式)
- [配置说明](#配置说明)
- [定时启停](#定时启停0800-启动--0006-停止)
- [长期运行（7×24）](#长期运行724)
- [本地数据文件](#本地数据文件)
- [故障排查](#故障排查)
- [项目结构](#项目结构)
- [npm 脚本](#npm-脚本)
- [开发与测试](#开发与测试)

---

## 功能概览

| 能力 | 说明 |
|------|------|
| 自动进入中控台 | 打开直播列表，找到「直播中」场次并进入控制台 |
| 评论采集 | 在「全部」标签扫描评论，不来回切换「已下单」等筛选 |
| 查看订单 | 悬停评论行 → 点击「查看订单」→ 读取弹窗中的订单编号与支付时间 |
| 订单去重 | 同一订单号只保留一条带订单的记录（用户下单后后续评论可能重复带出同一订单） |
| 飞书写入 | 批量写入多维表格；已有评论可补写订单号；失败记录进入 outbox 自动重试 |
| 本地去重 | `dedup.json` / `order-dedup.json` 持久化，重启不重复写入 |
| 启动 / 定时兜底 | 启动时全量回溯评论；每 N 小时滚动兜底，防止虚拟列表漏采 |
| 浏览器自愈 | 页面意外关闭时自动重开并回到中控台；定时刷新防止评论区卡死 |
| 跨平台定时启停 | 自动识别 macOS / Windows，从 `.env` 配置每日启停时间 |

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

**方式 A：pm2 + 定时启停（推荐，见下方「定时启停」专节）**

```powershell
npm install -g pm2
cd C:\path\to\taobao_live_data
pm2 start npm --name taobao-live -- start
pm2 save
```

**不要**执行 `pm2 startup` 做 24 小时开机自启；若只需每天固定时段采集，在项目根目录配置 `.env` 后执行：

```powershell
npm run schedule:install
```

详见下方「定时启停」专节。

**方式 B：仅 pm2 7×24 守护**

```powershell
pm2 startup
```

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

### 7. 可选：配置每日定时启停

若直播固定在每天某时段（如 08:00–00:06），无需 7×24 运行，可在 `.env` 中设置 `SCHEDULE_*` 变量后执行：

```bash
npm install -g pm2
pm2 start npm --name taobao-live -- start
pm2 save

npm run schedule:install
npm run schedule:status
```

详见 [定时启停](#定时启停0800-启动--0006-停止) 专节。

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

### 飞书与浏览器

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书应用 App ID | — |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret | — |
| `FEISHU_BASE_APP_TOKEN` | 多维表格 App Token | — |
| `FEISHU_TABLE_ID` | 数据表 ID（`tbl` 开头） | — |
| `BROWSER_MODE` | `login` / `profile` / `cdp` | `login` |
| `CHROME_USER_DATA_DIR` | profile 模式 Chrome 目录 | 自动检测 |
| `CHROME_DEBUG_PORT` | cdp 模式调试端口 | `9222` |
| `LOCAL_BROWSER_DATA_DIR` | login 模式浏览器数据目录 | 项目下 `chrome-data/` |

### 采集与监控

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MONITOR_INTERVAL` | 监控间隔（秒） | `10` |
| `COMMENT_CHECK_MINUTES` | 每轮扫描的时间窗口（分钟） | `5` |
| `SCROLL_ON_SYNC` | 首次同步是否滚动评论列表 | `false` |
| `STARTUP_BACKFILL` | 启动时全量回溯历史评论并查订单 | `true` |
| `PERIODIC_BACKFILL_HOURS` | 定时滚动兜底间隔（小时）；`0` 关闭 | `3` |
| `AUTO_RECOVER_BROWSER` | 浏览器意外关闭后自动恢复 | `true` |
| `PAGE_REFRESH_MINUTES` | 定时刷新中控台（分钟）；`0` 关闭 | `30` |
| `STALE_SCAN_THRESHOLD` | 连续 N 轮扫描异常后触发刷新 | `3` |

### 定时启停

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SCHEDULE_ENABLED` | 是否允许 `schedule:install` 写入系统任务 | `true` |
| `SCHEDULE_START_TIME` | 每天启动时间（`HH:mm`） | `08:00` |
| `SCHEDULE_STOP_TIME` | 每天停止时间（`HH:mm`） | `00:06` |
| `SCHEDULE_PM2_NAME` | pm2 进程名（与 `pm2 start --name` 一致） | `taobao-live` |

完整模板见 `.env.example`。

### 采集逻辑说明

- **首次进入中控台**：同步当前可见的全部评论（不受 `COMMENT_CHECK_MINUTES` 限制）
- **启动兜底**（`STARTUP_BACKFILL=true`）：若直播已在进行，滚动「直播互动」评论列表全量回溯，逐条查订单；飞书已有记录则补写订单号
- **后续每轮**：只处理「最近 N 分钟」内的新评论（N = `COMMENT_CHECK_MINUTES`）
- **每条新评论**：悬停 → 点「查看订单」→ 有订单则写入，无则只写评论
- **同一 `orderId`**：全表只保留一条带订单的记录
- **定时兜底**（`PERIODIC_BACKFILL_HOURS`）：每隔若干小时再次滚动全量，衔接虚拟列表防止漏采
- **页面维护**：定时刷新 + 连续扫描异常时刷新；浏览器关闭时自动重开并跑恢复兜底

---

## 定时启停（08:00 启动 / 00:06 停止）

适用于**每天固定时段直播**（例如 8:00 开播、次日凌晨停采集），无需 7×24 运行。

| 时间 | 动作 |
|------|------|
| 每天 **08:00** | 启动采集 |
| 每天 **00:06** | 停止采集（优雅退出，保存 dedup/outbox） |

运行时段示意：`08:00 ──► 采集中 ──► 次日 00:06 ──► 休眠至 08:00`

### 推荐：自动识别平台 + `.env` 配置（一条命令安装）

脚本 `scripts/setup-schedule.js` 会**自动识别 macOS / Windows**，从 `.env` 读取启停时间，并写入 **cron**（Mac）或 **任务计划程序**（Windows）。

1. 在 `.env` 中配置（可复制 `.env.example` 中对应段落）：

```env
SCHEDULE_ENABLED=true
SCHEDULE_START_TIME=08:00
SCHEDULE_STOP_TIME=00:06
SCHEDULE_PM2_NAME=taobao-live
```

2. 完成下方「前置：pm2 一次性配置」后，在项目根目录执行：

```bash
npm run schedule:install    # 安装/更新系统定时任务
npm run schedule:status     # 查看当前配置与任务状态
npm run schedule:uninstall  # 卸载定时任务
```

| 命令 | 作用 |
|------|------|
| `schedule:install` | macOS 写入 crontab 标记块；Windows 创建 `TaobaoLive-Start` / `TaobaoLive-Stop` |
| `schedule:status` | 打印平台、时间、PM2 名称及任务是否已安装 |
| `schedule:uninstall` | 移除上述定时任务 |

修改 `.env` 中的时间后，重新执行 `npm run schedule:install` 即可生效。启停脚本会从 `.env` 读取 `SCHEDULE_PM2_NAME`（默认 `taobao-live`）。

> 日志默认写入系统临时目录下的 `taobao-live-schedule.log`（macOS 一般为 `/tmp/taobao-live-schedule.log`）。

### 前置：pm2 一次性配置

```bash
npm install -g pm2
cd /path/to/taobao_live_data   # 或 multica_taobao_live_data
pm2 start npm --name taobao-live -- start
pm2 save
```

> **不要**执行 `pm2 startup`（那是开机 24 小时自启）。启停交给下方系统定时任务。

### macOS（cron，手动配置）

> 若已使用 `npm run schedule:install`，可跳过本节。

1. 赋予脚本执行权限（首次）：

```bash
chmod +x scripts/macos/schedule-start.sh scripts/macos/schedule-stop.sh
```

2. 编辑 crontab：

```bash
crontab -e
```

3. 加入（**将 `/path/to/multica_taobao_live_data` 改为你本机项目绝对路径**）：

```cron
# 每天 08:00 启动
0 8 * * * /path/to/multica_taobao_live_data/scripts/macos/schedule-start.sh >> /tmp/taobao-live-schedule.log 2>&1

# 每天 00:06 停止
6 0 * * * /path/to/multica_taobao_live_data/scripts/macos/schedule-stop.sh >> /tmp/taobao-live-schedule.log 2>&1
```

4. 确认 `pm2` 路径可用（`which pm2`）；cron 环境变量较少，脚本已自动补充 `/usr/local/bin` 与 `/opt/homebrew/bin`。

5. 若任务不执行：系统设置 → 隐私与安全性 → 为「终端」或 `cron` 授予完全磁盘访问权限。

**脚本位置：**

| 脚本 | 作用 |
|------|------|
| `scripts/macos/schedule-start.sh` | 从 `.env` 读 PM2 名，`pm2 restart/start` |
| `scripts/macos/schedule-stop.sh` | `pm2 stop` + 关闭 `chrome-data` Chrome |

### Windows（任务计划程序，手动配置）

> 若已使用 `npm run schedule:install`，可跳过本节。

1. 打开 **任务计划程序** → 创建任务（非「基本任务」以便填起始于）。

2. **启动任务**（每天 08:00）：

| 项 | 值 |
|----|-----|
| 名称 | `TaobaoLive-Start` |
| 触发器 | 每天 08:00 |
| 操作 | 启动程序 |
| 程序 | `C:\path\to\taobao_live_data\scripts\windows\schedule-start.bat` |
| 起始于 | `C:\path\to\taobao_live_data` |
| 条件 | 取消「只有在计算机使用交流电源时才启动」 |
| 设置 | 勾选「如果过了计划开始时间，立即启动任务」 |

3. **停止任务**（每天 00:06）：

| 项 | 值 |
|----|-----|
| 名称 | `TaobaoLive-Stop` |
| 触发器 | 每天 00:06 |
| 操作 | 启动程序 |
| 程序 | `C:\path\to\taobao_live_data\scripts\windows\schedule-stop.bat` |
| 起始于 | `C:\path\to\taobao_live_data` |

4. 勾选「不管用户是否登录都要运行」；运行账户需已安装 Node.js 与 pm2。

**脚本位置：**

| 脚本 | 作用 |
|------|------|
| `scripts\windows\schedule-start.bat` | 从 `.env` 读 PM2 名，`pm2 restart/start` |
| `scripts\windows\schedule-stop.bat` | `pm2 stop` + 关闭 `chrome-data` Chrome |

### 手动测试

```bash
# macOS
./scripts/macos/schedule-start.sh
./scripts/macos/schedule-stop.sh
```

```powershell
# Windows
scripts\windows\schedule-start.bat
scripts\windows\schedule-stop.bat
```

---

## 长期运行（7×24）

> 若只需每天固定时段采集，优先使用上方 [定时启停](#定时启停0800-启动--0006-停止)（`npm run schedule:install`），无需 `pm2 startup` 开机自启。

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
| 定时任务未执行 | cron / 任务计划未安装或权限不足 | 执行 `npm run schedule:status` 检查；macOS 给终端/cron 完全磁盘访问 |
| 定时启动后 pm2 找不到 | cron 环境 PATH 不含 npm 全局 bin | 脚本已补充常见路径；确认 `which pm2` 可用 |

---

## 项目结构

```
multica_taobao_live_data/
├── src/
│   ├── index.js           # 主入口：监控循环、兜底、去重、outbox
│   ├── browser.js         # Playwright：登录、进中控台、采评论/订单
│   ├── feishu.js          # 飞书 API：写入、补写订单、远端对账
│   └── config.js          # 环境变量加载
├── scripts/
│   ├── setup-schedule.js  # 跨平台定时任务安装器（macOS cron / Windows 任务计划）
│   ├── macos/
│   │   ├── schedule-start.sh
│   │   └── schedule-stop.sh
│   └── windows/
│       ├── schedule-start.bat
│       └── schedule-stop.bat
├── __tests__/             # 单元测试
├── data/                  # 运行时数据（不提交 Git）
├── chrome-data/           # login 模式浏览器数据（不提交 Git）
├── .env.example           # 环境变量模板
└── package.json
```

---

## npm 脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 启动采集主进程 |
| `npm test` | 运行单元测试 |
| `npm run schedule:install` | 从 `.env` 读取时间，安装系统定时启停任务 |
| `npm run schedule:status` | 查看平台、配置与任务安装状态 |
| `npm run schedule:uninstall` | 卸载系统定时启停任务 |

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
