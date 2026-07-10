/**
 * browser.js 纯逻辑单元测试
 * 测试评论解析正则、订单提取正则、登录页检测逻辑
 * 不需要真实浏览器
 */

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const BEIJING_TZ = 'Asia/Shanghai';

// ─── 评论解析正则测试 ─────────────────────────────────────────────────
// 来自 browser.js getRecentComments 中的正则
const COMMENT_REGEX = /([^\s(]+)(?:\(([^)]+)\))?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)/;

describe('评论解析正则', () => {
  test('解析带括号ID的评论: 昵称(ID) 14:30 内容', () => {
    const text = '小王(user_123) 14:30 这件衣服好看';
    const match = text.match(COMMENT_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('小王');
    expect(match[2]).toBe('user_123');
    expect(match[3]).toBe('14:30');
    expect(match[4]).toBe('这件衣服好看');
  });

  test('解析不带括号ID的评论: 昵称 14:30:25 内容', () => {
    const text = 'TestUser 14:30:25 很不错，买了';
    const match = text.match(COMMENT_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('TestUser');
    expect(match[2]).toBeUndefined();
    expect(match[3]).toBe('14:30:25');
    expect(match[4]).toBe('很不错，买了');
  });

  test('解析带秒的时间格式', () => {
    const text = '张三(z123) 09:05:30 下单了';
    const match = text.match(COMMENT_REGEX);
    expect(match).not.toBeNull();
    expect(match[3]).toBe('09:05:30');
  });

  test('解析单数字小时', () => {
    const text = '用户A 8:30 早上好';
    const match = text.match(COMMENT_REGEX);
    expect(match).not.toBeNull();
    expect(match[3]).toBe('8:30');
  });

  test('中文昵称解析', () => {
    const text = '快乐小鱼(kl_xy) 20:15 想买';
    const match = text.match(COMMENT_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('快乐小鱼');
    expect(match[2]).toBe('kl_xy');
  });

  test('评论内容包含空格', () => {
    const text = 'user1 12:00 这个 不错 值得 购买';
    const match = text.match(COMMENT_REGEX);
    expect(match).not.toBeNull();
    expect(match[4]).toBe('这个 不错 值得 购买');
  });

  test('空文本不匹配', () => {
    expect(''.match(COMMENT_REGEX)).toBeNull();
  });

  test('无时间格式的文本不匹配', () => {
    expect('只是一段普通文本没有时间'.match(COMMENT_REGEX)).toBeNull();
  });
});

// ─── 订单号提取正则测试 ───────────────────────────────────────────────
// 来自 browser.js extractOrderFromPopup 中的正则
const ORDER_REGEX = /订单(?:编号|号|[Ii][Dd])?\s*[：:]\s*(\d+)/;
const LONG_NUM_REGEX = /\b(\d{15,20})\b/;

describe('订单号提取正则', () => {
  test('匹配"订单号：1234567890"格式', () => {
    const match = '订单号：1234567890123456'.match(ORDER_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('1234567890123456');
  });

  test('匹配"订单:1234567890"格式（无空格）', () => {
    const match = '订单:1234567890123456'.match(ORDER_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('1234567890123456');
  });

  test('匹配"订单编号：123..."格式', () => {
    const match = '订单编号：1234567890123456'.match(ORDER_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('1234567890123456');
  });

  test('匹配"订单：123..."格式（无后缀直接冒号）', () => {
    const match = '订单：1234567890123456'.match(ORDER_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('1234567890123456');
  });

  test('匹配"订单ID：123..."格式', () => {
    const match = '订单ID：1234567890123456'.match(ORDER_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('1234567890123456');
  });

  test('匹配"订单id：123..."格式（小写）', () => {
    const match = '订单id：1234567890123456'.match(ORDER_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('1234567890123456');
  });

  test('"订单编:"不是有效格式，不应匹配', () => {
    const match = '订单编: 1234567890123456'.match(ORDER_REGEX);
    expect(match).toBeNull();
  });

  test('无订单号时回退到长数字匹配', () => {
    const text = '买家信息 123456789012345 付款成功';
    expect(text.match(ORDER_REGEX)).toBeNull();
    const longMatch = text.match(LONG_NUM_REGEX);
    expect(longMatch).not.toBeNull();
    expect(longMatch[1]).toBe('123456789012345');
  });

  test('14位数字不会被长数字正则匹配', () => {
    const text = '编号 12345678901234 其他';
    const match = text.match(LONG_NUM_REGEX);
    expect(match).toBeNull();
  });

  test('20位数字刚好匹配上限', () => {
    const text = '订单 12345678901234567890 付款';
    const match = text.match(LONG_NUM_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('12345678901234567890');
  });

  test('21位数字超出匹配上限', () => {
    const text = '编号 123456789012345678901 其他';
    const match = text.match(LONG_NUM_REGEX);
    // \b(\d{15,20})\b — 21位时 \d{15,20} 可以匹配前20位但后面 \b 会失败
    // 实际上在连续21位数字中间没有 word boundary，所以整体不匹配
    expect(match).toBeNull();
  });
});

// ─── 支付时间提取正则测试 ─────────────────────────────────────────────
const PAYMENT_TIME_REGEX = /(?:支付|付款|下单|创建)[时日]?\s*[间期]?\s*[：:]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)/;

describe('支付时间提取正则', () => {
  test('匹配"支付时间：2026-07-10 14:30:00"', () => {
    const match = '支付时间：2026-07-10 14:30:00'.match(PAYMENT_TIME_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('2026-07-10 14:30:00');
  });

  test('匹配"付款时间: 2026/07/10 14:30"（斜杠分隔 无秒）', () => {
    const match = '付款时间: 2026/07/10 14:30'.match(PAYMENT_TIME_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('2026/07/10 14:30');
  });

  test('匹配"下单时间：2026-07-10 09:05:30"', () => {
    const match = '下单时间：2026-07-10 09:05:30'.match(PAYMENT_TIME_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('2026-07-10 09:05:30');
  });

  test('匹配"创建日期：2026-07-10 08:00"', () => {
    const match = '创建日期：2026-07-10 08:00'.match(PAYMENT_TIME_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('2026-07-10 08:00');
  });

  test('不匹配无关键字的时间', () => {
    const match = '时间：2026-07-10 14:30:00'.match(PAYMENT_TIME_REGEX);
    expect(match).toBeNull();
  });
});

// ─── 买家ID提取正则测试 ───────────────────────────────────────────────
const BUYER_REGEX = /买[家者]?\s*[：:]\s*([^\s,，]+)/;

describe('买家ID提取正则', () => {
  test('匹配"买家：user123"', () => {
    const match = '买家：user123'.match(BUYER_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('user123');
  });

  test('匹配"买家: 张三"', () => {
    const match = '买家: 张三'.match(BUYER_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('张三');
  });

  test('匹配"买者：someone"', () => {
    const match = '买者：someone'.match(BUYER_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('someone');
  });

  test('买家后有逗号时只取逗号前内容', () => {
    const match = '买家：user123，已付款'.match(BUYER_REGEX);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('user123');
  });
});

// ─── 登录页检测逻辑测试 ───────────────────────────────────────────────

describe('登录页 URL 检测逻辑', () => {
  // 模拟 isStillLoginPage 中的 URL 检查部分
  function urlIsLogin(url) {
    return url.includes('login.taobao.com') || url.includes('login.tmall.com');
  }

  test('login.taobao.com 识别为登录页', () => {
    expect(urlIsLogin('https://login.taobao.com/member/login.jhtml')).toBe(true);
  });

  test('login.tmall.com 识别为登录页', () => {
    expect(urlIsLogin('https://login.tmall.com/member/login.jhtml')).toBe(true);
  });

  test('liveplatform.taobao.com 不识别为登录页', () => {
    expect(urlIsLogin('https://liveplatform.taobao.com/restful/index/live/list')).toBe(false);
  });

  test('www.taobao.com 不识别为登录页', () => {
    expect(urlIsLogin('https://www.taobao.com/')).toBe(false);
  });
});

// ─── 5分钟评论范围筛选测试 ────────────────────────────────────────────

describe('评论时间范围筛选', () => {
  function isWithinMinutes(commentTimeStr, withinMinutes) {
    const now = dayjs().tz(BEIJING_TZ);
    const cutoff = now.subtract(withinMinutes, 'minute');
    const today = now.format('YYYY-MM-DD');
    const fullTimeStr = `${today} ${commentTimeStr}`;
    const commentTime = dayjs.tz(fullTimeStr, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    return commentTime.isAfter(cutoff);
  }

  test('1分钟前的评论在5分钟范围内', () => {
    const now = dayjs().tz(BEIJING_TZ);
    const oneMinAgo = now.subtract(1, 'minute').format('HH:mm:ss');
    expect(isWithinMinutes(oneMinAgo, 5)).toBe(true);
  });

  test('10分钟前的评论不在5分钟范围内', () => {
    const now = dayjs().tz(BEIJING_TZ);
    const tenMinAgo = now.subtract(10, 'minute').format('HH:mm:ss');
    expect(isWithinMinutes(tenMinAgo, 5)).toBe(false);
  });

  test('刚好5分钟前的评论不在范围内（isAfter 不含等于）', () => {
    const now = dayjs().tz(BEIJING_TZ);
    const exactFive = now.subtract(5, 'minute').format('HH:mm:ss');
    expect(isWithinMinutes(exactFive, 5)).toBe(false);
  });

  test('4分59秒前的评论在5分钟范围内', () => {
    const now = dayjs().tz(BEIJING_TZ);
    const almostFive = now.subtract(4, 'minute').subtract(59, 'second').format('HH:mm:ss');
    expect(isWithinMinutes(almostFive, 5)).toBe(true);
  });
});

// ─── nowBeijing 时区测试 ──────────────────────────────────────────────

describe('nowBeijing 时区', () => {
  test('返回的时间在 Asia/Shanghai 时区', () => {
    // 复现 nowBeijing 逻辑
    const result = dayjs().tz(BEIJING_TZ);
    expect(result.utcOffset()).toBe(480); // UTC+8 = 480 分钟
  });

  test('nowBeijing 返回有效 dayjs 对象', () => {
    const result = dayjs().tz(BEIJING_TZ);
    expect(result.isValid()).toBe(true);
  });

  test('北京时间格式化正确', () => {
    const result = dayjs().tz(BEIJING_TZ);
    const formatted = result.format('YYYY-MM-DD HH:mm:ss');
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
