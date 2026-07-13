/**
 * 淘宝直播数据采集工具 - 主入口
 *
 * 支持三种浏览器模式（通过 BROWSER_MODE 环境变量设置）：
 *   login   — 打开浏览器让用户手动登录（默认）
 *   profile — 复制本机 Chrome 登录态，无需重新登录
 *   cdp     — 连接已开启调试端口的 Chrome
 *
 * 所有时间使用北京时间（东八区）
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const {
  launchBrowser,
  enterLiveRoom,
  findActivePage,
  dumpPageDOM,
  getRecentComments,
  getOrdersFromTab,
  extractAllOrders,
  nowBeijing,
} = require('./browser');
const { writeRecord, writeBatchRecords, findExistingRecordKeys } = require('./feishu');

// ─── 持久化去重 + outbox ──────────────────────────────────────────
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DEDUP_FILE = path.join(DATA_DIR, 'dedup.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'outbox.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function atomicWrite(filePath, data) {
  ensureDataDir();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.unlinkSync(filePath); } catch {}
    fs.renameSync(tmp, filePath);
  }
}

function loadJSON(filePath) {
  for (const f of [filePath, filePath + '.tmp']) {
    try {
      if (fs.existsSync(f)) {
        const content = fs.readFileSync(f, 'utf8');
        if (content.trim()) return JSON.parse(content);
      }
    } catch {}
  }
  return null;
}

function loadDedup() {
  const data = loadJSON(DEDUP_FILE);
  return data ? new Set(data) : new Set();
}

function saveDedup(set) {
  atomicWrite(DEDUP_FILE, [...set]);
}

function loadOutbox() {
  const data = loadJSON(OUTBOX_FILE);
  return Array.isArray(data) ? data : [];
}

function saveOutbox(records) {
  atomicWrite(OUTBOX_FILE, records);
}

function recordKey(r) {
  return `${r.commenterID}_${r.commentTime}_${r.commentContent}`;
}

const recordedComments = loadDedup();
let pendingOutbox = loadOutbox();


/**
 * 将一批记录写入飞书。写入前先追加到 outbox（write-ahead），
 * 成功后才标记去重并从 outbox 移除。
 * @param {Array} records
 * @param {{ isRetry?: boolean }} opts - isRetry=true 时先做远端对账
 */
async function flushRecords(records, { isRetry = false } = {}) {
  if (records.length === 0) return;

  // 按 key 去重：排除已确认 + 批次内去重（防同批重复发送）
  const sendMap = new Map();
  for (const r of records) {
    const k = recordKey(r);
    if (!recordedComments.has(k) && !sendMap.has(k)) {
      sendMap.set(k, r);
    }
  }
  let toSend = [...sendMap.values()];
  if (toSend.length === 0) return;

  // outbox 重试时先做远端对账：排除超时后服务端实际已写入的记录
  if (isRetry) {
    try {
      const remoteExisting = await findExistingRecordKeys(toSend);
      if (remoteExisting.size > 0) {
        console.log(`[主程序] 远端对账: ${remoteExisting.size} 条已存在于飞书，跳过`);
        for (const k of remoteExisting) recordedComments.add(k);
        saveDedup(recordedComments);
        toSend = toSend.filter(r => !remoteExisting.has(recordKey(r)));
      }
    } catch (e) {
      console.log('[主程序] 远端对账失败，继续发送:', e.message);
    }
    if (toSend.length === 0) {
      rebuildOutbox();
      return;
    }
  }

  // Write-ahead: 确保待发送记录在 outbox 中（崩溃后可恢复）
  const existingKeys = new Set(pendingOutbox.map(recordKey));
  for (const r of toSend) {
    if (!existingKeys.has(recordKey(r))) {
      pendingOutbox.push(r);
    }
  }
  saveOutbox(pendingOutbox);

  const succeeded = [];

  try {
    await writeBatchRecords(toSend);
    succeeded.push(...toSend);
    console.log(`[主程序] 成功写入 ${toSend.length} 条记录`);
  } catch (e) {
    if (e.response && e.response.status >= 400 && e.response.status < 500) {
      console.error('[主程序] 批量写入被拒绝，逐条重试:', e.message);
      for (const record of toSend) {
        try {
          await writeRecord(record);
          succeeded.push(record);
        } catch (err) {
          console.error(`[主程序] 单条写入失败: ${record.commenterID}`, err.message);
        }
      }
    } else {
      console.error('[主程序] 批量写入失败（网络/超时），保留 outbox 下轮重试:', e.message);
    }
  }

  for (const r of succeeded) {
    recordedComments.add(recordKey(r));
  }
  saveDedup(recordedComments);
  rebuildOutbox();

  const failCount = toSend.length - succeeded.length;
  if (failCount > 0) {
    console.log(`[主程序] ${failCount} 条记录写入失败，保留在 outbox 待重试`);
  }
}

