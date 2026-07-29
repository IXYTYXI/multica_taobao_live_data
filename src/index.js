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
const { initLogger, installConsoleBridge, closeLogger } = require('./logger');
initLogger();
installConsoleBridge();

const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const config = require('./config');
const {
  launchBrowser,
  enterLiveRoom,
  findActivePage,
  isPageUsable,
  isRecoverablePageError,
  isCommentPanelStale,
  recoverControlPanel,
  refreshControlPanelPage,
  closeBrowserSession,
  dumpPageDOM,
  getRecentComments,
  scrollCommentListUp,
  processCommentsFromTopDown,
  scrollCommentListToTop,
  scrollCommentListToBottom,
  viewOrderForComment,
  nowBeijing,
} = require('./browser');
const { writeRecord, writeBatchRecords, updateBatchRecords, findExistingRecordKeys, findRecordsByKeys } = require('./feishu');

dayjs.extend(utc);
dayjs.extend(timezone);

const BEIJING_TZ = 'Asia/Shanghai';

// ─── 持久化去重 + outbox ──────────────────────────────────────────
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DEDUP_FILE = path.join(DATA_DIR, 'dedup.json');
const ORDER_DEDUP_FILE = path.join(DATA_DIR, 'order-dedup.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'outbox.json');
const STARTUP_BACKFILL_FILE = path.join(DATA_DIR, 'startup-backfill.json');
const PERIODIC_BACKFILL_FILE = path.join(DATA_DIR, 'periodic-backfill.json');
const RECOVERY_BACKFILL_FILE = path.join(DATA_DIR, 'recovery-backfill.json');
const PERIODIC_BACKFILL_STATE_FILE = path.join(DATA_DIR, 'periodic-backfill-state.json');
const PENDING_ORDER_UPDATES_FILE = path.join(DATA_DIR, 'pending-order-updates.json');
const COMMENTS_AWAITING_ORDER_FILE = path.join(DATA_DIR, 'comments-awaiting-order.json');
/** 每轮监控最多对几条「已入库、仍缺订单」的评论再点「查看订单」（含不在 5 分钟窗口内的） */
const MAX_AWAITING_ORDER_RETRY_PER_ROUND = 8;

const RECOVERY_COOLDOWN_MS = 60000;
let lastRecoveryAttemptMs = 0;
let lastPageRefreshMs = Date.now();
let consecutiveStaleScans = 0;

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

function loadOrderDedup() {
  const data = loadJSON(ORDER_DEDUP_FILE);
  return data ? new Set(data) : new Set();
}

function saveOrderDedup(set) {
  atomicWrite(ORDER_DEDUP_FILE, [...set]);
}

/**
 * 解析订单字段。同一订单号可写入多条评论（每条评论对照弹窗订单）。
 * duplicate 仅表示该订单号已在别行录入过，不再重复计入 order-dedup 统计。
 */
function resolveOrderFields(matchedOrder, recordedOrderIds, batchOrderIds) {
  const orderId = (matchedOrder?.orderId || '').trim();
  const paymentTime = matchedOrder?.paymentTime || '';
  if (!orderId) {
    return { orderId: '', paymentTime: '', duplicate: false };
  }
  const duplicate = recordedOrderIds.has(orderId) || batchOrderIds.has(orderId);
  if (!duplicate) {
    batchOrderIds.add(orderId);
  }
  return { orderId, paymentTime, duplicate };
}

function loadOutbox() {
  const data = loadJSON(OUTBOX_FILE);
  return Array.isArray(data) ? data : [];
}

function saveOutbox(records) {
  atomicWrite(OUTBOX_FILE, records);
}

function loadPendingOrderUpdates() {
  const data = loadJSON(PENDING_ORDER_UPDATES_FILE);
  return Array.isArray(data) ? data : [];
}

function savePendingOrderUpdates(records) {
  pendingOrderUpdates = records;
  atomicWrite(PENDING_ORDER_UPDATES_FILE, records);
}

function queuePendingOrderUpdates(records) {
  const map = new Map(pendingOrderUpdates.map((r) => [recordKey(r), r]));
  for (const r of records) {
    map.set(recordKey(r), { ...r, _feishuUpdate: true });
  }
  savePendingOrderUpdates([...map.values()]);
}

function removePendingOrderUpdates(keys) {
  const drop = new Set(keys);
  savePendingOrderUpdates(pendingOrderUpdates.filter((r) => !drop.has(recordKey(r))));
}

function recordKey(r) {
  return `${r.commenterID}_${r.commentTime}_${r.commentContent}`;
}

function loadCommentsAwaitingOrder() {
  const data = loadJSON(COMMENTS_AWAITING_ORDER_FILE);
  if (!Array.isArray(data)) return [];
  return data.filter((r) => r && r.commenterID && r.commentTime);
}

function saveCommentsAwaitingOrder(list) {
  atomicWrite(COMMENTS_AWAITING_ORDER_FILE, list);
}

function isAwaitingOrder(key) {
  return commentsAwaitingOrder.some((r) => recordKey(r) === key);
}

function markCommentAwaitingOrder(record) {
  const key = recordKey(record);
  if (isAwaitingOrder(key)) return;
  commentsAwaitingOrder.push({
    commenterID: record.commenterID,
    commenterName: record.commenterName || record.commenterID,
    commentTime: record.commentTime,
    commentContent: record.commentContent || '',
  });
  saveCommentsAwaitingOrder(commentsAwaitingOrder);
}

function clearCommentAwaitingOrder(record) {
  const key = recordKey(record);
  const next = commentsAwaitingOrder.filter((r) => recordKey(r) !== key);
  if (next.length === commentsAwaitingOrder.length) return;
  commentsAwaitingOrder = next;
  saveCommentsAwaitingOrder(commentsAwaitingOrder);
}

const recordedComments = loadDedup();
const recordedOrderIds = loadOrderDedup();
let pendingOutbox = loadOutbox();
let pendingOrderUpdates = loadPendingOrderUpdates();
let commentsAwaitingOrder = loadCommentsAwaitingOrder();
/** @type {{ browser: import('playwright').Browser|null, context: import('playwright').BrowserContext, listPage: import('playwright').Page, activePage: import('playwright').Page|null }|null} */
let activeSession = null;
let isShuttingDown = false;


/**
 * 将一批记录写入飞书。写入前先追加到 outbox（write-ahead），
 * 成功后才标记去重并从 outbox 移除。
 * @param {Array} records
 * @param {{ isRetry?: boolean }} opts - isRetry=true 时先做远端对账
 */
async function flushRecords(records, { isRetry = false } = {}) {
  if (records.length === 0) return;

  const orderUpdates = records.filter((r) => r._feishuUpdate && r.orderId);
  const creates = records.filter((r) => !r._feishuUpdate);
  let createFallbacks = [];
  if (orderUpdates.length > 0) {
    createFallbacks = await flushOrderUpdates(orderUpdates);
  }
  if (creates.length === 0 && createFallbacks.length === 0) return;
  records = [...creates, ...createFallbacks];

  // 按 key 去重：排除已确认 + 批次内去重（防同批重复发送）
  const sendMap = new Map();
  for (const r of records) {
    const k = recordKey(r);
    if ((!recordedComments.has(k) || r._forceCreate) && !sendMap.has(k)) {
      sendMap.set(k, r);
    }
  }
  let toSend = [...sendMap.values()];
  if (toSend.length === 0) return;

  // 写入前飞书对账：dedup 空但飞书已有评论 → 补单/同步 dedup，避免重复行
  if (!isRetry) {
    try {
      const { creates, orderUpdates: reconciledUpdates, dedupSyncKeys } =
        await reconcileCreatesWithFeishu(toSend);
      if (dedupSyncKeys.length > 0) {
        for (const k of dedupSyncKeys) recordedComments.add(k);
        saveDedup(recordedComments);
      }
      if (reconciledUpdates.length > 0) {
        const fallbacks = await flushOrderUpdates(reconciledUpdates);
        if (fallbacks.length > 0) {
          creates.push(...fallbacks);
        }
      }
      toSend = creates;
    } catch (e) {
      console.log('[主程序] 飞书对账失败，按新建继续:', e.message);
    }
    if (toSend.length === 0) {
      rebuildOutbox();
      return;
    }
  }

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
    if (r.orderId) {
      recordedOrderIds.add(r.orderId);
      clearCommentAwaitingOrder(r);
    } else if (!r._feishuUpdate) {
      markCommentAwaitingOrder(r);
    }
  }
  saveDedup(recordedComments);
  saveOrderDedup(recordedOrderIds);
  rebuildOutbox();

  const failCount = toSend.length - succeeded.length;
  if (failCount > 0) {
    console.log(`[主程序] ${failCount} 条记录写入失败，保留在 outbox 待重试`);
  }
}

