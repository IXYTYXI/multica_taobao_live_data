/**
 * feishu.js 单元测试
 * 测试飞书 API 相关逻辑（使用 mock）
 */

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

// ─── toTimestampMs 逻辑测试（与 feishu.js 中的实现相同） ─────────
// feishu.js 中的 toTimestampMs 未导出，这里复现其逻辑进行独立测试

function toTimestampMs(dateStr) {
  if (!dateStr) return null;
  try {
    const d = dayjs.tz(dateStr, 'YYYY-MM-DD HH:mm:ss', 'Asia/Shanghai');
    return d.isValid() ? d.valueOf() : null;
  } catch {
    return null;
  }
}

describe('toTimestampMs 时间戳转换', () => {
  test('正常北京时间字符串转毫秒时间戳', () => {
    const ts = toTimestampMs('2026-07-10 15:30:00');
    expect(ts).toBeGreaterThan(0);
    // 还原验证
    const restored = dayjs(ts).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
    expect(restored).toBe('2026-07-10 15:30:00');
  });

  test('空字符串返回 null', () => {
    expect(toTimestampMs('')).toBeNull();
  });

  test('null 输入返回 null', () => {
    expect(toTimestampMs(null)).toBeNull();
  });

  test('undefined 输入返回 null', () => {
    expect(toTimestampMs(undefined)).toBeNull();
  });

  test('无效日期字符串返回 null', () => {
    expect(toTimestampMs('not-a-date')).toBeNull();
  });

  test('午夜时间正确处理', () => {
    const ts = toTimestampMs('2026-07-10 00:00:00');
    expect(ts).not.toBeNull();
    const restored = dayjs(ts).tz('Asia/Shanghai').format('HH:mm:ss');
    expect(restored).toBe('00:00:00');
  });

  test('23:59:59 边界时间正确处理', () => {
    const ts = toTimestampMs('2026-07-10 23:59:59');
    expect(ts).not.toBeNull();
    const restored = dayjs(ts).tz('Asia/Shanghai').format('HH:mm:ss');
    expect(restored).toBe('23:59:59');
  });
});

// ─── 飞书 API 模块测试（使用 mock） ────────────────────────────────

// Mock axios
jest.mock('axios', () => ({
  post: jest.fn(),
}));

// Mock config
jest.mock('../src/config', () => ({
  feishu: {
    appId: 'mock_app_id',
    appSecret: 'mock_app_secret',
    baseAppToken: 'mock_base_token',
    tableId: 'mock_table_id',
  },
}));

const axios = require('axios');

describe('feishu.js API 调用', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 清除模块缓存和 token 缓存
    jest.resetModules();

    // 重新设置 mock
    jest.mock('axios', () => ({
      post: jest.fn(),
    }));
    jest.mock('../src/config', () => ({
      feishu: {
        appId: 'mock_app_id',
        appSecret: 'mock_app_secret',
        baseAppToken: 'mock_base_token',
        tableId: 'mock_table_id',
      },
    }));
  });

  test('writeRecord 正确构造飞书 API 请求', async () => {
    const axios = require('axios');
    // Mock token 获取
    axios.post.mockResolvedValueOnce({
      data: { code: 0, tenant_access_token: 'mock_token', expire: 7200 },
    });
    // Mock 写入
    axios.post.mockResolvedValueOnce({
      data: { code: 0, data: { record: { record_id: 'rec_123' } } },
    });

    const { writeRecord } = require('../src/feishu');

    await writeRecord({
      commenterID: 'user_001',
      commentTime: '2026-07-10 14:30:00',
      commentContent: '好看的',
      orderNumber: 'ORD123456789',
      paymentTime: '2026-07-10 14:25:00',
    });

    // 第二次调用是写入记录
    const writeCall = axios.post.mock.calls[1];
    expect(writeCall[0]).toContain('/bitable/v1/apps/mock_base_token/tables/mock_table_id/records');
    const body = writeCall[1];
    expect(body.fields['用户ID']).toBe('user_001');
    expect(body.fields['用户评论']).toBe('好看的');
    expect(body.fields['评论时间']).toBe('2026-07-10 14:30:00');
    expect(body.fields['订单编号']).toBe('ORD123456789');
    expect(body.fields['支付时间']).toBeGreaterThan(0); // 毫秒时间戳
  });

  test('writeRecord 无支付时间时不包含支付时间字段', async () => {
    const axios = require('axios');
    axios.post.mockResolvedValueOnce({
      data: { code: 0, tenant_access_token: 'mock_token', expire: 7200 },
    });
    axios.post.mockResolvedValueOnce({
      data: { code: 0, data: { record: { record_id: 'rec_124' } } },
    });

    const { writeRecord } = require('../src/feishu');

    await writeRecord({
      commenterID: 'user_002',
      commentTime: '2026-07-10 14:30:00',
      commentContent: '测试评论',
      orderNumber: '',
      paymentTime: '',
    });

    const writeCall = axios.post.mock.calls[1];
    const body = writeCall[1];
    expect(body.fields['支付时间']).toBeUndefined();
  });

  test('writeRecord token 获取失败抛出错误', async () => {
    const axios = require('axios');
    axios.post.mockResolvedValueOnce({
      data: { code: 99999, msg: 'invalid app_id' },
    });

    const { writeRecord } = require('../src/feishu');

    await expect(writeRecord({
      commenterID: 'user_003',
      commentContent: 'test',
    })).rejects.toThrow('获取飞书 token 失败');
  });

  test('writeRecord 写入失败抛出错误', async () => {
    const axios = require('axios');
    axios.post.mockResolvedValueOnce({
      data: { code: 0, tenant_access_token: 'mock_token', expire: 7200 },
    });
    axios.post.mockResolvedValueOnce({
      data: { code: 1254043, msg: 'FieldNameNotFound' },
    });

    const { writeRecord } = require('../src/feishu');

    await expect(writeRecord({
      commenterID: 'user_004',
      commentContent: 'test',
    })).rejects.toThrow('写入飞书失败');
  });

  test('writeBatchRecords 空数组直接返回', async () => {
    const axios = require('axios');
    const { writeBatchRecords } = require('../src/feishu');

    await writeBatchRecords([]);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('writeBatchRecords null 输入直接返回', async () => {
    const axios = require('axios');
    const { writeBatchRecords } = require('../src/feishu');

    await writeBatchRecords(null);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('writeBatchRecords 正确构造批量请求', async () => {
    const axios = require('axios');
    axios.post.mockResolvedValueOnce({
      data: { code: 0, tenant_access_token: 'mock_token', expire: 7200 },
    });
    axios.post.mockResolvedValueOnce({
      data: { code: 0, data: { records: [{ record_id: 'r1' }, { record_id: 'r2' }] } },
    });

    const { writeBatchRecords } = require('../src/feishu');

    await writeBatchRecords([
      { commenterID: 'u1', commentContent: 'c1', commentTime: 't1', orderNumber: '', paymentTime: '' },
      { commenterID: 'u2', commentContent: 'c2', commentTime: 't2', orderNumber: 'ORD001', paymentTime: '2026-07-10 12:00:00' },
    ]);

    const writeCall = axios.post.mock.calls[1];
    expect(writeCall[0]).toContain('batch_create');
    const body = writeCall[1];
    expect(body.records).toHaveLength(2);
    expect(body.records[0].fields['用户ID']).toBe('u1');
    expect(body.records[1].fields['订单编号']).toBe('ORD001');
  });
});
