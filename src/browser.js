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
 * 获取成交人数（所有商品的成交人数之和）
 *
 * 淘宝直播中控台的"口袋商品"列表中，每个商品卡片都有一列"成交人数"，
 * 数字在上、标签在下。本函数遍历所有"成交人数"标签，提取对应数字后求和。
 */
async function getTransactionCount(page) {
  try {
    const result = await page.evaluate(() => {
      let sum = 0;
      let found = false;

      // 用 TreeWalker 精准定位"成交人数"文本节点
      const walker = document.createTreeWalker(
        document.body, NodeFilter.SHOW_TEXT, null
      );
      const labelNodes = [];
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.trim() === '成交人数') {
          labelNodes.push(walker.currentNode.parentElement);
        }
      }

      for (const labelEl of labelNodes) {
        if (!labelEl) continue;
        const container = labelEl.parentElement;
        if (!container) continue;

        // 方法1: 在父容器内查找前面的兄弟元素中的数字
        let prev = labelEl.previousElementSibling;
        if (prev) {
          const numText = prev.textContent.trim().replace(/[,，\s]/g, '');
          const num = parseInt(numText, 10);
          if (!isNaN(num)) {
            sum += num;
            found = true;
            continue;
          }
        }

        // 方法2: 父容器的文本中提取 "数字\n成交人数" 模式
        const containerText = container.textContent.trim();
        const match = containerText.match(/(\d+)\s*[人]?\s*[\n\r\s]*成交人数/);
        if (match) {
          sum += parseInt(match[1], 10);
          found = true;
          continue;
        }

        // 方法3: 向上再找一层祖先容器
        const grandParent = container.parentElement;
        if (grandParent) {
          const gpText = grandParent.textContent.trim();
          const gpMatch = gpText.match(/(\d+)\s*[人]?\s*[\n\r\s]*成交人数/);
          if (gpMatch) {
            sum += parseInt(gpMatch[1], 10);
            found = true;
          }
        }
      }

      return { sum, found, labelCount: labelNodes.length };
    });

    if (result.found) {
      return result.sum;
    }

    if (result.labelCount === 0) {
      console.log('[浏览器] 未找到"成交人数"标签，可能需要滚动到商品列表区域');
    }
  } catch (e) {
    console.error('[浏览器] 获取成交人数异常:', e.message);
  }

  return null;
}

/**
 * 在评论区（左侧面板）中点击指定标签
 * 用页面位置判断避免误点右侧商品区的同名元素（如"全部商品"）
 */
async function clickCommentTab(page, tabText) {
  try {
    const clicked = await page.evaluate((text) => {
      for (const el of document.querySelectorAll('div, span, a, button, li, label')) {
        if (el.children.length > 5) continue;
        const ownText = el.textContent?.trim();
        if (ownText !== text) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.left > window.innerWidth * 0.5) continue;
        if (rect.width > 200 || rect.height > 60) continue;

        el.click();
        return true;
      }
      return false;
    }, tabText);

    if (clicked) {
      await page.waitForTimeout(1000);
    } else {
      console.log(`[浏览器] 未找到评论区"${tabText}"标签`);
    }
  } catch (e) {
    console.log(`[浏览器] 点击"${tabText}"标签失败:`, e.message);
  }
}

/**
 * 解析时间字符串，自动处理 HH:mm 和 HH:mm:ss 两种格式
 */
