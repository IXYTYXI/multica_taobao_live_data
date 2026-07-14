/**
 * 飞书 API 模块
 * 负责获取 tenant_access_token 并写入多维表格
 */
const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const config = require('./config');

dayjs.extend(utc);
dayjs.extend(timezone);

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

async function axiosWithRetry(requestFn) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await requestFn();
    } catch (e) {
      const isLast = attempt === MAX_RETRIES;
      const isRetryable = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' ||
        e.code === 'ECONNRESET' || !e.response || (e.response && e.response.status >= 500);
      if (isLast || !isRetryable) throw e;
      const delay = 1000 * Math.pow(2, attempt - 1);
      console.log(`[飞书] 请求失败 (${e.message})，${delay / 1000}s 后第 ${attempt + 1} 次重试...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * 将日期字符串转为毫秒时间戳（飞书日期字段格式）
 * @param {string} dateStr - 日期字符串，如 "2026-07-10 12:00:00"
 * @returns {number|null} 毫秒时间戳，或 null
 */
function toTimestampMs(dateStr) {
  if (!dateStr) return null;
  try {
    const d = dayjs.tz(dateStr, 'YYYY-MM-DD HH:mm:ss', 'Asia/Shanghai');
    return d.isValid() ? d.valueOf() : null;
  } catch {
    return null;
  }
}

/**
 * 构造飞书多维表格字段
 * 用户ID = 昵称/显示名；用户实际id = 淘宝账号 ID（如 tb0053776_2012）
 */
function buildFeishuFields(record) {
  const fields = {
    '用户ID': record.commenterName || record.commenterID || '',
    '用户实际id': record.commenterID || '',
    '用户评论': record.commentContent || '',
    '评论时间': record.commentTime || '',
    '订单编号': record.orderId || '',
  };

  const payTs = toTimestampMs(record.paymentTime);
  if (payTs) {
    fields['支付时间'] = payTs;
  }

  return fields;
}

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * 获取飞书 tenant_access_token
 */
async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await axiosWithRetry(() => axios.post(
    `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
    {
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    },
    { timeout: REQUEST_TIMEOUT_MS }
  ));

  if (res.data.code !== 0) {
    throw new Error(`获取飞书 token 失败: ${res.data.msg}`);
  }

  cachedToken = res.data.tenant_access_token;
  // 提前 60 秒过期以留余量
  tokenExpiresAt = now + (res.data.expire - 60) * 1000;
  console.log('[飞书] tenant_access_token 获取成功');
  return cachedToken;
}

/**
 * 向飞书多维表格写入一条记录
 * @param {Object} record - 要写入的记录
 * @param {string} record.commenterID - 评论者实际 ID（淘宝账号）
 * @param {string} record.commenterName - 评论者昵称/显示名
 * @param {string} record.commentTime - 评论时间
 * @param {string} record.commentContent - 评论内容
 * @param {string} record.orderId - 订单ID
 * @param {string} record.paymentTime - 下单（支付）时间
 */
async function writeRecord(record) {
  const token = await getTenantAccessToken();
  const { baseAppToken, tableId } = config.feishu;

  const fields = buildFeishuFields(record);

  const res = await axios.post(
    `${FEISHU_BASE}/bitable/v1/apps/${baseAppToken}/tables/${tableId}/records`,
    { fields },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  if (res.data.code !== 0) {
    throw new Error(`写入飞书失败: ${JSON.stringify(res.data)}`);
  }

  console.log(`[飞书] 写入成功: ${record.commenterName || record.commenterID}(${record.commenterID}) - ${record.commentContent}`);
  return res.data;
}

/**
 * 批量向飞书多维表格写入多条记录
 * @param {Array<Object>} records - 记录数组
 */
async function writeBatchRecords(records) {
  if (!records || records.length === 0) return;

  const token = await getTenantAccessToken();
  const { baseAppToken, tableId } = config.feishu;

  const batchRecords = records.map((record) => ({
    fields: buildFeishuFields(record),
  }));

  const res = await axios.post(
    `${FEISHU_BASE}/bitable/v1/apps/${baseAppToken}/tables/${tableId}/records/batch_create`,
    { records: batchRecords },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  if (res.data.code !== 0) {
    throw new Error(`批量写入飞书失败: ${JSON.stringify(res.data)}`);
  }

  console.log(`[飞书] 批量写入成功: ${records.length} 条记录`);
  return res.data;
}

/**
 * 远端对账：查询飞书中是否已存在匹配的记录。
 * 用于 outbox 重试前排除超时导致的"服务端已写入但客户端不知情"的重复。
 * @param {Array<Object>} records - 待检查的记录
 * @returns {Set<string>} 已存在于远端的 recordKey 集合
 */
async function findExistingRecordKeys(records) {
  if (!records || records.length === 0) return new Set();

  const token = await getTenantAccessToken();
  const { baseAppToken, tableId } = config.feishu;
  const existingKeys = new Set();

  for (const record of records) {
    try {
      const filter = `AND(CurrentValue.[用户实际id]="${record.commenterID}",CurrentValue.[评论时间]="${record.commentTime}")`;
      const res = await axios.get(
        `${FEISHU_BASE}/bitable/v1/apps/${baseAppToken}/tables/${tableId}/records`,
        {
          params: {
            filter,
            page_size: 20,
            field_names: JSON.stringify(['用户实际id', '评论时间', '用户评论']),
          },
          headers: { Authorization: `Bearer ${token}` },
          timeout: REQUEST_TIMEOUT_MS,
        }
      );

      if (res.data.code === 0 && res.data.data && res.data.data.items) {
        for (const item of res.data.data.items) {
          const f = item.fields;
          if (f['用户评论'] === record.commentContent) {
            existingKeys.add(`${record.commenterID}_${record.commentTime}_${record.commentContent}`);
            break;
          }
        }
      }
    } catch (e) {
      console.log(`[飞书] 远端对账查询失败 (${record.commenterID}):`, e.message);
    }
  }

  return existingKeys;
}

module.exports = { writeRecord, writeBatchRecords, findExistingRecordKeys, buildFeishuFields };
