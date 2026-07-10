/**
 * 淘宝直播数据采集工具 - 主入口
 *
 * 功能流程：
 * 1. 连接本地已登录的 Chrome 浏览器
 * 2. 打开淘宝直播中控台，找到正在直播的场次
 * 3. 持续监控成交人数变化
 * 4. 当成交人数变化时，检查近5分钟评论
 * 5. 对每条评论尝试查看订单信息
 * 6. 将数据写入飞书多维表格
 *
 * 所有时间使用北京时间（东八区）
 */
const config = require('./config');
const {
  connectBrowser,
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
 * @param {import('playwright').Page} page
 */
async function handleTransactionChange(page) {
  const comments = await getRecentComments(page, config.monitor.commentCheckMinutes);

  if (comments.length === 0) {
    console.log('[主程序] 近期无新评论');
    return;
  }

  const newRecords = [];

  for (const comment of comments) {
    // 用 userId + time + content 做去重 key
    const key = `${comment.userId}_${comment.time}_${comment.content}`;
    if (recordedComments.has(key)) {
      continue;
    }

    console.log(`[主程序] 处理评论: ${comment.nickname}(${comment.userId}) ${comment.time} - ${comment.content}`);

    // 尝试获取该评论者的订单信息
    const orderInfo = await getOrderInfo(page, comment);

    const record = {
      commenterID: comment.userId,
      commentTime: comment.time,
      commentContent: comment.content,
      orderNumber: orderInfo?.orderNumber || '',
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
      // 失败后逐条重试
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
        // 首次获取，记录基准值
        lastTransactionCount = currentCount;
        console.log(`[主程序] [${nowBeijing().format('HH:mm:ss')}] 初始成交人数: ${currentCount}`);
      } else if (currentCount !== lastTransactionCount) {
        console.log(
          `[主程序] [${nowBeijing().format('HH:mm:ss')}] ` +
          `成交人数变化: ${lastTransactionCount} -> ${currentCount} (+${currentCount - lastTransactionCount})`
        );
        lastTransactionCount = currentCount;

        // 触发评论检查和订单查看
        await handleTransactionChange(page);
      } else {
        console.log(`[主程序] [${nowBeijing().format('HH:mm:ss')}] 成交人数无变化: ${currentCount}`);
      }
    } catch (e) {
      console.error(`[主程序] 监控循环异常: ${e.message}`);
    }

    // 等待下一次检查
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
  console.log('========================================');

  // 检查配置
  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.error('[错误] 请在 .env 文件中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
    process.exit(1);
  }

  let browser;
  try {
    // 1. 连接浏览器
    browser = await connectBrowser();
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      console.error('[错误] 没有可用的浏览器上下文');
      process.exit(1);
    }

    const context = contexts[0];
    let page;

    // 检查是否已有打开的页面
    const pages = context.pages();
    if (pages.length > 0) {
      page = pages[0];
    } else {
      page = await context.newPage();
    }

    // 2. 进入直播间
    const entered = await enterLiveRoom(page);
    if (!entered) {
      console.error('[错误] 未能进入直播中控台，请确保：');
      console.error('  1. Chrome 以 --remote-debugging-port=9222 启动');
      console.error('  2. 已登录淘宝直播中控台');
      console.error('  3. 有正在直播的场次');
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
