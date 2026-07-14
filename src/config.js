/**
 * 配置管理模块
 * 从环境变量加载所有配置项
 */
const path = require('path');
require('dotenv').config();

const config = {
  // 飞书应用凭证
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    baseAppToken: process.env.FEISHU_BASE_APP_TOKEN || 'D6JAbvNKZaUgMGsTfkPcgXn2nBd',
    tableId: process.env.FEISHU_TABLE_ID || 'tbluFzEQv1KRMsiG',
  },

  // 浏览器配置
  browser: {
    /**
     * 浏览器启动模式:
     *   "cdp"     — 连接已开启调试端口的 Chrome（需 --remote-debugging-port）
     *   "profile" — 复制本机 Chrome 的用户数据目录来继承登录态（推荐）
     *   "login"   — 打开全新浏览器，等待用户手动登录后继续
     */
    mode: (process.env.BROWSER_MODE || 'login').toLowerCase(),

    // CDP 模式的调试端口
    debugPort: parseInt(process.env.CHROME_DEBUG_PORT || '9222', 10),

    // profile 模式: 本机 Chrome 用户数据目录
    // Windows 默认: C:\Users\<用户名>\AppData\Local\Google\Chrome\User Data
    // macOS 默认:   ~/Library/Application Support/Google/Chrome
    chromeUserDataDir: process.env.CHROME_USER_DATA_DIR || '',

    // 本工具自己的持久化浏览器数据目录（login 模式用）
    localDataDir: process.env.LOCAL_BROWSER_DATA_DIR || path.resolve(__dirname, '..', 'chrome-data'),
  },

  // 淘宝直播中控台
  taobao: {
    liveListUrl: 'https://liveplatform.taobao.com/restful/index/live/list',
  },

  // 监控参数
  monitor: {
    intervalSeconds: parseInt(process.env.MONITOR_INTERVAL || '10', 10),
    commentCheckMinutes: parseInt(process.env.COMMENT_CHECK_MINUTES || '5', 10),
    // 首次同步是否滚动评论列表（默认 false，避免干扰直播界面）
    scrollOnSync: process.env.SCROLL_ON_SYNC === 'true',
    // 启动兜底：直播已在进行时，先滚动全量扫描历史评论并落盘（默认开启）
    startupBackfill: process.env.STARTUP_BACKFILL !== 'false',
  },
};

module.exports = config;