function rebuildOutbox() {
  const outboxMap = new Map();
  for (const r of pendingOutbox) {
    const k = recordKey(r);
    if (!recordedComments.has(k) && !outboxMap.has(k)) {
      outboxMap.set(k, r);
    }
  }
  pendingOutbox = [...outboxMap.values()];
  saveOutbox(pendingOutbox);
}

/**
 * 扫描近期评论和"已下单"记录，处理新条目
 *
 * 1. 先从"全部"标签获取评论（包括"已下单"条目）
 * 2. 再从"已下单"标签获取订单条目（可能捕获到"全部"标签遗漏的）
 * 3. 打开订单弹窗提取所有订单（表格结构：商品标题/下单时间/支付时间/订单ID）
 * 4. 按时间匹配关联"已下单"条目与订单ID
 */
async function processNewComments(page) {
  // 1. 获取"全部"标签中的评论
  const result = await getRecentComments(page, config.monitor.commentCheckMinutes);

  if (result.error) {
    console.error('[主程序] 采集评论出错，跳过本轮:', result.error);
    return false;
  }

  // 2. 获取"已下单"标签中的订单记录
  const orderResult = await getOrdersFromTab(page, config.monitor.commentCheckMinutes);
  if (orderResult.error) {
    console.log('[主程序] "已下单"标签采集失败，仅处理评论:', orderResult.error);
  }

  // 3. 合并：评论 + 订单条目，按 key 去重
  const allEntries = [...result.comments];
  const seenKeys = new Set(allEntries.map(c => `${c.userId}_${c.time}_${c.content}`));
  for (const order of (orderResult.orders || [])) {
    const key = `${order.userId}_${order.time}_${order.content}`;
    if (!seenKeys.has(key)) {
      allEntries.push(order);
      seenKeys.add(key);
    }
  }

  if (allEntries.length === 0) {
    console.log('[主程序] 近期无新评论或订单');
    return true;
  }

  // 4. 检查是否有新的"已下单"条目需要关联订单
  const hasNewOrderEntries = allEntries.some(e => {
    const k = recordKey({ commenterID: e.userId, commentTime: e.time, commentContent: e.content });
    return !recordedComments.has(k) &&
      (e.content === '已下单' || (e.content && e.content.includes('已下单')));
  });

  // 5. 如果有新的"已下单"条目，打开订单弹窗提取全部订单
  let allOrders = [];
  if (hasNewOrderEntries) {
    allOrders = await extractAllOrders(page);
    if (allOrders.length > 0) {
      console.log(`[主程序] 从订单弹窗获取到 ${allOrders.length} 条订单`);
    }
  }

  // 6. 处理所有条目
  const newRecords = [];
  const usedOrderIds = new Set();

  for (const comment of allEntries) {
    const key = `${comment.userId}_${comment.time}_${comment.content}`;
    if (recordedComments.has(key)) {
      continue;
    }

    console.log(`[主程序] 处理: ${comment.nickname}(${comment.userId}) ${comment.time} - ${comment.content}`);

    // 对"已下单"条目，按分钟级时间匹配订单
    let matchedOrder = null;
    const isOrderEntry = comment.content === '已下单' || (comment.content && comment.content.includes('已下单'));

    if (isOrderEntry && allOrders.length > 0) {
      const commentMinute = comment.time.substring(0, 16); // "YYYY-MM-DD HH:mm"
      for (const order of allOrders) {
        if (usedOrderIds.has(order.orderId)) continue;
        const orderTimeNorm = (order.orderTime || order.paymentTime || '').substring(0, 16);
        if (commentMinute === orderTimeNorm) {
          matchedOrder = order;
          usedOrderIds.add(order.orderId);
          console.log(`[主程序] 匹配到订单: ${order.orderId}`);
          break;
        }
      }
      if (!matchedOrder) {
        // 放宽到±2分钟内匹配
        const cParts = commentMinute.split(/[-: T]/);
        const cMin = parseInt(cParts[3] || '0', 10) * 60 + parseInt(cParts[4] || '0', 10);
        for (const order of allOrders) {
          if (usedOrderIds.has(order.orderId)) continue;
          const oTime = (order.orderTime || order.paymentTime || '').substring(0, 16);
          const oParts = oTime.split(/[-: T]/);
          const oMin = parseInt(oParts[3] || '0', 10) * 60 + parseInt(oParts[4] || '0', 10);
          if (Math.abs(cMin - oMin) <= 2) {
            matchedOrder = order;
            usedOrderIds.add(order.orderId);
            console.log(`[主程序] 近似匹配到订单: ${order.orderId}`);
            break;
          }
        }
      }
    }

    const record = {
      commenterID: comment.userId,
      commentTime: comment.time,
      commentContent: comment.content,
      orderId: matchedOrder?.orderId || '',
      paymentTime: matchedOrder?.paymentTime || '',
    };

    newRecords.push(record);
  }

  if (newRecords.length > 0) {
    console.log(`[主程序] 准备写入 ${newRecords.length} 条新记录到飞书...`);
    await flushRecords(newRecords);
  }

  return true;
}

