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
  getTransactionCount,
  getRecentComments,
  getOrderInfo,
  nowBeijing,
} = require('./browser');
const { writeRecord, writeBatchRecords } = require('./feishu');

// ─── 持久化去重 + outbox ──────────────────────────────────────────
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DEDUP_FILE = path.join(DATA_DIR, 'dedup.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'outbox.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDedup() {
  try {
    if (fs.existsSync(DEDUP_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8')));
    }
  } catch (e) {
    console.error('[持久化] 加载去重文件失败，使用空集合:', e.message);
  }
  return new Set();
}

function saveDedup(set) {
  ensureDataDir();
  fs.writeFileSync(DEDUP_FILE, JSON.stringify([...set]), 'utf8');
}

function loadOutbox() {
  try {
    if (fs.existsSync(OUTBOX_FILE)) {
      return JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[持久化] 加载 outbox 失败:', e.message);
  }
  return [];
}

function saveOutbox(records) {
  ensureDataDir();
  fs.writeFileSync(OUTBOX_FILE, JSON.stringify(records, null, 2), 'utf8');
}

const recordedComments = loadDedup();
let pendingOutbox = loadOutbox();

// 上一次读到的成交人数
let lastTransactionCount = null;

/**
 * 将一批记录写入飞书，成功后才标记去重。失败的留在 outbox 中。
 */
async function flushRecords(records) {
  if (records.length === 0) return;

  const succeeded = [];
  const failed = [];

  // 先尝试批量写入
  try {
    await writeBatchRecords(records);
    succeeded.push(...records);
    console.log(`[主程序] 成功写入 ${records.length} 条记录`);
  } catch (e) {
    console.error('[主程序] 批量写入失败，逐条重试:', e.message);
    for (const record of records) {
      try {
        await writeRecord(record);
        succeeded.push(record);
      } catch (err) {
        console.error(`[主程序] 单条写入失败: ${record.commenterID}`, err.message);
        failed.push(record);
      }
    }
  }

  // 只有成功写入的才加入去重集合
  for (const record of succeeded) {
    const key = `${record.commenterID}_${record.commentTime}_${record.commentContent}`;
    recordedComments.add(key);
  }
  saveDedup(recordedComments);

  // 失败的留在 outbox
  pendingOutbox = [...pendingOutbox.filter((r) => {
    const k = `${r.commenterID}_${r.commentTime}_${r.commentContent}`;
    return !recordedComments.has(k);
  }), ...failed];
  saveOutbox(pendingOutbox);

  if (failed.length > 0) {
    console.log(`[主程序] ${failed.length} 条记录写入失败，已保存到 outbox 待重试`);
  }
}

/**
 * 处理一次成交人数变化事件
 */
async function handleTransactionChange(page) {
  const result = await getRecentComments(page, config.monitor.commentCheckMinutes);

  if (result.error) {
    console.error('[主程序] 采集评论出错，跳过本轮（不推进水位线）:', result.error);
    return false;
  }

  const comments = result.comments;
  if (comments.length === 0) {
    console.log('[主程序] 近期无新评论');
    return true;
  }

  const newRecords = [];

  for (const comment of comments) {
    const key = `${comment.userId}_${comment.time}_${comment.content}`;
    if (recordedComments.has(key)) {
      continue;
    }

    console.log(`[主程序] 处理评论: ${comment.nickname}(${comment.userId}) ${comment.time} - ${comment.content}`);

    const orderInfo = await getOrderInfo(page, comment);

    const record = {
      commenterID: comment.userId,
      commentTime: comment.time,
      commentContent: comment.content,
      orderId: orderInfo?.orderId || '',
      paymentTime: orderInfo?.paymentTime || '',
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
 */
async function monitorLoop(page) {
  const intervalMs = config.monitor.intervalSeconds * 1000;

  console.log(`[主程序] 开始监控，检查间隔: ${config.monitor.intervalSeconds}秒`);
  console.log(`[主程序] 评论检查范围: 最近 ${config.monitor.commentCheckMinutes} 分钟`);
  console.log(`[主程序] 当前北京时间: ${nowBeijing().format('YYYY-MM-DD HH:mm:ss')}`);

  // 启动时重试 outbox 中残留的失败记录
  if (pendingOutbox.length > 0) {
    console.log(`[主程序] 发现 ${pendingOutbox.length} 条未成功写入的记录，重试中...`);
    await flushRecords(pendingOutbox);
  }

  while (true) {
    try {
      const currentCount = await getTransactionCount(page);

      if (currentCount === null) {
        console.log(`[主程序] [${nowBeijing().format('HH:mm:ss')}] 未能获取成交人数，稍后重试...`);
      } else if (lastTransactionCount === null) {
        lastTransactionCount = currentCount;
        console.log(`[主程序] [${nowBeijing().format('HH:mm:ss')}] 初始成交人数: ${currentCount}`);
      } else if (currentCount !== lastTransactionCount) {
        console.log(
          `[主程序] [${nowBeijing().format('HH:mm:ss')}] ` +
          `成交人数变化: ${lastTransactionCount} -> ${currentCount} (+${currentCount - lastTransactionCount})`
        );
        const prevCount = lastTransactionCount;
        const ok = await handleTransactionChange(page);
        // 只有采集成功才推进水位线
        if (ok) {
          lastTransactionCount = currentCount;
        } else {
          lastTransactionCount = prevCount;
          console.log('[主程序] 采集失败，水位线不推进，下次仍会触发');
        }
      } else {
        console.log(`[主程序] [${nowBeijing().format('HH:mm:ss')}] 成交人数无变化: ${currentCount}`);
      }

      // 定期重试 outbox
      if (pendingOutbox.length > 0) {
        console.log(`[主程序] 重试 outbox 中 ${pendingOutbox.length} 条记录...`);
        await flushRecords([...pendingOutbox]);
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
    let entered = false;
    while (!entered) {
      entered = await enterLiveRoom(page);
      if (!entered) {
        console.log('[主程序] 未找到正在直播的场次，30 秒后重新检查...');
        console.log('[主程序] 浏览器保持打开，如需登录请在浏览器中操作');
        await new Promise((r) => setTimeout(r, 30000));
        // 重新加载页面
        try {
          await page.goto(config.taobao.liveListUrl, { waitUntil: 'networkidle', timeout: 60000 });
        } catch (e) {
          console.log('[主程序] 页面加载异常，继续重试:', e.message);
        }
      }
    }

    // 3. 开始监控循环
    await monitorLoop(page);
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
