/**
 * 飞书 API 连通性测试
 * 测试 token 获取和多维表格写入（使用实际字段名）
 */
const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
require('dotenv').config();

dayjs.extend(utc);
dayjs.extend(timezone);

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

async function main() {
  console.log('=== 飞书 API 连通性测试 ===\n');

  // 1. 获取 token
  console.log('[1] 获取 tenant_access_token ...');
  const tokenRes = await axios.post(
    `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
    {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }
  );

  if (tokenRes.data.code !== 0) {
    console.error('获取 token 失败:', tokenRes.data);
    process.exit(1);
  }

  const token = tokenRes.data.tenant_access_token;
  console.log('  ✓ token 获取成功\n');

  const baseAppToken = process.env.FEISHU_BASE_APP_TOKEN;
  const tableId = process.env.FEISHU_TABLE_ID;

  // 2. 写入测试记录（使用实际字段名）
  console.log('[2] 写入测试记录...');
  const now = dayjs().tz('Asia/Shanghai');
  const paymentTs = now.valueOf(); // 毫秒时间戳

  const testRecord = {
    fields: {
      '用户ID': 'test_user_auto',
      '用户评论': '自动化测试评论（可删除）',
      '评论时间': now.format('YYYY-MM-DD HH:mm:ss'),
      '订单编号': 'TEST_ORDER_001',
      '支付时间': paymentTs,
    },
  };

  const writeRes = await axios.post(
    `${FEISHU_BASE}/bitable/v1/apps/${baseAppToken}/tables/${tableId}/records`,
    testRecord,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (writeRes.data.code === 0) {
    const recordId = writeRes.data.data.record.record_id;
    console.log('  ✓ 写入成功! record_id:', recordId);

    // 3. 删除测试记录
    console.log('\n[3] 清理测试记录...');
    const delRes = await axios.delete(
      `${FEISHU_BASE}/bitable/v1/apps/${baseAppToken}/tables/${tableId}/records/${recordId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (delRes.data.code === 0) {
      console.log('  ✓ 测试记录已删除');
    } else {
      console.log('  ⚠ 删除失败:', delRes.data.msg);
    }
  } else {
    console.log('  ✗ 写入失败:', writeRes.data.code, writeRes.data.msg);
  }

  // 4. 测试批量写入
  console.log('\n[4] 批量写入测试（2条）...');
  const batchRecords = [
    {
      fields: {
        '用户ID': 'batch_test_1',
        '用户评论': '批量测试1（可删除）',
        '评论时间': now.format('YYYY-MM-DD HH:mm:ss'),
        '订单编号': '',
      },
    },
    {
      fields: {
        '用户ID': 'batch_test_2',
        '用户评论': '批量测试2（可删除）',
        '评论时间': now.format('YYYY-MM-DD HH:mm:ss'),
        '订单编号': 'BATCH_ORDER_002',
        '支付时间': paymentTs,
      },
    },
  ];

  const batchRes = await axios.post(
    `${FEISHU_BASE}/bitable/v1/apps/${baseAppToken}/tables/${tableId}/records/batch_create`,
    { records: batchRecords },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (batchRes.data.code === 0) {
    const ids = batchRes.data.data.records.map((r) => r.record_id);
    console.log('  ✓ 批量写入成功! record_ids:', ids);

    // 清理
    console.log('\n[5] 清理批量记录...');
    const delBatchRes = await axios.post(
      `${FEISHU_BASE}/bitable/v1/apps/${baseAppToken}/tables/${tableId}/records/batch_delete`,
      { records: ids },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (delBatchRes.data.code === 0) {
      console.log('  ✓ 批量记录已删除');
    } else {
      console.log('  ⚠ 批量删除失败:', delBatchRes.data.msg);
    }
  } else {
    console.log('  ✗ 批量写入失败:', batchRes.data.code, batchRes.data.msg);
  }

  console.log('\n=== 所有测试通过 ===');
}

main().catch(console.error);