function parseCommentTime(timeStr) {
  const now = nowBeijing();
  const today = now.format('YYYY-MM-DD');
  const hasSeconds = timeStr.split(':').length === 3;
  const fmt = hasSeconds ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm';
  let t = dayjs.tz(`${today} ${timeStr}`, fmt, BEIJING_TZ);
  if (!t.isValid()) {
    t = dayjs.tz(`${today} ${timeStr}:00`, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
  }
  if (t.diff(now, 'hour') >= 1) {
    t = t.subtract(1, 'day');
  }
  return t;
}

/**
 * 获取近期评论
 *
 * 不依赖特定 CSS class 名（淘宝使用 hash/混淆类名），
 * 而是通过文本模式匹配 + 页面位置（左侧面板）来识别评论元素。
 * 分两阶段：先在浏览器内标记匹配元素，再获取 element handle。
 */
async function getRecentComments(page, withinMinutes) {
  const cutoff = nowBeijing().subtract(withinMinutes, 'minute');
  console.log(`[浏览器] 获取 ${cutoff.format('HH:mm:ss')} 之后的评论...`);

  await clickCommentTab(page, '全部');

  const comments = [];

  try {
    // Phase 1: 在浏览器内扫描 DOM，标记匹配评论模式的元素
    const diagnostics = await page.evaluate(() => {
      // 清除旧标记
      document.querySelectorAll('[data-tb-idx]').forEach(el => {
        el.removeAttribute('data-tb-idx');
        el.removeAttribute('data-tb-nickname');
        el.removeAttribute('data-tb-userid');
        el.removeAttribute('data-tb-time');
        el.removeAttribute('data-tb-content');
      });

      // 评论模式: 昵称[(用户ID)] [空白] HH:MM[:SS] [换行/空白] 内容
      const regex = /([^\s\n(]{1,30})(?:\(([^)]+)\))?\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*([\s\S]+)/;
      let idx = 0;
      const seen = new Set();
      const diag = { total: 0, leftPanel: 0, sizeOk: 0, matched: 0, tagged: 0 };

      for (const el of document.querySelectorAll('div, li, p, article, section, span')) {
        diag.total++;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // 评论区在页面左侧
        if (rect.left > window.innerWidth * 0.5) continue;
        diag.leftPanel++;

        if (rect.height > 200 || rect.height < 8) continue;
        diag.sizeOk++;

        const text = el.textContent?.trim();
        if (!text || text.length < 3 || text.length > 500) continue;
        // 跳过包含大量子元素的容器
        if (el.querySelectorAll('div, li, p, span').length > 20) continue;

        const match = text.match(regex);
        if (!match) continue;
        diag.matched++;

        const [, nickname, userId, timeStr, rawContent] = match;
        const hour = parseInt(timeStr.split(':')[0], 10);
        if (hour > 23) continue;

        const content = rawContent.trim().split(/[\n\r]+/)[0]?.trim() || '';
        if (!content) continue;

        // 跳过 AI/系统消息
        if (text.includes('AI助理') || text.includes('问答助手')) continue;
        if (content.startsWith('私密回复')) continue;

        const key = `${nickname}_${userId || ''}_${timeStr}_${content}`;
        if (seen.has(key)) continue;
        seen.add(key);

        el.setAttribute('data-tb-idx', String(idx));
        el.setAttribute('data-tb-nickname', nickname.trim());
        el.setAttribute('data-tb-userid', (userId || nickname).trim());
        el.setAttribute('data-tb-time', timeStr);
        el.setAttribute('data-tb-content', content);
        idx++;
        diag.tagged++;
      }

      return diag;
    });

    console.log(
      `[浏览器] 评论扫描: 总${diagnostics.total} → 左侧${diagnostics.leftPanel} → 尺寸${diagnostics.sizeOk} → 模式匹配${diagnostics.matched} → 标记${diagnostics.tagged}`
    );

    // Phase 2: 获取标记元素的 handles
    const taggedElements = await page.$$('[data-tb-idx]');

    for (const el of taggedElements) {
      try {
        const nickname = await el.getAttribute('data-tb-nickname');
        const userId = await el.getAttribute('data-tb-userid');
        const timeStr = await el.getAttribute('data-tb-time');
        const content = await el.getAttribute('data-tb-content');

        const commentTime = parseCommentTime(timeStr);
        if (!commentTime.isValid() || !commentTime.isAfter(cutoff)) continue;

        comments.push({
          nickname,
          userId,
          time: commentTime.format('YYYY-MM-DD HH:mm:ss'),
          content,
          element: el,
        });
      } catch {}
    }

    // Phase 3: 清除标记
    await page.evaluate(() => {
      document.querySelectorAll('[data-tb-idx]').forEach(el => {
        el.removeAttribute('data-tb-idx');
        el.removeAttribute('data-tb-nickname');
        el.removeAttribute('data-tb-userid');
        el.removeAttribute('data-tb-time');
        el.removeAttribute('data-tb-content');
      });
    });
  } catch (e) {
    console.error('[浏览器] 获取评论异常:', e.message);
    return { comments: [], error: e.message };
  }

  console.log(`[浏览器] 获取到 ${comments.length} 条近期评论`);
  return { comments, error: null };
}

/**
 * 切换到"已下单"标签页获取下单记录，然后切回"全部"
 * 使用同样的 DOM 扫描方式，不依赖 CSS class 名
 */
async function getOrdersFromTab(page, withinMinutes) {
  const cutoff = nowBeijing().subtract(withinMinutes, 'minute');
  const orders = [];

  try {
    await clickCommentTab(page, '已下单');
    console.log('[浏览器] 已切换到"已下单"标签');

    // 在浏览器内扫描并标记下单记录
    const count = await page.evaluate(() => {
      document.querySelectorAll('[data-tb-order]').forEach(el => {
        el.removeAttribute('data-tb-order');
        el.removeAttribute('data-tb-o-nickname');
        el.removeAttribute('data-tb-o-userid');
        el.removeAttribute('data-tb-o-time');
      });

      const regex = /([^\s\n(]{1,30})(?:\(([^)]+)\))?\s*(\d{1,2}:\d{2}(?::\d{2})?)/;
      let idx = 0;
      const seen = new Set();

      for (const el of document.querySelectorAll('div, li, p, span')) {
        const text = el.textContent?.trim();
        if (!text || text.length > 300) continue;
        if (el.querySelectorAll('div, li, p, span').length > 15) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.left > window.innerWidth * 0.5) continue;
        if (rect.height > 150 || rect.height < 8) continue;

        const match = text.match(regex);
        if (!match) continue;

        const [, nickname, userId, timeStr] = match;
        const hour = parseInt(timeStr.split(':')[0], 10);
        if (hour > 23) continue;

        if (text.includes('AI助理') || text.includes('问答助手')) continue;

        const key = `${nickname}_${userId || ''}_${timeStr}`;
        if (seen.has(key)) continue;
        seen.add(key);

        el.setAttribute('data-tb-order', String(idx));
        el.setAttribute('data-tb-o-nickname', nickname.trim());
        el.setAttribute('data-tb-o-userid', (userId || nickname).trim());
        el.setAttribute('data-tb-o-time', timeStr);
        idx++;
      }

      return idx;
    });

    console.log(`[浏览器] "已下单"标签中找到 ${count} 条记录`);

    const taggedElements = await page.$$('[data-tb-order]');

    for (const el of taggedElements) {
      try {
        const nickname = await el.getAttribute('data-tb-o-nickname');
        const userId = await el.getAttribute('data-tb-o-userid');
        const timeStr = await el.getAttribute('data-tb-o-time');

        const orderTime = parseCommentTime(timeStr);
        if (!orderTime.isValid() || !orderTime.isAfter(cutoff)) continue;

        orders.push({
          nickname,
          userId,
          time: orderTime.format('YYYY-MM-DD HH:mm:ss'),
          content: '已下单',
          element: el,
        });
      } catch {}
    }

    // 清除标记
    await page.evaluate(() => {
      document.querySelectorAll('[data-tb-order]').forEach(el => {
        el.removeAttribute('data-tb-order');
        el.removeAttribute('data-tb-o-nickname');
        el.removeAttribute('data-tb-o-userid');
        el.removeAttribute('data-tb-o-time');
      });
    });
  } catch (e) {
    console.error('[浏览器] 获取"已下单"标签数据异常:', e.message);
    return { orders: [], error: e.message };
  } finally {
    await clickCommentTab(page, '全部');
  }

  console.log(`[浏览器] "已下单"标签获取到 ${orders.length} 条记录`);
  return { orders, error: null };
}

