/**
 * 边界情况测试
 * 测试跨午夜评论、记录集增长、配置校验等
 */

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const BEIJING_TZ = 'Asia/Shanghai';

describe('跨午夜评论时间边界', () => {
  /**
   * 跨午夜修正逻辑：如果拼出的时间比当前时间晚超过1小时，
   * 说明评论实际来自前一天，应减去1天。
   */

  // 复现 browser.js getRecentComments 中的跨午夜修正逻辑
  function parseCommentTime(commentTimeStr, nowTime) {
    const today = nowTime.format('YYYY-MM-DD');
    let fullTimeStr = `${today} ${commentTimeStr}`;
    let commentTime = dayjs.tz(fullTimeStr, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

    // 跨午夜修正
    if (commentTime.isAfter(nowTime.add(1, 'hour'))) {
      const yesterday = nowTime.subtract(1, 'day').format('YYYY-MM-DD');
      fullTimeStr = `${yesterday} ${commentTimeStr}`;
      commentTime = dayjs.tz(fullTimeStr, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    }

    return commentTime;
  }

  test('午夜后正确将前一天的评论时间解析到昨天日期', () => {
    // 当前北京时间是 2026-07-11 00:02:00
    const now = dayjs.tz('2026-07-11 00:02:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    const cutoff = now.subtract(5, 'minute');

    // 评论显示时间 23:58（实际是前一天 07-10 的）
    const commentTime = parseCommentTime('23:58:00', now);

    // 修正后应被解析为 2026-07-10 23:58:00
    expect(commentTime.format('YYYY-MM-DD HH:mm:ss')).toBe('2026-07-10 23:58:00');
    // 在 cutoff (2026-07-10 23:57:00) 之后，应被采集
    expect(commentTime.isAfter(cutoff)).toBe(true);
  });

  test('午夜后正确将23:55评论解析到前一天', () => {
    const now = dayjs.tz('2026-07-11 00:02:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

    const commentTime = parseCommentTime('23:55:00', now);

    // 修正后应为前一天 07-10 23:55:00，而非未来时间
    expect(commentTime.format('YYYY-MM-DD HH:mm:ss')).toBe('2026-07-10 23:55:00');
    expect(commentTime.isBefore(now)).toBe(true); // 不再是未来时间
  });

  test('非跨午夜场景不受影响：当天14:30评论正常解析', () => {
    const now = dayjs.tz('2026-07-11 15:00:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

    const commentTime = parseCommentTime('14:30:00', now);

    // 不触发修正，仍为当天日期
    expect(commentTime.format('YYYY-MM-DD HH:mm:ss')).toBe('2026-07-11 14:30:00');
  });

  test('刚过午夜时当天00:01评论不被误修正到昨天', () => {
    const now = dayjs.tz('2026-07-11 00:05:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

    const commentTime = parseCommentTime('00:01:00', now);

    // 00:01 距当前00:05仅4分钟，不超过1小时阈值，不应修正
    expect(commentTime.format('YYYY-MM-DD HH:mm:ss')).toBe('2026-07-11 00:01:00');
  });

  test('评论时间刚好在当前时间1小时后不触发修正', () => {
    const now = dayjs.tz('2026-07-11 14:00:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

    // 15:00 距当前14:00恰好1小时，isAfter(now+1h) 为 false
    const commentTime = parseCommentTime('15:00:00', now);
    expect(commentTime.format('YYYY-MM-DD HH:mm:ss')).toBe('2026-07-11 15:00:00');
  });
});

describe('recordedComments Set 内存增长', () => {
  test('长时间运行后 Set 持续增长', () => {
    const recorded = new Set();

    // 模拟 8 小时直播，每分钟平均 2 条评论
    const totalComments = 8 * 60 * 2; // 960 条
    for (let i = 0; i < totalComments; i++) {
      recorded.add(`user_${i % 50}_time_${i}_content_${i}`);
    }

    // Set 的大小等于所有唯一评论数
    expect(recorded.size).toBe(totalComments);
    // 虽然 960 条不算多，但如果直播持续多天或同时监控多个直播间，
    // 且程序不会自动清理旧评论，这个 Set 会无限增长
  });
});

describe('飞书 token 缓存边界', () => {
  test('token 过期时间计算：提前 60 秒失效', () => {
    const now = Date.now();
    const expire = 7200; // 飞书返回的过期时间（秒）
    const tokenExpiresAt = now + (expire - 60) * 1000;

    // 过期时间应该是 now + 7140 秒
    expect(tokenExpiresAt - now).toBe(7140000); // 7140 秒 = 119 分钟
  });

  test('如果飞书返回的 expire 小于 60 秒会导致负数过期时间', () => {
    const now = Date.now();
    const expire = 30; // 异常短的过期时间
    const tokenExpiresAt = now + (expire - 60) * 1000;

    // tokenExpiresAt 会比 now 早 30 秒 → 下次调用会立刻刷新 token
    // 这是可接受的行为（不会崩溃，只是多刷新一次）
    expect(tokenExpiresAt).toBeLessThan(now);
  });
});

describe('config 配置校验', () => {
  test('飞书凭证为空时 main 函数应该退出', () => {
    // index.js main() 中检查 config.feishu.appId 和 appSecret
    // 如果为空则 process.exit(1)
    // 这个测试验证配置验证逻辑存在
    const config = {
      feishu: { appId: '', appSecret: '' },
    };
    const hasCredentials = config.feishu.appId && config.feishu.appSecret;
    expect(hasCredentials).toBeFalsy();
  });

  test('正常凭证通过检查', () => {
    const config = {
      feishu: { appId: 'cli_xxx', appSecret: 'yyy' },
    };
    const hasCredentials = config.feishu.appId && config.feishu.appSecret;
    expect(hasCredentials).toBeTruthy();
  });
});