/**
 * 主监控循环
 * 每轮周期性扫描评论区，处理新评论和"已下单"订单，不再依赖成交人数作为触发条件。
 */
async function monitorLoop(page) {
  const intervalMs = config.monitor.intervalSeconds * 1000;

  console.log(`[主程序] 开始监控，检查间隔: ${config.monitor.intervalSeconds}秒`);
  console.log(`[主程序] 评论检查范围: 最近 ${config.monitor.commentCheckMinutes} 分钟`);
  console.log(`[主程序] 当前北京时间: ${nowBeijing().format('YYYY-MM-DD HH:mm:ss')}`);

  // 启动时重试 outbox 中残留的失败记录（先远端对账防重复）
  if (pendingOutbox.length > 0) {
    console.log(`[主程序] 发现 ${pendingOutbox.length} 条未成功写入的记录，对账后重试...`);
    await flushRecords(pendingOutbox, { isRetry: true });
  }

  while (true) {
    try {
      console.log(`[主程序] [${nowBeijing().format('HH:mm:ss')}] 扫描评论和订单...`);
      await processNewComments(page);

      if (pendingOutbox.length > 0) {
        console.log(`[主程序] 重试 outbox 中 ${pendingOutbox.length} 条记录...`);
        await flushRecords(pendingOutbox, { isRetry: true });
      }
    } catch (e) {
      console.error(`[主程序] 监控循环异常: ${e.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 主函数
 */
async function main() {
  console.log('========================================');
  console.log('  淘宝直播数据采集工具');
  console.log('  当前北京时间:', nowBeijing().format('YYYY-MM-DD HH:mm:ss'));
  console.log('  浏览器模式:', config.browser.mode);
  console.log('========================================');

  // 检查配置
  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.error('[错误] 请在 .env 文件中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
    process.exit(1);
  }

  try {
    // 1. 启动/连接浏览器
    const { browser, context, page } = await launchBrowser();

    // 2. 进入直播间（未找到直播场次时持续重试，不关闭浏览器）
    // enterLiveRoom 返回中控台页面对象（可能是新标签页），失败返回 null
    let activePage = null;
    while (!activePage) {
      activePage = await enterLiveRoom(page);
      if (!activePage) {
        console.log('[主程序] 未找到正在直播的场次，30 秒后重新检查...');
        console.log('[主程序] 浏览器保持打开，如需登录请在浏览器中操作');
        await new Promise((r) => setTimeout(r, 30000));
        try {
          await page.goto(config.taobao.liveListUrl, { waitUntil: 'networkidle', timeout: 60000 });
        } catch (e) {
          console.log('[主程序] 页面加载异常，继续重试:', e.message);
        }
      }
    }

    // 3. 等待中控台页面完全加载
    console.log('[主程序] 已进入中控台页面，等待页面数据加载...');
    await new Promise((r) => setTimeout(r, 8000));
    console.log('[主程序] 页面加载完成');

    // 4. 确认当前页面是中控台（防止在错误的标签页上运行）
    activePage = await findActivePage(activePage);

    // 5. 保存页面 DOM 用于调试（每次启动执行一次）
    await dumpPageDOM(activePage);

    // 6. 开始监控循环
    await monitorLoop(activePage);
  } catch (e) {
    console.error('[致命错误]', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

// 优雅退出 — 确保去重集合和 outbox 持久化
function gracefulExit(signal) {
  console.log(`\n[主程序] 收到 ${signal} 信号，正在退出...`);
  console.log(`[主程序] 本次运行共记录 ${recordedComments.size} 条评论`);
  if (pendingOutbox.length > 0) {
    console.log(`[主程序] ${pendingOutbox.length} 条记录未成功写入，已保存到 outbox，下次启动时重试`);
  }
  saveDedup(recordedComments);
  saveOutbox(pendingOutbox);
  process.exit(0);
}

process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

main();
