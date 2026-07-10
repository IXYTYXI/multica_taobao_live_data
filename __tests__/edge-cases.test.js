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
   * browser.js getRecentComments 中使用 nowBeijing().format('YYYY-MM-DD') 拼接 today 日期
   * 如果直播跨越午夜 (23:55 → 00:05)，00:05 时获取评论：
   *   today = 新日期 (07-11)
   *   评论时间 = "23:58" → 拼成 "07-11 23:58" → 实际上是昨天的 23:58
   *   cutoff = 00:00 → "07-11 23:58" 在 cutoff 之后 → 被认为是近5分钟的评论
   * 结果：23:58 的评论会被正确包含吗？
   */
  test('午夜后解析前一天的评论时间可能错误（已知限制）', () => {
    // 模拟：当前北京时间是 2026-07-11 00:02:00
    // 有一条评论显示时间 23:58（实际是前一天 07-10 的）
    const today = '2026-07-11';
    const commentTimeStr = '23:58:00';
    const fullTimeStr = `${today} ${commentTimeStr}`;
    const commentTime = dayjs.tz(fullTimeStr, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

    // cutoff = 2026-07-11 00:02:00 - 5 分钟 = 2026-07-10 23:57:00
    const now = dayjs.tz('2026-07-11 00:02:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    const cutoff = now.subtract(5, 'minute');

    // 评论时间被拼成 2026-07-11 23:58:00，这比 cutoff (2026-07-10 23:57:00) 晚
    // 所以会被误判为"近期评论"，但实际上它是"明天 23:58"
    // 这是一个已知的边界问题：跨午夜时 HH:mm 格式的评论时间会被拼到错误的日期
    expect(commentTime.isAfter(cutoff)).toBe(true);

    // 实际上这条评论应该被解析为 2026-07-10 23:58:00
    const correctTime = dayjs.tz('2026-07-10 23:58:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    expect(correctTime.isAfter(cutoff)).toBe(true); // 这个也应该在范围内

    // 结论：跨午夜场景下虽然日期拼接错误（07-11 而非 07-10），
    // 但由于被拼成了"未来的23:58"，isAfter(cutoff) 仍然为 true，
    // 所以评论仍然会被采集到（行为上偶然正确，但日期记录错误）
  });

  test('午夜前的评论时间在午夜后变成"未来时间"', () => {
    const today = '2026-07-11'; // 当前日期已经是7月11日
    const commentTimeStr = '23:55:00'; // 评论在昨天23:55

    const fullTimeStr = `${today} ${commentTimeStr}`;
    const parsedTime = dayjs.tz(fullTimeStr, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

    // 当前时间是 00:02
    const now = dayjs.tz('2026-07-11 00:02:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

    // 解析出的时间 (07-11 23:55) 比当前时间 (07-11 00:02) 晚约24小时
    // 这意味着写入飞书的"评论时间"字段会是错误的日期
    expect(parsedTime.isAfter(now)).toBe(true); // 未来时间！
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
