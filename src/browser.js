/**
 * 浏览器自动化模块
 * 支持三种方式连接/启动 Chrome：
 *   1. cdp     — 连接已开启调试端口的 Chrome
 *   2. profile — 使用本机 Chrome 用户数据目录（继承登录态 cookie）
 *   3. login   — 打开全新浏览器，等待用户手动登录
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const config = require('./config');

dayjs.extend(utc);
dayjs.extend(timezone);

const BEIJING_TZ = 'Asia/Shanghai';

/**
 * 获取北京时间
 */
function nowBeijing() {
  return dayjs().tz(BEIJING_TZ);
}

// ─── 浏览器连接 / 启动 ─────────────────────────────────────────────

/**
 * 猜测本机 Chrome 用户数据目录
 */
function guessChromePath() {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  } else if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  } else {
    return path.join(home, '.config', 'google-chrome');
  }
}

/**
 * 启动浏览器 — 根据 config.browser.mode 选择策略
 * @returns {{ browser: import('playwright').Browser, context: import('playwright').BrowserContext, page: import('playwright').Page }}
 */
async function launchBrowser() {
  const mode = config.browser.mode;
  console.log(`[浏览器] 启动模式: ${mode}`);

  if (mode === 'cdp') {
    return await launchCDP();
  } else if (mode === 'profile') {
    return await launchWithProfile();
  } else if (mode === 'login') {
    return await launchForLogin();
  } else {
    console.log(`[浏览器] 未知模式 "${mode}"，回退到 profile 模式`);
    return await launchWithProfile();
  }
}

/**
 * 模式 1: CDP — 连接已开启调试端口的 Chrome
 */
async function launchCDP() {
  const debugUrl = `http://127.0.0.1:${config.browser.debugPort}`;
  console.log(`[浏览器] 正在通过 CDP 连接 Chrome (${debugUrl}) ...`);

  const browser = await chromium.connectOverCDP(debugUrl);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('CDP 连接成功但没有可用的浏览器上下文');
  }
  const context = contexts[0];
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  console.log('[浏览器] CDP 连接成功');
  return { browser, context, page };
}

/**
 * 模式 2: profile — 使用本机 Chrome 用户数据目录（继承 cookie）
 *
 * Playwright 的 launchPersistentContext 会锁定 userDataDir，
 * 所以如果 Chrome 正在运行则无法直接用原目录。
 * 解决方法：将用户目录里的关键 cookie/storage 文件复制到工具自己的目录下。
 */
