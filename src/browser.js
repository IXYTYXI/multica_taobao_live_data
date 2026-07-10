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

// ─── 工具函数 ─────────────────────────────────────────────────────

/**
 * 判断当前页面是否实际处于登录页
 * 同时检查 URL 和页面内容，防止 URL 短暂显示目标域名时误判
 */
async function isStillLoginPage(page) {
  try {
    const url = page.url();
    // URL 明确在登录域名
    if (url.includes('login.taobao.com') || url.includes('login.tmall.com')) {
      return true;
    }
    // URL 在 liveplatform 但页面可能还没加载完，检查内容
    const result = await page.evaluate(() => {
      const title = document.title || '';
      const bodyText = document.body ? document.body.innerText.substring(0, 3000) : '';
      // 登录页特征
      const hasLoginForm = !!document.querySelector('#fm-login-id, #fm-login-password, [class*="login-form"], [class*="login-box"], #login-form');
      const hasLoginTitle = title.includes('登录') || title.includes('login') || title.includes('Login');
      const hasLoginCSS = !!document.querySelector('.login-msg, [class*="havana"], [class*="login-panel"]');
      const hasLiveContent = bodyText.includes('直播') && !bodyText.includes('登录-淘宝');
      return { hasLoginForm, hasLoginTitle, hasLoginCSS, hasLiveContent, title };
    });
    // 如果有登录表单/标题/CSS，且没有直播内容 → 仍是登录页
    if (result.hasLoginForm || result.hasLoginTitle || result.hasLoginCSS) {
      if (!result.hasLiveContent) {
        return true;
      }
    }
    return false;
  } catch {
    // 页面正在导航中，视为登录页
    return true;
  }
}

/**
 * 等待用户完成登录，使用内容检测而非纯 URL 检测
 * 不设超时上限 — 浏览器保持打开，直到用户登录成功
 * @returns {boolean} 始终返回 true（无限等待直到登录成功）
 */
async function waitForLogin(page) {
  let waitMinutes = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    waitMinutes += 0.05; // ~3s

    // 每分钟打印一次提示
    if (Math.floor(waitMinutes) > Math.floor(waitMinutes - 0.05) && Math.floor(waitMinutes) > 0) {
      console.log(`[浏览器] ⏳ 已等待 ${Math.floor(waitMinutes)} 分钟，浏览器保持打开中，请完成登录...`);
    }

    const stillLogin = await isStillLoginPage(page);
    if (!stillLogin) {
      // 不再是登录页 → 再确认一次（防止页面正在重定向中的瞬间误判）
      console.log('[浏览器] 检测到登录完成，等待页面稳定...');
      await page.waitForTimeout(5000);
      const doubleCheck = await isStillLoginPage(page);
      if (!doubleCheck) {
        console.log('[浏览器] ✅ 登录成功！');
        return true;
      }
      console.log('[浏览器] 页面又回到登录状态，继续等待...');
    }
  }
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
 * 注意：Chrome 运行时会以 EXCLUSIVE 模式锁定 cookies 文件，
 * 所有 Windows API（包括 .NET FileShare.ReadWrite、robocopy）均无法读取。
 * 因此 profile 模式要求先关闭 Chrome 再运行本工具。
 * 如果不想关闭 Chrome，请使用 login 模式（BROWSER_MODE=login）。
 */
async function launchWithProfile() {
  let chromeUserDataDir = config.browser.chromeUserDataDir || guessChromePath();
  const localDataDir = config.browser.localDataDir;

  console.log(`[浏览器] Chrome 用户数据目录: ${chromeUserDataDir}`);
  console.log(`[浏览器] 本工具数据目录: ${localDataDir}`);

  // 检查 Chrome 是否正在运行
  const { execSync } = require('child_process');
  let chromeRunning = false;
  if (os.platform() === 'win32') {
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
      chromeRunning = out.includes('chrome.exe');
    } catch {}
  } else {
    try {
      execSync('pgrep -x chrome', { stdio: 'ignore' });
      chromeRunning = true;
    } catch {}
  }

  if (chromeRunning) {
    console.log('[浏览器] ⚠ 检测到 Chrome 正在运行！');
    console.log('[浏览器] Chrome 会以独占模式锁定 cookie 文件，profile 模式无法复制。');
    console.log('[浏览器] 自动切换到 login 模式...');
    console.log('');
    return await launchForLogin();
  }

  // Chrome 未运行，安全复制 cookie
  if (!fs.existsSync(localDataDir)) {
    fs.mkdirSync(localDataDir, { recursive: true });
  }

  copyChromeState(chromeUserDataDir, localDataDir);

  console.log('[浏览器] 使用复制的 Chrome profile 启动（有头模式）...');
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

  console.log('[浏览器] 启动成功，已继承 Chrome 登录态');
  return { browser: null, context, page };
}