/**
 * 对已写入飞书但缺订单号的评论，补写订单字段
 */
async function flushOrderUpdates(records) {
  const existing = await findRecordsByKeys(records);
  const toUpdate = [];
  const notFound = [];

  for (const r of records) {
    const key = recordKey(r);
    const found = existing.get(key);
    if (!found) {
      console.log(`[主程序] 补单: 飞书未找到评论 ${r.commenterName} ${r.commentTime}，将尝试新建带订单记录`);
      notFound.push({
        commenterID: r.commenterID,
        commenterName: r.commenterName,
        commentTime: r.commentTime,
        commentContent: r.commentContent,
        orderId: r.orderId,
        paymentTime: r.paymentTime,
        _forceCreate: true,
      });
      continue;
    }
    if (found.orderId) {
      console.log(`[主程序] 补单: ${r.commenterName} 已有订单 ${found.orderId}，跳过`);
      clearCommentAwaitingOrder(r);
      continue;
    }
    toUpdate.push({ recordId: found.recordId, record: r });
  }

  if (toUpdate.length > 0) {
    try {
      await updateBatchRecords(toUpdate);
      for (const { record } of toUpdate) {
        if (record.orderId) recordedOrderIds.add(record.orderId);
      }
      saveOrderDedup(recordedOrderIds);
      removePendingOrderUpdates(toUpdate.map(({ record }) => recordKey(record)));
      for (const { record } of toUpdate) {
        clearCommentAwaitingOrder(record);
      }
      console.log(`[主程序] 成功补写 ${toUpdate.length} 条订单到飞书`);
    } catch (e) {
      console.error('[主程序] 补写订单失败:', e.message);
      queuePendingOrderUpdates(toUpdate.map(({ record }) => record));
    }
  }

  return notFound;
}

