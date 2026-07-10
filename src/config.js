/**
 * 配置管理模块
 * 从环境变量加载所有配置项
 */
require('dotenv').config();

const config = {
  // 飞书应用凭证
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    baseAppToken: process.env.FEISHU_BASE_APP_TOKEN || 'D6JAbvNKZaUgMGsTfkPcgXn2nBd',
    tableId: process.env.FEISHU_TABLE_ID || 'tbluFzEQv1KRMsiG',
  },

  // Chrome 调试配置
  chrome: {
    debugPort: parseInt(process.env.CHROME_DEBUG_PORT || '9222', 10),
  },

  // 淘宝直播中控台
  taobao: {
    liveListUrl: 'https://liveplatform.taobao.com/restful/index/live/list',
  },

  // 监控参数
  monitor: {
    intervalSeconds: parseInt(process.env.MONITOR_INTERVAL || '10', 10),
    commentCheckMinutes: parseInt(process.env.COMMENT_CHECK_MINUTES || '5', 10),
  },
};

module.exports = config;