/**
 * 从 Chrome 用户目录复制关键文件到工具目录
 * 使用 robocopy（Windows）兜底处理被锁定的文件
 */
function copyChromeState(src, dest) {
  const { execSync } = require('child_process');
  const defaultProfile = path.join(src, 'Default');
  const destDefault = path.join(dest, 'Default');

  if (!fs.existsSync(defaultProfile)) {
    console.log(`[浏览器] 未找到 Chrome Default profile: ${defaultProfile}`);
    return;
  }

  if (!fs.existsSync(destDefault)) {
    fs.mkdirSync(destDefault, { recursive: true });
  }

  // 复制单个文件，先尝试 fs.copyFileSync，失败则用 robocopy（Windows）
  function safeCopy(srcFile, destFile, label) {
    if (!fs.existsSync(srcFile)) return false;
    try {
      fs.copyFileSync(srcFile, destFile);
      console.log(`[浏览器] 复制 ${label} 成功`);
      return true;
    } catch (e) {
      // 文件被锁定，在 Windows 上尝试 robocopy（可复制被占用的文件）
      if (os.platform() === 'win32') {
        try {
          const srcDir = path.dirname(srcFile);
          const destDir = path.dirname(destFile);
          const fileName = path.basename(srcFile);
          execSync(`robocopy "${srcDir}" "${destDir}" "${fileName}" /R:1 /W:0 /NP /NFL /NDL /NJH /NJS`, {
            stdio: 'ignore',
            timeout: 5000,
          });
          if (fs.existsSync(destFile)) {
            console.log(`[浏览器] 复制 ${label} 成功（通过 robocopy）`);
            return true;
          }
        } catch {
          // robocopy 返回非 0 退出码是正常的（1=文件已复制, 0=无变化）
          if (fs.existsSync(destFile)) {
            console.log(`[浏览器] 复制 ${label} 成功（通过 robocopy）`);
            return true;
          }
        }
      }
      console.log(`[浏览器] 复制 ${label} 失败（Chrome 可能正在使用）: ${e.message}`);
      return false;
    }
  }

  // Default 目录下的文件
  const defaultFiles = [
    'Cookies', 'Cookies-journal',
    'Login Data', 'Login Data-journal',
    'Web Data', 'Web Data-journal',
    'Preferences', 'Secure Preferences',
  ];

  for (const file of defaultFiles) {
    safeCopy(
      path.join(defaultProfile, file),
      path.join(destDefault, file),
      `Default/${file}`
    );
  }

  // Network 子目录下的 cookie 文件（Chrome 新版路径）
  const srcNetwork = path.join(defaultProfile, 'Network');
  const destNetwork = path.join(destDefault, 'Network');
  if (fs.existsSync(srcNetwork)) {
    if (!fs.existsSync(destNetwork)) {
      fs.mkdirSync(destNetwork, { recursive: true });
    }
    safeCopy(
      path.join(srcNetwork, 'Cookies'),
      path.join(destNetwork, 'Cookies'),
      'Network/Cookies'
    );
    safeCopy(
      path.join(srcNetwork, 'Cookies-journal'),
      path.join(destNetwork, 'Cookies-journal'),
      'Network/Cookies-journal'
    );
  }

  // 顶层 Local State
  safeCopy(
    path.join(src, 'Local State'),
    path.join(dest, 'Local State'),
    'Local State'
  );

  console.log('[浏览器] Chrome 登录态文件复制完成');
}