/**
 * 写入前与飞书对账：dedup 为空但飞书已有评论时，补单而非重复新建。
 * @returns {{ creates: Array, orderUpdates: Array, dedupSyncKeys: string[] }}
 */
async function reconcileCreatesWithFeishu(toSend) {
  if (!toSend || toSend.length === 0) {
    return { creates: [], orderUpdates: [], dedupSyncKeys: [] };
  }

  const existing = await findRecordsByKeys(toSend);
  const creates = [];
  const orderUpdates = [];
  const dedupSyncKeys = [];

  for (const r of toSend) {
    const key = recordKey(r);
    const found = existing.get(key);
    if (!found) {
      creates.push(r);
      continue;
    }

    const name = r.commenterName || r.commenterID;
    if (found.orderId) {
      dedupSyncKeys.push(key);
      clearCommentAwaitingOrder(r);
      console.log(`[主程序] 飞书对账: ${name} 已有评论+订单，同步 dedup`);
      continue;
    }

    if (r.orderId) {
      orderUpdates.push({ ...r, _feishuUpdate: true });
      console.log(`[主程序] 飞书对账: ${name} 已有评论缺订单，改补单 → ${r.orderId}`);
    } else {
      dedupSyncKeys.push(key);
      markCommentAwaitingOrder(r);
      console.log(`[主程序] 飞书对账: ${name} 已有评论仍无订单，同步 dedup 并标记待补订单`);
    }
  }

  if (orderUpdates.length > 0 || dedupSyncKeys.length > 0) {
    console.log(
      `[主程序] 飞书对账: 新建 ${creates.length}，补单 ${orderUpdates.length}，同步 dedup ${dedupSyncKeys.length}`
    );
  }

  return { creates, orderUpdates, dedupSyncKeys };
}

/**
 * 重试 pending-order-updates.json 中上次补单失败的记录
 */
async function retryPendingOrderUpdates() {
  if (pendingOrderUpdates.length === 0) return;

  console.log(`[主程序] 重试 ${pendingOrderUpdates.length} 条待补订单（上次更新失败）...`);
  const batch = [...pendingOrderUpdates];
  await flushRecords(batch.map((r) => ({ ...r, _feishuUpdate: true })));
}

