/**
 * 浏览器自动化模块
 * 使用 Playwright 连接本地已登录的 Chrome 进行淘宝直播数据采集
 */
const { chromium } = require('playwright');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const config = require('./config');

dayjs.extend(utc);
dayjs.extend(timezone);

// 北京时区
const BEIJING_TZ = 'Asia/Shanghai';

/**
 * 获取北京时间的当前时间
 */
function nowBeijing() {
  return dayjs().tz(BEIJING_TZ);
}

/**
 * 连接到本地已登录的 Chrome 浏览器
 * 需要以 --remote-debugging-port=9222 启动 Chrome
 */
async function connectBrowser() {
  const debugUrl = `http://127.0.0.1:${config.chrome.debugPort}`;
  console.log(`[浏览器] 正在连接 Chrome (${debugUrl}) ...`);

  const browser = await chromium.connectOverCDP(debugUrl);
  console.log('[浏览器] 连接成功');
  return browser;
}

/**
 * 导航到直播列表页面并找到正在直播的场次
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} 是否成功进入中控台
 */
async function enterLiveRoom(page) {
  console.log('[浏览器] 导航到直播列表页面...');
  await page.goto(config.taobao.liveListUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 在直播计划列表中查找状态为"直播中"的场次
  console.log('[浏览器] 查找正在直播的场次...');

  // 尝试多种选择器定位"直播中"状态的场次
  const liveStatusSelectors = [
    // 包含"直播中"文字的元素
    'text=直播中',
    // 常见的状态标签
    '.live-status:has-text("直播中")',
    '[class*="status"]:has-text("直播中")',
    '[class*="live"]:has-text("直播中")',
  ];

  let foundLive = false;
  for (const selector of liveStatusSelectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        foundLive = true;
        console.log('[浏览器] 找到正在直播的场次');
        break;
      }
    } catch {
      continue;
    }
  }

  if (!foundLive) {
    console.log('[浏览器] 未找到正在直播的场次，尝试查找页面上所有可能的入口...');
    // 打印页面内容帮助调试
    const bodyText = await page.textContent('body');
    console.log('[浏览器] 页面文本摘要:', bodyText?.substring(0, 500));
  }

  // 查找并点击"直播详情"按钮
  const detailSelectors = [
    'text=直播详情',
    'a:has-text("直播详情")',
    'button:has-text("直播详情")',
    '[class*="detail"]:has-text("直播详情")',
    // 直播中场次所在行的操作按钮
    'tr:has-text("直播中") a:has-text("详情")',
    'tr:has-text("直播中") button:has-text("详情")',
    '.list-item:has-text("直播中") a',
    '[class*="action"]:has-text("详情")',
  ];

  for (const selector of detailSelectors) {
    try {
      const btn = await page.$(selector);
      if (btn) {
        console.log('[浏览器] 找到"直播详情"入口，点击进入...');
        await btn.click();
        await page.waitForTimeout(5000);
        console.log('[浏览器] 已进入中控台页面');
        return true;
      }
    } catch {
      continue;
    }
  }

  // 如果上面的方式都失败，尝试获取页面中所有链接
  console.log('[浏览器] 标准选择器未命中，扫描页面链接...');
  const links = await page.$$eval('a', (anchors) =>
    anchors.map((a) => ({ href: a.href, text: a.textContent?.trim() }))
  );

  for (const link of links) {
    if (
      link.text &&
      (link.text.includes('详情') || link.text.includes('进入') || link.text.includes('中控台'))
    ) {
      console.log(`[浏览器] 找到链接: "${link.text}" -> ${link.href}`);
      await page.goto(link.href, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      return true;
    }
  }

  console.error('[浏览器] 未能找到直播详情入口');
  return false;
}

/**
 * 获取中控台"实时表现"区域的成交人数
 * @param {import('playwright').Page} page
 * @returns {Promise<number|null>} 成交人数
 */