async function launchWithProfile() {
  let chromeUserDataDir = config.browser.chromeUserDataDir || guessChromePath();
  const localDataDir = config.browser.localDataDir;

  console.log(`[浏览器] Chrome 用户数据目录: ${chromeUserDataDir}`);
  console.log(`[浏览器] 本工具数据目录: ${localDataDir}`);

  // 确保本工具数据目录存在
  if (!fs.existsSync(localDataDir)) {
    fs.mkdirSync(localDataDir, { recursive: true });
  }

  // 把 Chrome 的 cookie / Local State 复制过来以继承登录态
  copyChromeState(chromeUserDataDir, localDataDir);

  console.log('[浏览器] 使用复制的 Chrome profile 启动（有头模式）...');
  const context = await chromium.launchPersistentContext(localDataDir, {
    headless: false,
    channel: 'chrome', // 使用系统安装的 Chrome（而非 bundled Chromium）
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: null, // 使用系统窗口大小
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  console.log('[浏览器] 启动成功，已继承 Chrome 登录态');
  return { browser: null, context, page };
}

/**
 * 从 Chrome 用户目录复制关键文件到工具目录
 */
function copyChromeState(src, dest) {
  const defaultProfile = path.join(src, 'Default');
  const destDefault = path.join(dest, 'Default');

  if (!fs.existsSync(defaultProfile)) {
    console.log(`[浏览器] 未找到 Chrome Default profile: ${defaultProfile}`);
    return;
  }

  if (!fs.existsSync(destDefault)) {
    fs.mkdirSync(destDefault, { recursive: true });
  }

  // 需要复制的文件（cookie + storage + login state）
  const filesToCopy = [
    'Cookies',
    'Cookies-journal',
    'Login Data',
    'Login Data-journal',
    'Web Data',
    'Web Data-journal',
    'Preferences',
    'Secure Preferences',
  ];

  // 顶层文件
  const topFiles = ['Local State'];

  for (const file of filesToCopy) {
    const srcFile = path.join(defaultProfile, file);
    const destFile = path.join(destDefault, file);
    if (fs.existsSync(srcFile)) {
      try {
        fs.copyFileSync(srcFile, destFile);
      } catch (e) {
        // Chrome 正在使用文件时可能 EPERM，可以忽略
        console.log(`[浏览器] 复制 ${file} 失败（Chrome 可能正在使用）: ${e.message}`);
      }
    }
  }

  for (const file of topFiles) {
    const srcFile = path.join(src, file);
    const destFile = path.join(dest, file);
    if (fs.existsSync(srcFile)) {
      try {
        fs.copyFileSync(srcFile, destFile);
      } catch (e) {
        console.log(`[浏览器] 复制 ${file} 失败: ${e.message}`);
      }
    }
  }

  console.log('[浏览器] Chrome 登录态文件已复制');
}

/**
 * 模式 3: login — 打开全新浏览器，等待用户手动登录
 */
async function launchForLogin() {
  const localDataDir = config.browser.localDataDir;
  const timeoutMs = config.browser.loginTimeoutSeconds * 1000;

  if (!fs.existsSync(localDataDir)) {
    fs.mkdirSync(localDataDir, { recursive: true });
  }

  console.log('[浏览器] 打开浏览器等待手动登录...');
  console.log('[浏览器] 请在弹出的浏览器中完成淘宝登录');
  console.log(`[浏览器] 登录超时: ${config.browser.loginTimeoutSeconds} 秒`);

  const context = await chromium.launchPersistentContext(localDataDir, {
    headless: false,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: null,
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  // 导航到淘宝登录页
  await page.goto('https://login.taobao.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('[浏览器] ⏳ 请在浏览器中完成登录，登录成功后会自动继续...');

  // 等待用户登录 — 检测页面跳转到非登录页或检测到登录 cookie
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const url = page.url();
    // 登录成功后通常会跳转到首页或 redirect 目标
    if (
      !url.includes('login.taobao.com') &&
      !url.includes('login.tmall.com') &&
      !url.includes('about:blank')
    ) {
      console.log('[浏览器] ✅ 检测到登录成功!');
      break;
    }

    // 也可以检查 cookie
    const cookies = await context.cookies('https://taobao.com');
    const hasLoginCookie = cookies.some(
      (c) => c.name === 'login' || c.name === '_tb_token_' || c.name === 'munb'
    );
    if (hasLoginCookie) {
      console.log('[浏览器] ✅ 检测到登录 cookie!');
      break;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  if (Date.now() - startTime >= timeoutMs) {
    console.error('[浏览器] ❌ 登录超时，请重新运行');
    process.exit(1);
  }

  // 登录成功后 cookie 已保存在 localDataDir 中，下次可用 profile 模式跳过登录
  console.log('[浏览器] 登录态已保存，下次可使用 BROWSER_MODE=profile 跳过登录');
  return { browser: null, context, page };
}

// ─── 页面操作 ───────────────────────────────────────────────────────

/**
 * 导航到直播列表并进入正在直播的场次
 */
async function enterLiveRoom(page) {
  console.log('[浏览器] 导航到直播列表页面...');
  await page.goto(config.taobao.liveListUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log('[浏览器] 查找正在直播的场次...');

  const liveStatusSelectors = [
    'text=直播中',
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
    console.log('[浏览器] 未找到正在直播的场次，尝试查找页面入口...');
    const bodyText = await page.textContent('body');
    console.log('[浏览器] 页面文本摘要:', bodyText?.substring(0, 500));
  }

  const detailSelectors = [
    'text=直播详情',
    'a:has-text("直播详情")',
    'button:has-text("直播详情")',
    '[class*="detail"]:has-text("直播详情")',
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
 * 获取成交人数
 */
async function getTransactionCount(page) {
  const selectors = [
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
 * 获取近期评论
 */
async function getRecentComments(page, withinMinutes) {
  const cutoff = nowBeijing().subtract(withinMinutes, 'minute');
  console.log(`[浏览器] 获取 ${cutoff.format('HH:mm:ss')} 之后的评论...`);

  const comments = [];

  try {
    const allTab = await page.$('text=全部');
    if (allTab) {
      await allTab.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    // 忽略
  }

  try {
    const commentElements = await page.$$('[class*="comment"], [class*="message"], [class*="chat"], [class*="interact"]');

    const elements = commentElements.length > 0
      ? commentElements
      : await page.$$('li, [class*="item"]');

    for (const el of elements) {
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
  } catch (e) {
    console.error('[浏览器] 获取评论异常:', e.message);
  }

  console.log(`[浏览器] 获取到 ${comments.length} 条近期评论`);
  return comments;
}

/**
 * 查看订单信息
 */
async function getOrderInfo(page, comment) {
  try {
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

    if (comment.element) {
      try {
        const parent = await comment.element.evaluateHandle((el) =>
          el.closest('[class*="interact"], [class*="chat"], [class*="comment-area"]')
        );
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
 * 从弹窗提取订单信息
 */
async function extractOrderFromPopup(page) {
  try {
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
    if (!dialogText) return null;

    let orderNumber = '';
    const orderMatch = dialogText.match(/订单[号编]?\s*[：:]\s*(\d+)/);
    if (orderMatch) {
      orderNumber = orderMatch[1];
    } else {
      const longNumMatch = dialogText.match(/\b(\d{15,20})\b/);
      if (longNumMatch) {
        orderNumber = longNumMatch[1];
      }
    }

    let paymentTime = '';
    const timeMatch = dialogText.match(
      /(?:支付|付款|下单|创建)[时日]?\s*[间期]?\s*[：:]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)/
    );
    if (timeMatch) {
      paymentTime = timeMatch[1].replace(/\//g, '-');
    }

    const buyerMatch = dialogText.match(/买[家者]?\s*[：:]\s*([^\s,，]+)/);
    const buyerId = buyerMatch ? buyerMatch[1] : '';

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
    try { await page.keyboard.press('Escape'); } catch {}
    return null;
  }
}

module.exports = {
  launchBrowser,
  enterLiveRoom,
  getTransactionCount,
  getRecentComments,
  getOrderInfo,
  nowBeijing,
};