/**
 * 校验飞书中「已有评论但缺订单」的记录，并尝试再次查单补写。
 * 覆盖：评论先写入、补单/update 失败、或当时未查到订单后来可查到的场景。
 */
async function verifyAndRepairMissingOrders(page, comments, batchOrderIds, { label = '兜底' } = {}) {
  if (!comments?.length) {
    return { checked: 0, missing: 0, repaired: 0, stillMissing: 0 };
  }

  const stubs = comments.map((c) => ({
    commenterID: c.userId,
    commenterName: c.nickname,
    commentTime: c.time,
    commentContent: c.content,
  }));

  let existing;
  try {
    existing = await findRecordsByKeys(stubs);
  } catch (e) {
    console.error(`[主程序] ${label} 订单完整性校验: 查询飞书失败`, e.message);
    return { checked: 0, missing: 0, repaired: 0, stillMissing: 0 };
  }

  const needsRepair = [];
  for (const c of comments) {
    const key = recordKey({
      commenterID: c.userId,
      commentTime: c.time,
      commentContent: c.content,
    });

    const found = existing.get(key);
    if (!found || found.orderId) {
      if (found?.orderId && !recordedComments.has(key)) {
        recordedComments.add(key);
      }
      continue;
    }

    needsRepair.push(c);
    if (!recordedComments.has(key)) {
      recordedComments.add(key);
    }
  }
  if (needsRepair.length > 0) {
    saveDedup(recordedComments);
  }

  console.log(
    `[主程序] ${label} 订单完整性校验: 本轮 ${comments.length} 条，飞书缺订单 ${needsRepair.length} 条`
  );

  if (needsRepair.length === 0) {
    return { checked: comments.length, missing: 0, repaired: 0, stillMissing: 0 };
  }

  await scrollCommentListToTop(page);

  const repairRecords = [];
  for (const c of needsRepair) {
    console.log(`[主程序] ${label} 完整性修复: ${c.nickname}(${c.userId}) ${c.time}`);
    const matchedOrder = await viewOrderForComment(page, c, { maxFindSteps: 80 });
    const { orderId, paymentTime, duplicate } = resolveOrderFields(
      matchedOrder,
      recordedOrderIds,
      batchOrderIds
    );
    if (!orderId) continue;

    repairRecords.push({
      commenterID: c.userId,
      commenterName: c.nickname,
      commentTime: c.time,
      commentContent: c.content,
      orderId,
      paymentTime,
      _feishuUpdate: true,
    });
  }

  if (repairRecords.length > 0) {
    await flushRecords(repairRecords);
  }

  const stillMissing = needsRepair.length - repairRecords.length;
  console.log(
    `[主程序] ${label} 订单完整性修复完成: 尝试 ${needsRepair.length} 条，成功 ${repairRecords.length} 条，仍缺 ${stillMissing} 条`
  );

  return {
    checked: comments.length,
    missing: needsRepair.length,
    repaired: repairRecords.length,
    stillMissing,
  };
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

let initialCommentSyncDone = false;
let lastPeriodicBackfillMs = 0;

function loadLastPeriodicBackfillMs() {
  const data = loadJSON(PERIODIC_BACKFILL_STATE_FILE);
  if (data?.lastRunAt) {
    const d = dayjs.tz(data.lastRunAt, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
    if (d.isValid()) return d.valueOf();
  }
  return 0;
}

function saveLastPeriodicBackfillMs(ms = Date.now()) {
  lastPeriodicBackfillMs = ms;
  atomicWrite(PERIODIC_BACKFILL_STATE_FILE, {
    lastRunAt: dayjs(ms).tz(BEIJING_TZ).format('YYYY-MM-DD HH:mm:ss'),
  });
}

function isPeriodicBackfillDue() {
  const hours = config.monitor.periodicBackfillHours;
  if (!hours || hours <= 0) return false;
  if (!lastPeriodicBackfillMs) lastPeriodicBackfillMs = loadLastPeriodicBackfillMs();
  return Date.now() - lastPeriodicBackfillMs >= hours * 3600 * 1000;
}

/**
 * 将评论列表转为待写入记录（含查看订单）
 * @param {{ mode?: 'monitor'|'backfill', onProgress?: Function }} opts
 *   - monitor：仅处理未去重的新评论
 *   - backfill：每条评论强制 viewOrderForComment（恢复/定时/启动兜底）
 */
async function buildRecordsFromComments(page, comments, batchOrderIds, { onProgress, mode = 'monitor', maxFindSteps } = {}) {
  const isBackfill = mode === 'backfill';
  const newRecords = [];

  if (isBackfill && comments.length > 0) {
    console.log(`[主程序] 本屏 ${comments.length} 条评论，逐条查订单...`);
  }

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    const key = recordKey({
      commenterID: comment.userId,
      commentTime: comment.time,
      commentContent: comment.content,
    });
    const alreadyRecorded = recordedComments.has(key);
    const needsOrderRetry = isAwaitingOrder(key);
    if (alreadyRecorded && !isBackfill && !needsOrderRetry) {
      continue;
    }

    if (alreadyRecorded) {
      const label = needsOrderRetry && !isBackfill ? '监控补查订单' : '补查订单';
      console.log(`[主程序] ${label}: ${comment.nickname}(${comment.userId}) ${comment.time} - ${comment.content}`);
    } else {
      console.log(`[主程序] 处理: ${comment.nickname}(${comment.userId}) ${comment.time} - ${comment.content}`);
    }

    const findSteps = maxFindSteps ?? 60;
    const matchedOrder = await viewOrderForComment(page, comment, { maxFindSteps: findSteps });
    const { orderId, paymentTime, duplicate } = resolveOrderFields(
      matchedOrder,
      recordedOrderIds,
      batchOrderIds
    );
    if (duplicate) {
      console.log(`[主程序] 订单 ${orderId} 已在其他评论录入，本条仍写入订单号 ${orderId}`);
    }

    if (alreadyRecorded) {
      if (!orderId) {
        markCommentAwaitingOrder({
          commenterID: comment.userId,
          commenterName: comment.nickname,
          commentTime: comment.time,
          commentContent: comment.content,
        });
        if (isBackfill || needsOrderRetry) {
          console.log(`[主程序] 补查订单未获得订单号: ${comment.nickname}(${comment.userId}) ${comment.time}`);
        }
        continue;
      }
      newRecords.push({
        commenterID: comment.userId,
        commenterName: comment.nickname,
        commentTime: comment.time,
        commentContent: comment.content,
        orderId,
        paymentTime,
        _feishuUpdate: true,
      });
      if (onProgress) {
        await onProgress(i + 1, comments.length, newRecords);
      }
      continue;
    }

    const record = {
      commenterID: comment.userId,
      commenterName: comment.nickname,
      commentTime: comment.time,
      commentContent: comment.content,
      orderId,
      paymentTime,
    };

    newRecords.push(record);
    if (onProgress) {
      await onProgress(i + 1, comments.length, newRecords);
    }
  }

  return newRecords;
}

/**
 * 兜底流程（只做一遍）：
 *   1. 向上滑动 N 次 → 互动列表到顶
 *   2. 从顶部向下逐屏 → 获取评论 + 查订单 + 写飞书
 */
async function runScrollBackfill(page, { label, snapshotFile, kind = 'backfill' }) {
  console.log(`[主程序] ========== ${label} ==========`);

  const scannedAt = dayjs().tz(BEIJING_TZ).format('YYYY-MM-DD HH:mm:ss');
  const batchOrderIds = new Set();
  const allRecords = [];
  let comments = [];
  let processedCount = 0;

  try {
    console.log(`[主程序] ${label} 第1步: 向上滑动定位到顶部...`);
    await scrollCommentListUp(page);
  } catch (e) {
    console.error(`[主程序] ${label} 定位到顶部失败:`, e.message);
    return { ok: false, writtenCount: 0, commentCount: 0 };
  }

  console.log(`[主程序] ${label} 第2步: 从顶部向下逐屏获取评论、查订单并录入（只走一遍）...`);

  try {
    const result = await processCommentsFromTopDown(page, async (batchComments, meta) => {
      processedCount += batchComments.length;

      const newRecords = await buildRecordsFromComments(page, batchComments, batchOrderIds, {
        mode: 'backfill',
        maxFindSteps: 60,
        onProgress: async (done, total) => {
          if (snapshotFile && (done === total || done % 3 === 0)) {
            atomicWrite(snapshotFile, {
              version: 1,
              kind,
              stage: 'processing',
              scannedAt,
              commentCount: meta.totalSeen,
              processedCount,
              records: allRecords,
            });
          }
        },
      });

      if (newRecords.length > 0) {
        await flushRecords(newRecords);
        allRecords.push(...newRecords);
        console.log(`[主程序] ${label} 本屏写入 ${newRecords.length} 条（累计 ${allRecords.length} 条）`);
      }
    });
    comments = result.comments || [];
  } catch (e) {
    console.error(`[主程序] ${label}处理失败:`, e.message);
    return { ok: false, writtenCount: allRecords.length, commentCount: comments.length };
  }

  if (snapshotFile) {
    atomicWrite(snapshotFile, {
      version: 1,
      kind,
      stage: 'done',
      scannedAt,
      commentCount: comments.length,
      comments,
      records: allRecords,
      writtenCount: allRecords.length,
      finishedAt: dayjs().tz(BEIJING_TZ).format('YYYY-MM-DD HH:mm:ss'),
    });
    console.log(`[主程序] ${label}已落盘: ${snapshotFile} (${comments.length} 条评论, ${allRecords.length} 条写入)`);
  }

  if (comments.length === 0) {
    console.log(`[主程序] ${label}完成（无评论）`);
    return { ok: true, writtenCount: 0, commentCount: 0 };
  }

  const verifyResult = await verifyAndRepairMissingOrders(page, comments, batchOrderIds, { label });
  if (verifyResult.missing > 0) {
    console.log(
      `[主程序] ${label} 完整性校验汇总: 缺订单 ${verifyResult.missing} 条，修复 ${verifyResult.repaired} 条，仍缺 ${verifyResult.stillMissing} 条`
    );
  }

  await scrollCommentListToBottom(page);

  console.log(
    `[主程序] ========== ${label}完成（评论 ${comments.length} 条，录入 ${allRecords.length} 条）==========`
  );
  return { ok: true, writtenCount: allRecords.length, commentCount: comments.length };
}

/**
 * 浏览器关闭后恢复，并滚动兜底；每条评论强制 viewOrderForComment
 */
async function runRecoveryBackfill(page) {
  await runScrollBackfill(page, {
    label: '恢复兜底',
    snapshotFile: RECOVERY_BACKFILL_FILE,
    kind: 'recovery',
  });
}

/**
 * 尝试恢复浏览器会话；force=true 时跳过冷却（用于明确检测到页面关闭）
 * @returns {Promise<import('playwright').Page|null>}
 */
async function tryRecoverSession(session, { force = false } = {}) {
  if (!config.monitor.autoRecoverBrowser) {
    console.log('[主程序] 页面不可用，自动恢复已关闭 (AUTO_RECOVER_BROWSER=false)');
    return null;
  }

  const now = Date.now();
  if (!force && now - lastRecoveryAttemptMs < RECOVERY_COOLDOWN_MS) {
    console.log('[主程序] 恢复冷却中，稍后再试...');
    return null;
  }
  lastRecoveryAttemptMs = now;

  session.activePage = await recoverControlPanel(session);
  await runRecoveryBackfill(session.activePage);
  return session.activePage;
}

/**
 * 确保当前有可用的中控台页面
 * @returns {Promise<import('playwright').Page|null>}
 */
async function ensureActivePage(session) {
  if (await isPageUsable(session.activePage)) {
    return session.activePage;
  }
  return tryRecoverSession(session);
}

/**
 * 启动兜底：直播已在进行时，先滚动全量扫描历史评论
 */
async function runStartupBackfill(page) {
  if (!config.monitor.startupBackfill) {
    console.log('[主程序] 启动兜底已关闭 (STARTUP_BACKFILL=false)');
    initialCommentSyncDone = true;
    return;
  }

  await runScrollBackfill(page, {
    label: '启动兜底',
    snapshotFile: STARTUP_BACKFILL_FILE,
    kind: 'startup',
  });

  initialCommentSyncDone = true;
  saveLastPeriodicBackfillMs();
}

/**
 * 定时滚动兜底：每隔 N 小时滚动扫描；每条评论强制 viewOrderForComment
 */
async function runPeriodicScrollBackfill(page) {
  const hours = config.monitor.periodicBackfillHours;
  if (!hours || hours <= 0) return;

  await runScrollBackfill(page, {
    label: `定时兜底(${hours}h)`,
    snapshotFile: PERIODIC_BACKFILL_FILE,
    kind: 'periodic',
  });

  saveLastPeriodicBackfillMs();
}

/**
 * 扫描近期评论，处理新条目
 *
 * 1. 仅在"全部"标签扫描，不来回切换标签
 * 2. 启动兜底已在 runStartupBackfill 中全量扫描；此处只处理时间窗口内新评论
 * 3. 每条新评论：悬停该行 → 点「查看订单」→ 有则写入订单，无则写评论并标记待补；已在 dedup 且待补的会在监控轮询中继续查单
 * 4. 同一订单号可出现在多条评论上（order-dedup 仅统计）
 */
async function processNewComments(page) {
  const result = await getRecentComments(page, config.monitor.commentCheckMinutes, { syncAllVisible: false });

  if (result.error) {
    console.error('[主程序] 采集评论出错，跳过本轮:', result.error);
    if (isRecoverablePageError(result.error)) return 'recover';
    return false;
  }

  if (isCommentPanelStale(result, page.url())) {
    consecutiveStaleScans++;
    console.log(
      `[主程序] 评论区扫描异常 (${consecutiveStaleScans}/${config.monitor.staleScanThreshold})，` +
        '页面可能卡死'
    );
    if (consecutiveStaleScans >= config.monitor.staleScanThreshold) {
      return 'refresh';
    }
  } else {
    consecutiveStaleScans = 0;
  }

  const allEntries = [...result.comments];
  const seenKeys = new Set(
    allEntries.map((c) =>
      recordKey({
        commenterID: c.userId,
        commentTime: c.time,
        commentContent: c.content,
      })
    )
  );

  let awaitingRetryQueued = 0;
  for (const stub of commentsAwaitingOrder) {
    if (awaitingRetryQueued >= MAX_AWAITING_ORDER_RETRY_PER_ROUND) break;
    const k = recordKey(stub);
    if (seenKeys.has(k)) continue;
    allEntries.push({
      userId: stub.commenterID,
      nickname: stub.commenterName || stub.commenterID,
      time: stub.commentTime,
      content: stub.commentContent || '',
    });
    seenKeys.add(k);
    awaitingRetryQueued += 1;
  }

  if (awaitingRetryQueued > 0) {
    console.log(
      `[主程序] 本轮额外补查 ${awaitingRetryQueued} 条待补订单评论（共待补 ${commentsAwaitingOrder.length} 条）`
    );
  }

  if (allEntries.length === 0) {
    if (commentsAwaitingOrder.length > 0) {
      console.log(`[主程序] 近期无新评论，仍有 ${commentsAwaitingOrder.length} 条待补订单`);
    } else {
      console.log('[主程序] 近期无新评论或订单');
    }
    return true;
  }

  const orderEntryCount = allEntries.filter(e => e.content && e.content.includes('已下单')).length;
  if (orderEntryCount > 0) {
    console.log(`[主程序] 本轮含 ${orderEntryCount} 条带「已下单」标记的评论（仅供参考）`);
  }

  const batchOrderIds = new Set();
  const newRecords = await buildRecordsFromComments(page, allEntries, batchOrderIds);

  if (newRecords.length > 0) {
    console.log(`[主程序] 准备写入 ${newRecords.length} 条新记录到飞书...`);
    await flushRecords(newRecords);
  }

  return true;
}

/**
 * 主监控循环
 * 每轮周期性扫描评论区，对每条新评论尝试查看订单并写入飞书。
 * 浏览器意外关闭时会自动重新打开并回到中控台。
 */
async function monitorLoop(session) {
  const intervalMs = config.monitor.intervalSeconds * 1000;

  console.log(`[主程序] 开始监控，检查间隔: ${config.monitor.intervalSeconds}秒`);
  console.log(`[主程序] 评论检查范围: 最近 ${config.monitor.commentCheckMinutes} 分钟`);
  if (config.monitor.periodicBackfillHours > 0) {
    console.log(`[主程序] 定时滚动兜底: 每 ${config.monitor.periodicBackfillHours} 小时`);
  }
  if (commentsAwaitingOrder.length > 0) {
    console.log(`[主程序] 待补订单评论: ${commentsAwaitingOrder.length} 条（监控轮询会持续补查）`);
  }
  if (config.monitor.autoRecoverBrowser) {
    console.log('[主程序] 浏览器自动恢复: 已开启');
  }
  if (config.monitor.pageRefreshMinutes > 0) {
    console.log(`[主程序] 定时页面刷新: 每 ${config.monitor.pageRefreshMinutes} 分钟`);
  }
  console.log(`[主程序] 当前北京时间: ${nowBeijing().format('YYYY-MM-DD HH:mm:ss')}`);

  // 启动时重试上次补单失败 + outbox 残留
  await retryPendingOrderUpdates();

  if (pendingOutbox.length > 0) {
    console.log(`[主程序] 发现 ${pendingOutbox.length} 条未成功写入的记录，对账后重试...`);
    await flushRecords(pendingOutbox, { isRetry: true });
  }

  await runStartupBackfill(session.activePage);

  while (true) {
    try {
      let page = await ensureActivePage(session);
      if (!page) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      if (isPeriodicBackfillDue()) {
        await runPeriodicScrollBackfill(page);
        page = session.activePage;
      }

      const refreshMinutes = config.monitor.pageRefreshMinutes;
      if (refreshMinutes > 0) {
        const refreshMs = refreshMinutes * 60 * 1000;
        if (Date.now() - lastPageRefreshMs >= refreshMs) {
          console.log(`[主程序] 到达定时刷新间隔 (${refreshMinutes} 分钟)，刷新中控台...`);
          session.activePage = await refreshControlPanelPage(page);
          page = session.activePage;
          lastPageRefreshMs = Date.now();
          consecutiveStaleScans = 0;
        }
      }

      console.log(`[主程序] [${nowBeijing().format('HH:mm:ss')}] 扫描评论和订单...`);
      const scanResult = await processNewComments(page);

      if (scanResult === 'refresh') {
        console.log('[主程序] 评论区异常，触发页面刷新...');
        session.activePage = await refreshControlPanelPage(page);
        lastPageRefreshMs = Date.now();
        consecutiveStaleScans = 0;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      if (scanResult === 'recover') {
        await tryRecoverSession(session, { force: true });
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      if (pendingOutbox.length > 0) {
        console.log(`[主程序] 重试 outbox 中 ${pendingOutbox.length} 条记录...`);
        await flushRecords(pendingOutbox, { isRetry: true });
      }

      if (pendingOrderUpdates.length > 0) {
        await retryPendingOrderUpdates();
      }
    } catch (e) {
      console.error(`[主程序] 监控循环异常: ${e.message}`);
      if (isRecoverablePageError(e.message)) {
        await tryRecoverSession(session, { force: true });
      }
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
    const session = { browser, context, listPage: page, activePage: null };
    activeSession = session;

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
    session.activePage = activePage;
    session.listPage = page;

    // 5. 保存页面 DOM 用于调试（每次启动执行一次）
    await dumpPageDOM(activePage);

    // 6. 开始监控循环
    await monitorLoop(session);
  } catch (e) {
    console.error('[致命错误]', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

// 优雅退出 — 保存数据并关闭浏览器
function gracefulExit(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[主程序] 收到 ${signal} 信号，正在退出...`);
  console.log(`[主程序] 本次运行共记录 ${recordedComments.size} 条评论，${recordedOrderIds.size} 个订单`);
  if (pendingOutbox.length > 0) {
    console.log(`[主程序] ${pendingOutbox.length} 条记录未成功写入，已保存到 outbox，下次启动时重试`);
  }
  saveDedup(recordedComments);
  saveOrderDedup(recordedOrderIds);
  saveOutbox(pendingOutbox);
  saveCommentsAwaitingOrder(commentsAwaitingOrder);

  const finish = () => {
    activeSession = null;
    closeLogger();
    process.exit(0);
  };

  if (!activeSession) {
    finish();
    return;
  }

  console.log('[主程序] 正在关闭浏览器...');
  Promise.race([
    closeBrowserSession(activeSession),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ])
    .catch((e) => {
      console.log('[主程序] 关闭浏览器失败:', e.message);
    })
    .finally(finish);
}

process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

main();