/**
 * 模式 3: login — 打开浏览器，直接导航到目标页面
 * 如果被重定向到登录页，等待用户登录后自动回到目标页面
 */
async function launchForLogin() {
  const localDataDir = config.browser.localDataDir;

  if (!fs.existsSync(localDataDir)) {
    fs.mkdirSync(localDataDir, { recursive: true });
  }

  console.log('[浏览器] 打开浏览器...');

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

  // 直接导航到直播列表（如果未登录会自动跳转到登录页，
  // 登录成功后 redirect 会把用户带回直播列表）
  console.log('[浏览器] 导航到淘宝直播中控台...');
  await page.goto(config.taobao.liveListUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 等待页面加载完成后检查是否需要登录（内容检测）
  await page.waitForTimeout(5000);
  const needLogin = await isStillLoginPage(page);

  if (needLogin) {
    console.log('[浏览器] ⏳ 需要登录，请在浏览器中完成登录...');
    console.log('[浏览器] 浏览器会保持打开，不会自动关闭，登录成功后自动继续');

    await waitForLogin(page);

    // 确保最终停留在直播列表页
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    if (!finalUrl.includes('liveplatform.taobao.com')) {
      console.log('[浏览器] 当前页面:', finalUrl);
      console.log('[浏览器] 重新导航到直播列表...');
      await page.goto(config.taobao.liveListUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(5000);
    }
  } else {
    console.log('[浏览器] ✅ 已有登录态，直接进入直播列表');
  }

  console.log('[浏览器] 登录态已保存');
  return { browser: null, context, page };
}

// ─── 页面操作 ───────────────────────────────────────────────────────

/**
 * 导航到直播列表并进入正在直播的场次
 */
async function enterLiveRoom(page) {
  // 检查当前页面是否已经是直播列表
  const currentUrl = page.url();
  if (!currentUrl.includes('liveplatform.taobao.com')) {
    console.log('[浏览器] 导航到直播列表页面...');
    await page.goto(config.taobao.liveListUrl, { waitUntil: 'networkidle', timeout: 60000 });
  } else {
    console.log('[浏览器] 已在直播列表页面，等待加载...');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(5000); // 等待页面完全渲染

  // 如果被重定向到登录页，等待用户登录（内容检测，无限等待）
  if (await isStillLoginPage(page)) {
    console.log('[浏览器] ⏳ 页面需要登录，请在浏览器中完成登录...');
    console.log('[浏览器] 浏览器会保持打开，不会自动关闭');
    await waitForLogin(page);

    // 确保在直播列表页
    if (!page.url().includes('liveplatform.taobao.com')) {
      console.log('[浏览器] 重新导航到直播列表...');
      await page.goto(config.taobao.liveListUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(5000);
    }
  }

  console.log('[浏览器] 当前页面:', page.url());
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
        const now = nowBeijing();
        const today = now.format('YYYY-MM-DD');
        const fullTimeStr = `${today} ${timeStr}`;
        let commentTime = dayjs.tz(fullTimeStr, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

        // 跨午夜修正：如果解析出的评论时间超过当前时间 1 小时以上，
        // 说明评论实际是前一天的（如 00:02 时解析到 23:58 → 拼成今天 23:58 是错的）
        if (commentTime.diff(now, 'hour') >= 1) {
          commentTime = commentTime.subtract(1, 'day');
        }

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

    let orderId = '';
    const orderMatch = dialogText.match(/订单(?:编号|号|[Ii][Dd])?\s*[：:]\s*(\d+)/);
    if (orderMatch) {
      orderId = orderMatch[1];
    } else {
      const longNumMatch = dialogText.match(/\b(\d{15,20})\b/);
      if (longNumMatch) {
        orderId = longNumMatch[1];
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

    if (!orderId && !paymentTime) {
      console.log('[浏览器] 订单弹窗中未找到有效数据');
      return null;
    }

    console.log(`[浏览器] 提取到订单ID: ${orderId}, 支付时间: ${paymentTime}`);
    return { orderId, paymentTime, buyerId };
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
