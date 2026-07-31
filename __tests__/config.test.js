/**
 * config.js 单元测试
 * 测试配置加载和默认值
 */

describe('config.js', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // 清除模块缓存以重新加载
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('使用默认飞书配置', () => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_BASE_APP_TOKEN;
    delete process.env.FEISHU_TABLE_ID;

    const config = require('../src/config');
    expect(config.feishu.appId).toBe('');
    expect(config.feishu.appSecret).toBe('');
    expect(config.feishu.baseAppToken).toBe('D6JAbvNKZaUgMGsTfkPcgXn2nBd');
    expect(config.feishu.tableId).toBe('tbluFzEQv1KRMsiG');
  });

  test('环境变量覆盖飞书配置', () => {
    process.env.FEISHU_APP_ID = 'test_app_id';
    process.env.FEISHU_APP_SECRET = 'test_secret';
    process.env.FEISHU_BASE_APP_TOKEN = 'custom_token';
    process.env.FEISHU_TABLE_ID = 'custom_table';

    const config = require('../src/config');
    expect(config.feishu.appId).toBe('test_app_id');
    expect(config.feishu.appSecret).toBe('test_secret');
    expect(config.feishu.baseAppToken).toBe('custom_token');
    expect(config.feishu.tableId).toBe('custom_table');
  });

  test('浏览器模式默认为 login', () => {
    delete process.env.BROWSER_MODE;
    const config = require('../src/config');
    expect(config.browser.mode).toBe('login');
  });

  test('浏览器模式大小写不敏感', () => {
    process.env.BROWSER_MODE = 'CDP';
    const config = require('../src/config');
    expect(config.browser.mode).toBe('cdp');
  });

  test('监控间隔默认值', () => {
    delete process.env.MONITOR_INTERVAL;
    delete process.env.COMMENT_CHECK_MINUTES;
    const config = require('../src/config');
    expect(config.monitor.intervalSeconds).toBe(10);
    expect(config.monitor.commentCheckMinutes).toBe(5);
  });

  test('监控间隔自定义值', () => {
    process.env.MONITOR_INTERVAL = '30';
    process.env.COMMENT_CHECK_MINUTES = '10';
    const config = require('../src/config');
    expect(config.monitor.intervalSeconds).toBe(30);
    expect(config.monitor.commentCheckMinutes).toBe(10);
  });

  test('CDP 调试端口默认 9222', () => {
    delete process.env.CHROME_DEBUG_PORT;
    const config = require('../src/config');
    expect(config.browser.debugPort).toBe(9222);
  });

  test('未配置账号密码时不自动填表', () => {
    delete process.env.TAOBAO_LOGIN_USER;
    delete process.env.TAOBAO_LOGIN_PASSWORD;
    delete process.env.AUTO_FILL_LOGIN;
    const config = require('../src/config');
    expect(config.browser.autoFillLogin).toBe(false);
  });

  test('配置账号密码后默认自动填表', () => {
    process.env.TAOBAO_LOGIN_USER = 'test_user';
    process.env.TAOBAO_LOGIN_PASSWORD = 'test_pass';
    delete process.env.AUTO_FILL_LOGIN;
    const config = require('../src/config');
    expect(config.browser.autoFillLogin).toBe(true);
    expect(config.browser.loginUser).toBe('test_user');
  });

  test('AUTO_FILL_LOGIN=false 时禁用自动填表', () => {
    process.env.TAOBAO_LOGIN_USER = 'test_user';
    process.env.TAOBAO_LOGIN_PASSWORD = 'test_pass';
    process.env.AUTO_FILL_LOGIN = 'false';
    const config = require('../src/config');
    expect(config.browser.autoFillLogin).toBe(false);
  });

  test('淘宝直播列表 URL 正确', () => {
    const config = require('../src/config');
    expect(config.taobao.liveListUrl).toBe('https://liveplatform.taobao.com/restful/index/live/list');
  });

  test('监控间隔为非数字字符串时应解析为 NaN', () => {
    process.env.MONITOR_INTERVAL = 'abc';
    const config = require('../src/config');
    expect(config.monitor.intervalSeconds).toBeNaN();
  });
});