async function getTransactionCount(page) {
  const selectors = [
    // 尝试多种可能的选择器
    '[class*="transaction"] [class*="num"]',
    '[class*="deal"] [class*="num"]',
    '[class*="trade"] [class*="count"]',
    '[class*="real-time"] [class*="value"]',
  ];

  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        const text = await el.textContent();
        const num = parseInt(text?.replace(/[^0-9]/g, '') || '0', 10);
        return num;
      }
    } catch {
      continue;
    }
  }

  // 通用方式：查找包含"成交人数"的文本附近的数字
  try {
    const allText = await page.$$eval('*', (els) =>
      els.map((el) => ({
        tag: el.tagName,
        text: el.textContent?.trim()?.substring(0, 200),
        className: el.className,
      }))
    );

    for (const item of allText) {
      if (item.text && item.text.includes('成交人数')) {
        // 提取相邻的数字
        const match = item.text.match(/成交人数[^\d]*(\d+)/);
        if (match) {
          return parseInt(match[1], 10);
        }
      }
    }
  } catch (e) {
    console.error('[浏览器] 获取成交人数异常:', e.message);
  }

  return null;
}

/**
 * 获取直播互动区域的评论列表
 * @param {import('playwright').Page} page
 * @param {number} withinMinutes - 检查最近N分钟的评论
 * @returns {Promise<Array<{nickname: string, userId: string, time: string, content: string}>>}
 */
