/**
 * 飞书 API 模块
 * 负责获取 tenant_access_token 并写入多维表格
 */
const axios = require('axios');
const config = require('./config');

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

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

  const res = await axios.post(
    `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
    {
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    }
  );

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
 * @param {string} record.commenterID - 评论者ID
 * @param {string} record.commentTime - 评论时间
 * @param {string} record.commentContent - 评论内容
 * @param {string} record.orderNumber - 订单编号
 * @param {string} record.paymentTime - 下单（支付）时间
 */
async function writeRecord(record) {
  const token = await getTenantAccessToken();
  const { baseAppToken, tableId } = config.feishu;

  const fields = {
    '评论者ID': record.commenterID || '',
    '评论时间': record.commentTime || '',
    '评论内容': record.commentContent || '',
    '订单编号': record.orderNumber || '',
    '下单时间': record.paymentTime || '',
  };

  const res = await axios.post(
    `${FEISHU_BASE}/bitable/v1/apps/${baseAppToken}/tables/${tableId}/records`,
    { fields },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (res.data.code !== 0) {
    throw new Error(`写入飞书失败: ${JSON.stringify(res.data)}`);
  }

  console.log(`[飞书] 写入成功: ${record.commenterID} - ${record.commentContent}`);
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
    fields: {
      '评论者ID': record.commenterID || '',
      '评论时间': record.commentTime || '',
      '评论内容': record.commentContent || '',
      '订单编号': record.orderNumber || '',
      '下单时间': record.paymentTime || '',
    },
  }));

  const res = await axios.post(
    `${FEISHU_BASE}/bitable/v1/apps/${baseAppToken}/tables/${tableId}/records/batch_create`,
    { records: batchRecords },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (res.data.code !== 0) {
    throw new Error(`批量写入飞书失败: ${JSON.stringify(res.data)}`);
  }

  console.log(`[飞书] 批量写入成功: ${records.length} 条记录`);
  return res.data;
}

module.exports = { writeRecord, writeBatchRecords };
