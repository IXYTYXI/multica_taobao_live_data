/**
 * 淘宝直播数据采集工具 - 主入口
 *
 * 支持三种浏览器模式（通过 BROWSER_MODE 环境变量设置）：
 *   profile — 复制本机 Chrome 登录态，无需重新登录（默认）
 *   login   — 打开浏览器让用户手动登录
 *   cdp     — 连接已开启调试端口的 Chrome
 *
 * 所有时间使用北京时间（东八区）
 */
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

// 已记录的评论ID集合，避免重复写入
const recordedComments = new Set();

// 上一次读到的成交人数
let lastTransactionCount = null;

/**
 * 处理一次成交人数变化事件
 */
async function handleTransactionChange(page) {
  const comments = await getRecentComments(page, config.monitor.commentCheckMinutes);

  if (comments.length === 0) {
    console.log('[主程序] 近期无新评论');
    return;
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
    recordedComments.add(key);
  }

  if (newRecords.length > 0) {
    console.log(`[主程序] 准备写入 ${newRecords.length} 条新记录到飞书...`);
    try {
      await writeBatchRecords(newRecords);
      console.log(`[主程序] 成功写入 ${newRecords.length} 条记录`);
    } catch (e) {
      console.error(`[主程序] 写入飞书失败:`, e.message);
      for (const record of newRecords) {
        try {
          await writeRecord(record);
        } catch (err) {
          console.error(`[主程序] 单条写入也失败: ${record.commenterID}`, err.message);
        }
      }
    }
  }
}

/**
 * 主监控循环
 */
async function monitorLoop(page) {
  const intervalMs = config.monitor.intervalSeconds * 1000;

  console.log(`[主程序] 开始监控，检查间隔: ${config.monitor.intervalSeconds}秒`);
  console.log(`[主程序] 评论检查范围: 最近 ${config.monitor.commentCheckMinutes} 分钟`);
  console.log(`[主程序] 当前北京时间: ${nowBeijing().format('YYYY-MM-DD HH:mm:ss')}`);

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
        lastTransactionCount = currentCount;
        await handleTransactionChange(page);
      } else {
        console.log(`[主程序] [${nowBeijing().format('HH:mm:ss')}] 成交人数无变化: ${currentCount}`);
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

    // 2. 进入直播间
    const entered = await enterLiveRoom(page);
    if (!entered) {
      console.error('[错误] 未能进入直播中控台，请确保：');
      console.error('  1. 已登录淘宝直播中控台');
      console.error('  2. 有正在直播的场次');
      if (config.browser.mode === 'cdp') {
        console.error('  3. Chrome 以 --remote-debugging-port=9222 启动');
      }
      process.exit(1);
    }

    // 3. 开始监控循环
    await monitorLoop(page);
  } catch (e) {
    console.error('[致命错误]', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n[主程序] 收到中断信号，正在退出...');
  console.log(`[主程序] 本次运行共记录 ${recordedComments.size} 条评论`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[主程序] 收到终止信号，正在退出...');
  process.exit(0);
});

main();