async function getRecentComments(page, withinMinutes) {
  const cutoff = nowBeijing().subtract(withinMinutes, 'minute');
  console.log(`[浏览器] 获取 ${cutoff.format('HH:mm:ss')} 之后的评论...`);

  const comments = [];

  // 先尝试切换到"全部"评论 tab
  try {
    const allTab = await page.$('text=全部');
    if (allTab) {
      await allTab.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    // 忽略
  }

  // 尝试获取评论列表
  // 淘宝直播评论格式: 用户昵称(ID) 时间 + 评论内容
  try {
    const commentElements = await page.$$('[class*="comment"], [class*="message"], [class*="chat"], [class*="interact"]');

    if (commentElements.length === 0) {
      // 更宽泛的选择
      const listItems = await page.$$('li, [class*="item"]');
      for (const item of listItems) {
        const text = await item.textContent();
        if (!text) continue;

        // 匹配评论格式: 昵称(ID) HH:mm:ss 评论内容
        // 或: 昵称 HH:mm 评论内容
        const commentMatch = text.match(
          /([^\s(]+)(?:\(([^)]+)\))?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)/
        );

        if (commentMatch) {
          const [, nickname, userId, timeStr, content] = commentMatch;

          // 解析时间，假设是当天北京时间
          const today = nowBeijing().format('YYYY-MM-DD');
          const fullTimeStr = `${today} ${timeStr}`;
          const commentTime = dayjs.tz(fullTimeStr, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

          if (commentTime.isAfter(cutoff)) {
            comments.push({
              nickname: nickname?.trim() || '',
              userId: userId?.trim() || nickname?.trim() || '',
              time: commentTime.format('YYYY-MM-DD HH:mm:ss'),
              content: content?.trim() || '',
              element: item,
            });
          }
        }
      }
    } else {
      for (const el of commentElements) {
        const text = await el.textContent();
        if (!text) continue;

        const commentMatch = text.match(
          /([^\s(]+)(?:\(([^)]+)\))?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)/
        );

        if (commentMatch) {
          const [, nickname, userId, timeStr, content] = commentMatch;
          const today = nowBeijing().format('YYYY-MM-DD');
          const fullTimeStr = `${today} ${timeStr}`;
          const commentTime = dayjs.tz(fullTimeStr, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

          if (commentTime.isAfter(cutoff)) {
            comments.push({
              nickname: nickname?.trim() || '',
              userId: userId?.trim() || nickname?.trim() || '',
              time: commentTime.format('YYYY-MM-DD HH:mm:ss'),
              content: content?.trim() || '',
              element: el,
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('[浏览器] 获取评论异常:', e.message);
  }

  console.log(`[浏览器] 获取到 ${comments.length} 条近期评论`);
  return comments;
}

/**
 * 点击评论区底部的"查看订单"图标，获取订单信息
 * @param {import('playwright').Page} page
 * @param {Object} comment - 评论对象 (需要含 element 属性来定位)
 * @returns {Promise<{orderNumber: string, paymentTime: string}|null>}
 */
async function getOrderInfo(page, comment) {
  try {
    // 定位评论区底部的操作图标区域
    // "查看订单"按钮通常是一个剪贴板样式的图标
    const orderIconSelectors = [
      '[class*="order"] svg',
      '[class*="order"] i',
      '[class*="order"] img',
      '[class*="clipboard"]',
      '[title*="订单"]',
      '[aria-label*="订单"]',
      'button:has-text("订单")',
      '[class*="icon"]:near(:text("订单"))',
    ];

    // 先尝试在评论元素附近找订单图标
    if (comment.element) {
      try {
        // 评论区底部图标
        const parent = await comment.element.evaluateHandle((el) => el.closest('[class*="interact"], [class*="chat"], [class*="comment-area"]'));
        if (parent) {
          for (const sel of orderIconSelectors) {
            const icon = await parent.$(sel);
            if (icon) {
              await icon.click();
              await page.waitForTimeout(2000);
              return await extractOrderFromPopup(page);
            }
          }
        }
      } catch {
        // 忽略
      }
    }

    // 全局搜索"查看订单"入口
    for (const sel of orderIconSelectors) {
      try {
        const icon = await page.$(sel);
        if (icon) {
          await icon.click();
          await page.waitForTimeout(2000);
          return await extractOrderFromPopup(page);
        }
      } catch {
        continue;
      }
    }

    // 尝试查找底部图标栏
    try {
      const bottomIcons = await page.$$('[class*="toolbar"] svg, [class*="toolbar"] i, [class*="bottom"] svg, [class*="bottom"] i');
      for (const icon of bottomIcons) {
        const title = await icon.getAttribute('title');
        const ariaLabel = await icon.getAttribute('aria-label');
        if (
          (title && title.includes('订单')) ||
          (ariaLabel && ariaLabel.includes('订单'))
        ) {
          await icon.click();
          await page.waitForTimeout(2000);
          return await extractOrderFromPopup(page);
        }
      }
    } catch {
      // 忽略
    }
  } catch (e) {
    console.error('[浏览器] 查看订单异常:', e.message);
  }

  return null;
}

/**
 * 从弹出的订单窗口中提取订单信息
 * @param {import('playwright').Page} page
 * @returns {Promise<{orderNumber: string, paymentTime: string}|null>}
 */
async function extractOrderFromPopup(page) {
  try {
    // 等待弹窗出现
    const dialogSelectors = [
      '[class*="modal"]',
      '[class*="dialog"]',
      '[class*="popup"]',
      '[class*="drawer"]',
      '[role="dialog"]',
    ];

    let dialog = null;
    for (const sel of dialogSelectors) {
      dialog = await page.$(sel);
      if (dialog) break;
    }

    if (!dialog) {
      console.log('[浏览器] 未找到订单弹窗');
      return null;
    }

    const dialogText = await dialog.textContent();
    if (!dialogText) {
      return null;
    }

    // 提取订单编号
    let orderNumber = '';
    const orderMatch = dialogText.match(/订单[号编]?\s*[：:]\s*(\d+)/);
    if (orderMatch) {
      orderNumber = orderMatch[1];
    } else {
      // 尝试匹配长数字串（淘宝订单号通常是18-20位数字）
      const longNumMatch = dialogText.match(/\b(\d{15,20})\b/);
      if (longNumMatch) {
        orderNumber = longNumMatch[1];
      }
    }

    // 提取支付时间
    let paymentTime = '';
    const timeMatch = dialogText.match(
      /(?:支付|付款|下单|创建)[时日]?\s*[间期]?\s*[：:]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)/
    );
    if (timeMatch) {
      paymentTime = timeMatch[1].replace(/\//g, '-');
    }

    // 提取购买者信息
    let buyerMatch = dialogText.match(/买[家者]?\s*[：:]\s*([^\s,，]+)/);
    const buyerId = buyerMatch ? buyerMatch[1] : '';

    // 关闭弹窗
    try {
      const closeBtn = await dialog.$('[class*="close"], button:has-text("关闭"), button:has-text("×")');
      if (closeBtn) {
        await closeBtn.click();
        await page.waitForTimeout(500);
      } else {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      }
    } catch {
      await page.keyboard.press('Escape');
    }

    if (!orderNumber && !paymentTime) {
      console.log('[浏览器] 订单弹窗中未找到有效数据');
      return null;
    }

    console.log(`[浏览器] 提取到订单: ${orderNumber}, 支付时间: ${paymentTime}`);
    return { orderNumber, paymentTime, buyerId };
  } catch (e) {
    console.error('[浏览器] 提取订单信息异常:', e.message);
    // 确保关闭弹窗
    try {
      await page.keyboard.press('Escape');
    } catch {}
    return null;
  }
}

module.exports = {
  connectBrowser,
  enterLiveRoom,
  getTransactionCount,
  getRecentComments,
  getOrderInfo,
  nowBeijing,
};
