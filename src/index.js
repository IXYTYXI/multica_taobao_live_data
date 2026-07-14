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
  dumpPageDOM,
  getRecentComments,
  scrollAndCollectAllComments,
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
 * 同一订单号只保留一条记录；后续评论若弹窗仍返回该订单，则只写评论不写订单。
 */
function resolveOrderFields(matchedOrder, recordedOrderIds, batchOrderIds) {
  const orderId = (matchedOrder?.orderId || '').trim();
  const paymentTime = matchedOrder?.paymentTime || '';
  if (!orderId) {
    return { orderId: '', paymentTime: '' };
  }
  if (recordedOrderIds.has(orderId) || batchOrderIds.has(orderId)) {
    return { orderId: '', paymentTime: '', duplicate: true };
  }
  batchOrderIds.add(orderId);
  return { orderId, paymentTime, duplicate: false };
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
const recordedOrderIds = loadOrderDedup();
let pendingOutbox = loadOutbox();


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
  if (orderUpdates.length > 0) {
    await flushOrderUpdates(orderUpdates);
  }
  if (creates.length === 0) return;
  records = creates;

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
    if (r.orderId) recordedOrderIds.add(r.orderId);
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

  for (const r of records) {
    const key = recordKey(r);
    const found = existing.get(key);
    if (!found) {
      console.log(`[主程序] 补单: 飞书未找到评论 ${r.commenterName} ${r.commentTime}`);
      continue;
    }
    if (found.orderId) {
      console.log(`[主程序] 补单: ${r.commenterName} 已有订单 ${found.orderId}，跳过`);
      continue;
    }
    toUpdate.push({ recordId: found.recordId, record: r });
  }

  if (toUpdate.length === 0) return;

  try {
    await updateBatchRecords(toUpdate);
    for (const { record } of toUpdate) {
      if (record.orderId) recordedOrderIds.add(record.orderId);
    }
    saveOrderDedup(recordedOrderIds);
    console.log(`[主程序] 成功补写 ${toUpdate.length} 条订单到飞书`);
  } catch (e) {
    console.error('[主程序] 补写订单失败:', e.message);
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
async function buildRecordsFromComments(page, comments, batchOrderIds, { onProgress, mode = 'monitor' } = {}) {
  const isBackfill = mode === 'backfill';
  const newRecords = [];

  if (isBackfill) {
    console.log(`[主程序] 兜底：将对 ${comments.length} 条评论逐条执行 viewOrderForComment`);
  }

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    const key = recordKey({
      commenterID: comment.userId,
      commentTime: comment.time,
      commentContent: comment.content,
    });
    const alreadyRecorded = recordedComments.has(key);
    if (alreadyRecorded && !isBackfill) {
      continue;
    }

    if (alreadyRecorded) {
      console.log(`[主程序] 补查订单: ${comment.nickname}(${comment.userId}) ${comment.time} - ${comment.content}`);
    } else {
      console.log(`[主程序] 处理: ${comment.nickname}(${comment.userId}) ${comment.time} - ${comment.content}`);
    }

    const matchedOrder = await viewOrderForComment(page, comment);
    const { orderId, paymentTime, duplicate } = resolveOrderFields(
      matchedOrder,
      recordedOrderIds,
      batchOrderIds
    );
    if (duplicate) {
      console.log(`[主程序] 订单 ${matchedOrder.orderId} 已记录，本条仅保存评论`);
    }

    if (alreadyRecorded) {
      if (!orderId) continue;
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
 * 滚动全量扫描 → 落盘 → 每条评论 viewOrderForComment → 写飞书
 * 用于启动兜底、恢复兜底、定时兜底
 */
async function runScrollBackfill(page, { label, snapshotFile, kind = 'backfill' }) {
  console.log(`[主程序] ========== ${label}：滚动全量扫描 ==========`);

  let comments = [];
  try {
    const result = await scrollAndCollectAllComments(page);
    comments = result.comments || [];
  } catch (e) {
    console.error(`[主程序] ${label}扫描失败:`, e.message);
    return { ok: false, writtenCount: 0, commentCount: 0 };
  }

  const scannedAt = dayjs().tz(BEIJING_TZ).format('YYYY-MM-DD HH:mm:ss');
  if (snapshotFile) {
    atomicWrite(snapshotFile, {
      version: 1,
      kind,
      stage: 'scanned',
      scannedAt,
      commentCount: comments.length,
      comments,
      records: [],
    });
    console.log(`[主程序] ${label}评论已落盘: ${snapshotFile} (${comments.length} 条)`);
  }

  if (comments.length === 0) {
    if (snapshotFile) {
      atomicWrite(snapshotFile, {
        version: 1,
        kind,
        stage: 'done',
        scannedAt,
        commentCount: 0,
        comments: [],
        records: [],
        finishedAt: scannedAt,
      });
    }
    console.log(`[主程序] ${label}完成（无评论）`);
    return { ok: true, writtenCount: 0, commentCount: 0 };
  }

  const batchOrderIds = new Set();
  const newRecords = await buildRecordsFromComments(page, comments, batchOrderIds, {
    mode: 'backfill',
    onProgress: async (done, total, records) => {
      if (!snapshotFile) return;
      if (done % 5 === 0 || done === total) {
        atomicWrite(snapshotFile, {
          version: 1,
          kind,
          stage: 'processing',
          scannedAt,
          commentCount: comments.length,
          comments,
          processedCount: done,
          records,
        });
        console.log(`[主程序] ${label}处理进度: ${done}/${total}`);
      }
    },
  });

  if (snapshotFile) {
    atomicWrite(snapshotFile, {
      version: 1,
      kind,
      stage: 'processed',
      scannedAt,
      commentCount: comments.length,
      comments,
      records: newRecords,
      processedAt: dayjs().tz(BEIJING_TZ).format('YYYY-MM-DD HH:mm:ss'),
    });
  }

  if (newRecords.length > 0) {
    console.log(`[主程序] ${label}：写入 ${newRecords.length} 条记录到飞书...`);
    await flushRecords(newRecords);
  }

  if (snapshotFile) {
    atomicWrite(snapshotFile, {
      version: 1,
      kind,
      stage: 'done',
      scannedAt,
      commentCount: comments.length,
      writtenCount: newRecords.length,
      finishedAt: dayjs().tz(BEIJING_TZ).format('YYYY-MM-DD HH:mm:ss'),
    });
  }

  console.log(`[主程序] ========== ${label}完成（扫描 ${comments.length} 条，新写入 ${newRecords.length} 条）==========`);
  return { ok: true, writtenCount: newRecords.length, commentCount: comments.length };
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
 * 3. 每条新评论：悬停该行 → 点「查看订单」→ 有则写入订单，无则只写评论
 * 4. 同一订单号只保留一条带订单的记录
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

  if (allEntries.length === 0) {
    console.log('[主程序] 近期无新评论或订单');
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
  if (config.monitor.autoRecoverBrowser) {
    console.log('[主程序] 浏览器自动恢复: 已开启');
  }
  if (config.monitor.pageRefreshMinutes > 0) {
    console.log(`[主程序] 定时页面刷新: 每 ${config.monitor.pageRefreshMinutes} 分钟`);
  }
  console.log(`[主程序] 当前北京时间: ${nowBeijing().format('YYYY-MM-DD HH:mm:ss')}`);

  // 启动时重试 outbox 中残留的失败记录（先远端对账防重复）
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

// 优雅退出 — 确保去重集合和 outbox 持久化
function gracefulExit(signal) {
  console.log(`\n[主程序] 收到 ${signal} 信号，正在退出...`);
  console.log(`[主程序] 本次运行共记录 ${recordedComments.size} 条评论，${recordedOrderIds.size} 个订单`);
  if (pendingOutbox.length > 0) {
    console.log(`[主程序] ${pendingOutbox.length} 条记录未成功写入，已保存到 outbox，下次启动时重试`);
  }
  saveDedup(recordedComments);
  saveOrderDedup(recordedOrderIds);
  saveOutbox(pendingOutbox);
  process.exit(0);
}

process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

main();