/**
 * 查看订单信息
 *
 * 策略：
 * 1. 悬停评论元素，显示隐藏的操作按钮
 * 2. 在评论元素及其祖先容器内查找"查看订单"按钮/链接
 * 3. 对"已下单"类型的评论，尝试直接点击该条目
 * 4. 提取后验证 buyerId 与评论用户匹配
 */
async function getOrderInfo(page, comment) {
  try {
    if (!comment.element) {
      console.log('[浏览器] 评论元素不可用，跳过订单关联');
      return null;
    }

    // 悬停评论元素以显示可能隐藏的操作按钮
    try {
      await comment.element.hover();
      await page.waitForTimeout(800);
    } catch {}

    // 收集可能包含"查看订单"按钮的容器（从近到远）
    const containers = [];
    try {
      containers.push(comment.element);
      const directParent = await comment.element.evaluateHandle(el => el.parentElement);
      if (directParent) containers.push(directParent);
      const ancestor = await comment.element.evaluateHandle(el =>
        el.closest('[class*="interact"], [class*="chat"], [class*="comment"], [class*="msg"], [class*="item"], [class*="list"], li, tr')
      );
      if (ancestor) containers.push(ancestor);
    } catch {}

    // "查看订单"及订单相关按钮选择器
    const orderSelectors = [
      'text=查看订单',
      'button:has-text("查看订单")',
      'a:has-text("查看订单")',
      'span:has-text("查看订单")',
      'div:has-text("查看订单")',
      'text=订单详情',
      'button:has-text("订单")',
      'a:has-text("订单")',
      '[class*="order"]:has-text("查看")',
      '[class*="order"] svg',
      '[class*="order"] i',
      '[class*="order"] img',
      '[title*="订单"]',
      '[aria-label*="订单"]',
      '[class*="clipboard"]',
    ];

    // 在各层容器内搜索订单入口
    for (const container of containers) {
      for (const sel of orderSelectors) {
        try {
          const btn = await container.$(sel);
          if (btn) {
            const visible = await btn.isVisible().catch(() => true);
            if (!visible) continue;
            console.log(`[浏览器] 找到订单入口: ${sel}`);
            await btn.click();
            await page.waitForTimeout(2000);
            const orderInfo = await extractOrderFromPopup(page);
            if (orderInfo) {
              if (comment.userId && !orderInfo.buyerId) {
                console.log(`[浏览器] 订单缺少买家ID，跳过`);
                return null;
              }
              if (orderInfo.buyerId && comment.userId && orderInfo.buyerId !== comment.userId) {
                console.log(`[浏览器] 买家(${orderInfo.buyerId})与评论者(${comment.userId})不匹配，跳过`);
                return null;
              }
              return orderInfo;
            }
          }
        } catch {}
      }
    }

    // 对"已下单"类型评论，尝试点击条目本身
    if (comment.content === '已下单' || (comment.content && comment.content.includes('已下单'))) {
      try {
        await comment.element.click();
        await page.waitForTimeout(2000);
        const orderInfo = await extractOrderFromPopup(page);
        if (orderInfo) return orderInfo;
      } catch {}

      // 尝试找到"已下单"文本元素并点击
      try {
        const orderLabel = await comment.element.$(':text("已下单")');
        if (orderLabel) {
          await orderLabel.click();
          await page.waitForTimeout(2000);
          const orderInfo = await extractOrderFromPopup(page);
          if (orderInfo) return orderInfo;
        }
      } catch {}
    }

    console.log(`[浏览器] 未找到订单入口: ${comment.nickname}`);
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
  getOrdersFromTab,
  getOrderInfo,
  nowBeijing,
};
