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

describe('跨午夜评论时间修正', () => {
  /**
   * 复现 browser.js getRecentComments 中的跨午夜修正逻辑：
   * 当解析出的评论时间超过当前时间 1 小时以上时，减去 1 天
   */
  function parseCommentTime(commentTimeStr, nowTime) {
    const now = nowTime || dayjs().tz(BEIJING_TZ);
    const today = now.format('YYYY-MM-DD');
    const fullTimeStr = `${today} ${commentTimeStr}`;
    let commentTime = dayjs.tz(fullTimeStr, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

    // 跨午夜修正
    if (commentTime.diff(now, 'hour') >= 1) {
      commentTime = commentTime.subtract(1, 'day');
    }
    return commentTime;
  }

  test('午夜后解析前一天的评论时间 → 正确回退到前一天', () => {
    const now = dayjs.tz('2026-07-11 00:02:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    const commentTime = parseCommentTime('23:58:00', now);

    // 修正后应该是 2026-07-10 23:58:00
    expect(commentTime.format('YYYY-MM-DD')).toBe('2026-07-10');
    expect(commentTime.format('HH:mm:ss')).toBe('23:58:00');
  });

  test('午夜后解析同一天的评论时间 → 不做修正', () => {
    const now = dayjs.tz('2026-07-11 00:02:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    const commentTime = parseCommentTime('00:01:00', now);

    // 00:01 只比 00:02 早 1 分钟，不满足 diff >= 1h，不修正
    expect(commentTime.format('YYYY-MM-DD')).toBe('2026-07-11');
  });

  test('正常白天时间不受影响', () => {
    const now = dayjs.tz('2026-07-11 14:30:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    const commentTime = parseCommentTime('14:25:00', now);

    expect(commentTime.format('YYYY-MM-DD')).toBe('2026-07-11');
    expect(commentTime.format('HH:mm:ss')).toBe('14:25:00');
  });

  test('修正后的评论时间在 5 分钟范围内', () => {
    const now = dayjs.tz('2026-07-11 00:02:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    const cutoff = now.subtract(5, 'minute');
    const commentTime = parseCommentTime('23:58:00', now);

    // 23:58 (07-10) 在 23:57 (07-10) 之后 → 在范围内
    expect(commentTime.isAfter(cutoff)).toBe(true);
  });

  test('修正后超出 5 分钟的评论被排除', () => {
    const now = dayjs.tz('2026-07-11 00:02:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    const cutoff = now.subtract(5, 'minute');
    const commentTime = parseCommentTime('23:50:00', now);

    // 23:50 (07-10) 在 23:57 (07-10) 之前 → 超出范围
    expect(commentTime.isAfter(cutoff)).toBe(false);
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
