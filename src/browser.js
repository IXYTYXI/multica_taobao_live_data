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
 * 判断错误是否由浏览器/页面关闭引起
 */
function isRecoverablePageError(message) {
  if (!message) return false;
  return /closed|Target page|context.*destroy|Browser has been closed|Protocol error/i.test(message);
}

/**
 * 判断页面是否仍可用于采集
 */
async function isPageUsable(page) {
  if (!page || page.isClosed()) return false;
  try {
    await page.evaluate(() => document.readyState);
    return true;
  } catch {
    return false;
  }
}

/**
 * 浏览器意外关闭后，重新打开并回到中控台
 * @param {{ browser: import('playwright').Browser|null, context: import('playwright').BrowserContext, listPage: import('playwright').Page }} session
 * @returns {Promise<import('playwright').Page>}
 */
async function recoverControlPanel(session) {
  console.log('[浏览器] ⚠ 检测到浏览器/页面不可用，开始自动恢复...');

  let { browser, context, listPage } = session;
  let listPageUsable = listPage && !listPage.isClosed();

  if (context) {
    try {
      const openPages = context.pages().filter((p) => !p.isClosed());
      if (openPages.length > 0) {
        listPage =
          openPages.find((p) => p.url().includes('/live/list')) ||
          openPages.find((p) => p.url().includes('liveplatform.taobao.com')) ||
          openPages[0];
        listPageUsable = true;
        console.log('[浏览器] 现有 context 仍有可用标签页');
      } else if (typeof context.newPage === 'function') {
        try {
          listPage = await context.newPage();
          listPageUsable = true;
          console.log('[浏览器] 在现有 context 中新建标签页');
        } catch (e) {
          console.log('[浏览器] 无法新建标签页:', e.message);
          context = null;
          listPageUsable = false;
        }
      }
    } catch (e) {
      console.log('[浏览器] context 已失效:', e.message);
      context = null;
      listPageUsable = false;
    }
  }

  if (!context || !listPageUsable) {
    console.log('[浏览器] 重新启动浏览器...');
    if (context) {
      try {
        await context.close();
      } catch {}
    }
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    const launched = await launchBrowser();
    session.browser = launched.browser;
    session.context = launched.context;
    session.listPage = launched.page;
    listPage = launched.page;
  }

  let activePage = null;
  let attempts = 0;
  const maxAttempts = 120;

  while (!activePage && attempts < maxAttempts) {
    attempts++;
    try {
      if (!listPage || listPage.isClosed()) {
        listPage = await session.context.newPage();
        session.listPage = listPage;
      }
      activePage = await enterLiveRoom(listPage);
    } catch (e) {
      console.log('[浏览器] 进入直播间失败:', e.message);
      if (isRecoverablePageError(e.message)) {
        listPage = null;
      }
    }

    if (!activePage) {
      console.log('[浏览器] 恢复：未找到直播场次，30 秒后重试...');
      await new Promise((r) => setTimeout(r, 30000));
      try {
        if (listPage && !listPage.isClosed()) {
          await listPage.goto(config.taobao.liveListUrl, { waitUntil: 'networkidle', timeout: 60000 });
        }
      } catch (e) {
        console.log('[浏览器] 页面加载异常:', e.message);
      }
    }
  }

  if (!activePage) {
    throw new Error('自动恢复失败：长时间未找到正在直播的场次');
  }

  console.log('[浏览器] 恢复：等待中控台数据加载...');
  await new Promise((r) => setTimeout(r, 8000));

  activePage = await findActivePage(activePage);
  await pruneDuplicateControlTabs(activePage);
  activePage = await refreshControlPanelPage(activePage);
  session.activePage = activePage;
  session.listPage = listPage;

  console.log('[浏览器] ✓ 自动恢复完成');
  return activePage;
}

/**
 * 关闭多余的中控台/列表标签页，避免恢复后堆积
 */
async function pruneDuplicateControlTabs(keepPage) {
  const context = keepPage.context();
  const pages = context.pages().filter((p) => !p.isClosed());
  const listPages = pages.filter((p) => p.url().includes('/live/list'));

  for (const p of pages) {
    if (p === keepPage) continue;
    const url = p.url();
    const isExtraControl = url.includes('/live/control');
    const isExtraList = url.includes('/live/list') && listPages.length > 1;
    if (!isExtraControl && !isExtraList) continue;
    try {
      await p.close();
      console.log('[浏览器] 关闭多余标签页:', url.substring(0, 80));
    } catch {}
  }
}

/**
 * 刷新中控台页面，修复评论区卡死/空白
 */
async function refreshControlPanelPage(page) {
  const url = page.url();
  if (!url.includes('/live/control')) {
    console.log('[浏览器] 当前不在中控台，跳过刷新');
    return page;
  }

  console.log('[浏览器] 刷新中控台页面...');
  try {
    await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.log('[浏览器] reload 失败，尝试 goto:', e.message);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  }

  await page.waitForTimeout(8000);
  await ensureCommentTab(page, '全部');
  console.log('[浏览器] 中控台页面刷新完成');
  return page;
}

/**
 * 判断评论区是否处于异常/卡死状态（页面还在，但扫不到评论结构）
 */
function isCommentPanelStale(scanResult, pageUrl) {
  if (!pageUrl?.includes('/live/control')) return false;
  if (scanResult?.tabOk === false) return true;

  const d = scanResult?.debug;
  if (!d) return false;

  if (d.bodyTextLength < 300) return true;

  if (d.strategy !== 'none' || d.elementScanMatches > 0 || d.innerTextMatches > 0) {
    return false;
  }

  const sampleLines = d.sampleLines || [];
  const onlyMeta =
    sampleLines.length > 0 &&
    sampleLines.every(
      (line) =>
        line.includes('开播时间') ||
        line.includes('更新时间') ||
        line.includes('直播互动') ||
        line.includes('全部') ||
        line.includes('已下单')
    );

  if (onlyMeta && d.bodyTextLength < 2000) return false;
  return d.bodyTextLength >= 800;
}

/**
 * 导航到直播列表并进入正在直播的场次
 *
 * 淘宝中控台的"直播详情"按钮会在新标签页中打开中控台。
 * 本函数捕获新标签页并返回正确的 page 对象。
 *
 * @returns {Page|null} 中控台页面对象，失败返回 null
 */
async function enterLiveRoom(page) {
  const currentUrl = page.url();
  if (!currentUrl.includes('liveplatform.taobao.com')) {
    console.log('[浏览器] 导航到直播列表页面...');
    await page.goto(config.taobao.liveListUrl, { waitUntil: 'networkidle', timeout: 60000 });
  } else {
    console.log('[浏览器] 已在直播列表页面，等待加载...');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(5000);

  if (await isStillLoginPage(page)) {
    console.log('[浏览器] ⏳ 页面需要登录，请在浏览器中完成登录...');
    console.log('[浏览器] 浏览器会保持打开，不会自动关闭');
    await waitForLogin(page);

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

  const context = page.context();

  for (const selector of detailSelectors) {
    try {
      const btn = await page.$(selector);
      if (btn) {
        console.log('[浏览器] 找到"直播详情"入口，点击进入...');

        // 点击"直播详情"可能在新标签页中打开中控台
        const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
        await btn.click();
        const popup = await popupPromise;

        if (popup) {
          console.log('[浏览器] 中控台在新标签页中打开');
          await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
          await popup.waitForTimeout(5000);
          console.log('[浏览器] 新标签页 URL:', popup.url());
          return popup;
        }

        // 没有新标签页 → 在同一页面内导航
        await page.waitForTimeout(5000);
        console.log('[浏览器] 已进入中控台页面');
        return page;
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

      const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
      await page.click(`a:has-text("${link.text}")`).catch(async () => {
        await page.goto(link.href, { waitUntil: 'networkidle', timeout: 30000 });
      });
      const popup = await popupPromise;

      if (popup) {
        console.log('[浏览器] 链接在新标签页中打开');
        await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await popup.waitForTimeout(3000);
        return popup;
      }

      await page.waitForTimeout(3000);
      return page;
    }
  }

  console.error('[浏览器] 未能找到直播详情入口');
  return null;
}

/**
 * 在所有打开的标签页中查找中控台页面
 *
 * 当"直播详情"在新标签页打开时，需要找到正确的页面。
 * 判断标准：页面 innerText 包含评论格式文本（昵称+括号+时间）
 */
async function findActivePage(page) {
  const context = page.context();
  const pages = context.pages();
  console.log(`[浏览器] 当前浏览器共 ${pages.length} 个标签页`);

  const headerRegex = /[\(（][^)）]+[\)）]\s*\d{1,2}:\d{2}/;

  let bestPage = page;
  let bestScore = 0;

  for (let i = 0; i < pages.length; i++) {
    try {
      const info = await pages[i].evaluate(() => {
        const text = document.body?.innerText || '';
        return {
          url: window.location.href,
          textLength: text.length,
          hasLiveInteraction: text.includes('直播互动'),
          sample: text.substring(0, 300),
        };
      });

      console.log(`[浏览器] 标签页${i}: url=${info.url.substring(0, 80)}, 文本=${info.textLength}字, 直播互动=${info.hasLiveInteraction}`);

      // 评分：URL 优先，其次文本量与评论格式
      let score = 0;
      if (info.url.includes('/live/control')) score += 1000;
      if (info.url.includes('/live/list')) score -= 500;
      if (info.hasLiveInteraction) score += 100;
      if (info.textLength > 3000) score += 50;
      if (info.textLength > 1000) score += 20;
      if (headerRegex.test(info.sample)) score += 200;

      // 检查是否包含评论格式的文本
      const hasComments = await pages[i].evaluate((regex) => {
        const text = document.body?.innerText || '';
        return new RegExp(regex).test(text);
      }, headerRegex.source);
      if (hasComments) score += 200;

      if (score > bestScore) {
        bestScore = score;
        bestPage = pages[i];
      }
    } catch (e) {
      console.log(`[浏览器] 标签页${i}: 无法访问 (${e.message})`);
    }
  }

  console.log(`[浏览器] 选择标签页: ${bestPage.url().substring(0, 80)} (score=${bestScore})`);
  return bestPage;
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
 * 保存当前页面完整 HTML 到 data/page-dump.html，用于调试 DOM 结构。
 * 同时运行诊断扫描，结果保存到 data/debug-scan.json。
 */
async function dumpPageDOM(page) {
  const dumpDir = path.resolve(__dirname, '..', 'data');
  if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });

  try {
    const html = await page.content();
    const dumpPath = path.join(dumpDir, 'page-dump.html');
    fs.writeFileSync(dumpPath, html, 'utf8');
    console.log(`[浏览器] DOM 已保存到 ${dumpPath} (${(html.length / 1024).toFixed(1)} KB)`);
  } catch (e) {
    console.error('[浏览器] DOM dump 失败:', e.message);
  }

  // 诊断扫描：检查所有 frame 并查找关键元素
  try {
    const scanResult = await debugScanPage(page);
    const scanPath = path.join(dumpDir, 'debug-scan.json');
    fs.writeFileSync(scanPath, JSON.stringify(scanResult, null, 2), 'utf8');
    console.log(`[浏览器] 诊断扫描已保存到 ${scanPath}`);

    // 输出关键诊断信息
    for (let i = 0; i < scanResult.frames.length; i++) {
      const f = scanResult.frames[i];
      console.log(`[浏览器] Frame ${i}: url=${f.url?.substring(0, 80)}, 直播互动=${f.hasLiveInteraction}, 时间元素=${f.timePatternCount}, 样本文本数=${f.sampleTexts?.length || 0}`);
    }
  } catch (e) {
    console.error('[浏览器] 诊断扫描失败:', e.message);
  }
}

/**
 * 诊断扫描：检查所有 frame，查找关键文本，帮助定位 DOM 结构
 */
async function debugScanPage(page) {
  const frames = page.frames();
  const result = {
    frameCount: frames.length,
    frames: [],
    timestamp: nowBeijing().format('YYYY-MM-DD HH:mm:ss'),
  };

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    try {
      const scan = await frame.evaluate(() => {
        const body = document.body;
        if (!body) return { error: 'no body', url: window.location.href };

        const findings = {
          url: window.location.href,
          hasLiveInteraction: body.textContent.includes('直播互动'),
          hasAllTab: false,
          hasOrderTab: false,
          timePatternCount: 0,
          headerPatternCount: 0,
          sampleTexts: [],
          commentCandidates: [],
        };

        // 检查标签文本
        const fullText = body.textContent;
        findings.hasAllTab = /全部\s*[|｜]?\s*用户/.test(fullText) || fullText.includes('全部');
        findings.hasOrderTab = fullText.includes('已下单');

        // 扫描所有可见文本元素，收集样本和匹配
        const headerRegex = /(.+?)[\(（]([^)）]+)[\)）]\s*(\d{1,2}:\d{2})/;
        const timeRegex = /\d{1,2}:\d{2}/;

        for (const el of document.querySelectorAll('*')) {
          // 只看叶子级或低深度元素
          if (el.children.length > 10) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          const text = el.textContent?.trim();
          if (!text || text.length < 3 || text.length > 500) continue;

          // 采样前 100 个有意义的文本
          if (findings.sampleTexts.length < 100 && text.length >= 3 && text.length <= 200) {
            // 避免重复
            if (!findings.sampleTexts.some(s => s.text === text.substring(0, 100))) {
              findings.sampleTexts.push({
                text: text.substring(0, 100),
                tag: el.tagName,
                pos: `${rect.x.toFixed(0)},${rect.y.toFixed(0)}`,
                size: `${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`,
              });
            }
          }

          if (timeRegex.test(text)) {
            findings.timePatternCount++;
          }

          if (headerRegex.test(text)) {
            findings.headerPatternCount++;
            if (findings.commentCandidates.length < 20) {
              findings.commentCandidates.push({
                text: text.substring(0, 150),
                tag: el.tagName,
                pos: `${rect.x.toFixed(0)},${rect.y.toFixed(0)}`,
                size: `${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`,
                children: el.children.length,
              });
            }
          }
        }

        return findings;
      });
      result.frames.push(scan);
    } catch (e) {
      result.frames.push({ error: e.message, url: frame.url() });
    }
  }

  return result;
}

/**
 * 获取包含"直播互动"内容的 frame（可能是 iframe）
 * 优先找包含"直播互动"文本的 frame，否则回退到主 frame
 */
async function getContentFrame(page) {
  const frames = page.frames();
  if (frames.length === 1) return page;

  for (const frame of frames) {
    try {
      const hasContent = await frame.evaluate(() => {
        return document.body?.textContent?.includes('直播互动') || false;
      });
      if (hasContent) {
        console.log(`[浏览器] 在 frame(${frame.url().substring(0, 60)}) 中找到"直播互动"`);
        return frame;
      }
    } catch {}
  }

  console.log('[浏览器] 未在任何 iframe 中找到"直播互动"，使用主 frame');
  return page;
}

/** 评论行正则：支持 `昵称(id) 10:23内容`（时间与内容间可无空格） */
const COMMENT_HEADER_REGEX = /(.+?)[\(（]([^)）]+)[\)）][\s\u00a0]*(\d{1,2}:\d{2}(?::\d{2})?)(.*)/;

/**
 * 读取"直播互动"区域当前激活的子标签
 */
async function getActiveCommentTab(page) {
  const frame = await getContentFrame(page);
  try {
    return await frame.evaluate(() => {
      let interactionContainer = null;
      for (const el of document.querySelectorAll('*')) {
        const ownText = el.textContent?.trim();
        if (ownText === '直播互动' || (ownText?.startsWith('直播互动') && ownText.length < 20)) {
          let parent = el;
          for (let i = 0; i < 8 && parent; i++) {
            if (parent.getBoundingClientRect().height > 200) {
              interactionContainer = parent;
              break;
            }
            parent = parent.parentElement;
          }
          if (interactionContainer) break;
        }
      }
      const searchRoot = interactionContainer || document.body;
      const tabNames = ['全部', '已下单', '已加购', '用户', '主播', '粉丝'];
      for (const el of searchRoot.querySelectorAll('div, span, a, button, li, label')) {
        const ownText = el.textContent?.trim();
        if (!tabNames.includes(ownText)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        const cls = typeof el.className === 'string' ? el.className : '';
        const active =
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('aria-current') === 'true' ||
          cls.includes('active') ||
          cls.includes('selected') ||
          cls.includes('current') ||
          style.fontWeight === '700' ||
          style.fontWeight === 'bold';
        if (active) return ownText;
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * 仅在需要时切换标签，避免每轮来回点击
 */
async function ensureCommentTab(page, tabText) {
  const active = await getActiveCommentTab(page);
  if (active === tabText) {
    console.log(`[浏览器] 已在"${tabText}"标签，跳过切换`);
    return { ok: true, alreadyActive: true };
  }
  return await clickCommentTab(page, tabText);
}

/**
 * 在"直播互动"区域内点击指定标签
 * 先定位"直播互动"容器，再在其中查找标签，避免误点右侧"口袋商品"区域
 */
async function clickCommentTab(page, tabText) {
  const frame = await getContentFrame(page);
  try {
    const clicked = await frame.evaluate((text) => {
      // 先定位"直播互动"标题所在的容器
      let interactionContainer = null;
      for (const el of document.querySelectorAll('*')) {
        const ownText = el.textContent?.trim();
        if (ownText === '直播互动' || (ownText?.startsWith('直播互动') && ownText.length < 20)) {
          let parent = el;
          for (let i = 0; i < 8 && parent; i++) {
            if (parent.getBoundingClientRect().height > 200) {
              interactionContainer = parent;
              break;
            }
            parent = parent.parentElement;
          }
          if (interactionContainer) break;
        }
      }

      const searchRoot = interactionContainer || document.body;
      for (const el of searchRoot.querySelectorAll('div, span, a, button, li, label')) {
        if (el.children.length > 5) continue;
        const ownText = el.textContent?.trim();
        if (ownText !== text) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.left > window.innerWidth * 0.6) continue;
        if (rect.width > 200 || rect.height > 60) continue;

        el.click();
        return { clicked: true, container: !!interactionContainer };
      }
      return { clicked: false, container: !!interactionContainer };
    }, tabText);

    if (clicked.clicked) {
      await page.waitForTimeout(1000);
      console.log(`[浏览器] 点击了"${tabText}"标签 (container=${clicked.container})`);
    } else {
      console.log(`[浏览器] 未找到"${tabText}"标签 (container=${clicked.container})`);
    }
    return { ok: clicked.clicked, container: clicked.container };
  } catch (e) {
    console.log(`[浏览器] 点击"${tabText}"标签失败:`, e.message);
    return { ok: false, container: false };
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
 * 获取近期评论（仅在"全部"标签扫描，含"已下单"类条目，不切换标签）
 *
 * @param {import('playwright').Page} page
 * @param {number|null} withinMinutes - 时间窗口（分钟）；null 表示不过滤，取当前可见全部
 */
/**
 * 首次同步时滚动评论列表，尽量加载虚拟列表中的历史评论
 */
async function scrollCommentList(page, frame) {
  console.log('[浏览器] 在直播互动评论列表内滚动加载...');
  await scrollCommentListStep(frame, 'end');
  await page.waitForTimeout(200);

  for (let i = 0; i < 80; i++) {
    const s = await scrollCommentListStep(frame, 'up');
    if (!s.found) {
      console.log('[浏览器] 未找到评论列表滚动容器');
      break;
    }
    await page.waitForTimeout(120);
    if (s.atTop) break;
  }

  await scrollCommentListStep(frame, 'end');
  await page.waitForTimeout(200);
  console.log('[浏览器] 评论列表滚动完成');
  await page.waitForTimeout(400);
}

/** 在 frame 内扫描当前可见评论（element-scan + innerText） */
async function scanCommentsInFrame(frame) {
  return frame.evaluate(() => {
    const results = [];
    const seen = new Set();
    const headerRegex = /(.+?)[\(（]([^)）]+)[\)）][\s\u00a0]*(\d{1,2}:\d{2}(?::\d{2})?)(.*)/;
    const uiLabels = new Set(['全部', '用户', '主播', '粉丝', '已加购', '已下单', '评论', '活跃用户', '直播互动']);

    const debug = {
      strategy: [],
      bodyTextLength: 0,
      lineCount: 0,
      innerTextMatches: 0,
      elementScanMatches: 0,
      sampleLines: [],
    };

    function findInteractionRoot() {
      let best = null;
      let bestScore = 0;
      for (const el of document.querySelectorAll('div, section, aside')) {
        const text = el.textContent || '';
        if (!text.includes('直播互动') || !text.includes('全部')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height < 280) continue;
        if (rect.left > window.innerWidth * 0.55) continue;
        const score = rect.height * rect.width;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return best || document.body;
    }

    function normalizeContent(raw) {
      return (raw || '').replace(/[\s\u00a0]+/g, ' ').replace(/^[-–—]\s*/, '').trim();
    }

    function addResult(nickname, userId, timeStr, content) {
      const hour = parseInt(timeStr.split(':')[0], 10);
      if (hour > 23) return false;
      if (nickname.includes('AI助理') || nickname.includes('问答助手')) return false;
      if (nickname.includes('系统消息') || nickname.includes('管理员')) return false;

      const finalContent = normalizeContent(content);
      if (!finalContent || finalContent.startsWith('私密回复')) return false;
      if (uiLabels.has(finalContent)) return false;

      const key = `${nickname.trim()}_${userId}_${timeStr}_${finalContent}`;
      if (seen.has(key)) return false;
      seen.add(key);
      results.push({
        nickname: nickname.trim(),
        userId: userId.trim(),
        timeStr,
        content: finalContent,
      });
      return true;
    }

    function extractFromLine(line, nextLines) {
      const m = line.match(headerRegex);
      if (!m) return false;
      const [, nickname, userId, timeStr, inlineContent] = m;
      let content = normalizeContent(inlineContent);
      if (!content && nextLines) {
        for (const nextLine of nextLines) {
          const trimmed = nextLine.trim();
          if (!trimmed || headerRegex.test(trimmed) || uiLabels.has(trimmed)) continue;
          content = trimmed;
          break;
        }
      }
      return addResult(nickname, userId, timeStr, content);
    }

    const root = findInteractionRoot();
    const bodyText = root.innerText || '';
    debug.bodyTextLength = bodyText.length;
    const lines = bodyText.split(/\n/);
    debug.lineCount = lines.length;

    let sampleCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 2 && /\d{1,2}:\d{2}/.test(trimmed) && sampleCount < 30) {
        debug.sampleLines.push(trimmed.substring(0, 120));
        sampleCount++;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.length < 5) continue;
      if (!headerRegex.test(line)) continue;
      debug.innerTextMatches++;
      extractFromLine(line, lines.slice(i + 1, i + 4));
    }
    if (debug.innerTextMatches > 0) debug.strategy.push('innerText');

    for (const el of root.querySelectorAll('div, span, li, p, a, td')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.height > 120 || rect.height < 5) continue;
      if (el.children.length > 8) continue;

      const text = el.textContent?.trim();
      if (!text || text.length < 8 || text.length > 500) continue;
      if (!/\d{1,2}:\d{2}/.test(text)) continue;

      const m = text.match(headerRegex);
      if (!m) continue;
      debug.elementScanMatches++;

      const [, nickname, userId, timeStr, inlineContent] = m;
      let content = normalizeContent(inlineContent);
      if (!content) {
        const nextSib = el.nextElementSibling;
        if (nextSib) {
          const sibText = nextSib.textContent?.trim();
          if (sibText && sibText.length < 300 && !headerRegex.test(sibText)) {
            content = sibText.split(/[\n\r]+/)[0].trim();
          }
        }
      }
      addResult(nickname, userId, timeStr, content);
    }
    if (debug.elementScanMatches > 0) debug.strategy.push('element-scan');

    debug.strategy = debug.strategy.length ? debug.strategy.join('+') : 'none';
    return { results, debug };
  });
}

function rawScanResultsToComments(rawResults, cutoff = null) {
  const comments = [];
  for (const c of rawResults) {
    const commentTime = parseCommentTime(c.timeStr);
    if (!commentTime.isValid()) continue;
    if (cutoff && commentTime.isBefore(cutoff)) continue;
    comments.push({
      nickname: c.nickname,
      userId: c.userId,
      time: commentTime.format('YYYY-MM-DD HH:mm:ss'),
      content: c.content,
    });
  }
  return comments;
}

/**
 * 在「直播互动」评论列表内滚动一步（不滚主页面）
 * 优先定位包含 .tc-comment-item 的 scroll 容器
 */
async function scrollCommentListStep(frame, direction = 'down') {
  return frame.evaluate((dir) => {
    function findInteractionRoot() {
      let best = null;
      let bestScore = 0;
      for (const el of document.querySelectorAll('div, section, aside')) {
        const text = el.textContent || '';
        if (!text.includes('直播互动') || !text.includes('全部')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height < 280) continue;
        if (rect.left > window.innerWidth * 0.55) continue;
        const score = rect.height * rect.width;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return best;
    }

    /** 评论列表滚动容器：含 .tc-comment-item 的 scroll 区域，非整页 */
    function findCommentListScroller() {
      const sample = document.querySelector('.tc-comment-item');
      if (sample) {
        let el = sample.parentElement;
        while (el) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight + 30 &&
            rect.width > 0 &&
            rect.left < window.innerWidth * 0.6
          ) {
            return el;
          }
          el = el.parentElement;
        }
      }

      const root = findInteractionRoot();
      if (!root) return null;

      let best = null;
      let bestCount = 0;
      for (const el of root.querySelectorAll('*')) {
        const style = window.getComputedStyle(el);
        if (!(style.overflowY === 'auto' || style.overflowY === 'scroll')) continue;
        if (el.scrollHeight <= el.clientHeight + 30) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.left > window.innerWidth * 0.55) continue;
        const count = el.querySelectorAll('.tc-comment-item').length;
        if (count > bestCount) {
          bestCount = count;
          best = el;
        }
      }
      return best;
    }

    const scroller = findCommentListScroller();
    if (!scroller) return { found: false };

    const step = Math.max(scroller.clientHeight * 0.75, 120);
    const prevTop = scroller.scrollTop;
    if (dir === 'up') {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - step);
    } else if (dir === 'end') {
      scroller.scrollTop = scroller.scrollHeight;
    } else {
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + step);
    }

    return {
      found: true,
      moved: scroller.scrollTop !== prevTop,
      atTop: scroller.scrollTop <= 5,
      atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      commentItems: scroller.querySelectorAll('.tc-comment-item').length,
    };
  }, direction);
}

/**
 * 将评论行滚入评论列表可视区（只滚评论列表，不滚主页面）
 */
async function scrollCommentItemIntoView(page, itemHandle) {
  await itemHandle.evaluate((itemEl) => {
    let scroller = null;
    let el = itemEl.parentElement;
    while (el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 30 &&
        rect.width > 0 &&
        rect.left < window.innerWidth * 0.6
      ) {
        scroller = el;
        break;
      }
      el = el.parentElement;
    }
    if (!scroller) return;

    const itemRect = itemEl.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const relTop = itemRect.top - scrollerRect.top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, relTop - scroller.clientHeight / 2);
  });
  await page.waitForTimeout(200);
}

/**
 * 启动兜底：滚动加载并合并整场直播目前已加载的全部评论
 * 适用于程序启动时直播已在进行的情况
 */
async function scrollAndCollectAllComments(page) {
  const frame = await getContentFrame(page);
  await ensureCommentTab(page, '全部');

  console.log('[浏览器] 启动兜底：滚动全量扫描历史评论...');

  const merged = new Map();

  const mergeScan = (rawResults) => {
    const batch = rawScanResultsToComments(rawResults, null);
    let added = 0;
    for (const c of batch) {
      const key = `${c.userId}_${c.time}_${c.content}`;
      if (!merged.has(key)) {
        merged.set(key, c);
        added++;
      }
    }
    return added;
  };

  // 先滚到顶部
  for (let i = 0; i < 30; i++) {
    const s = await scrollCommentListStep(frame, 'up');
    if (!s.found || s.atTop) break;
    await page.waitForTimeout(200);
  }

  let firstScan = await scanCommentsInFrame(frame);
  mergeScan(firstScan.results);
  console.log(`[浏览器] 兜底初始扫描: ${merged.size} 条`);

  let stagnant = 0;
  for (let step = 0; step < 150; step++) {
    const scroll = await scrollCommentListStep(frame, 'down');
    if (!scroll.found) break;
    await page.waitForTimeout(350);

    const scan = await scanCommentsInFrame(frame);
    const added = mergeScan(scan.results);
    if (added === 0) stagnant += 1;
    else stagnant = 0;

    if (step % 10 === 0) {
      console.log(`[浏览器] 兜底滚动 step=${step}, 累计 ${merged.size} 条`);
    }
    if (scroll.atEnd && stagnant >= 3) break;
    if (stagnant >= 6) break;
    if (!scroll.moved && scroll.atEnd) break;
  }

  // 滚回评论列表底部，便于后续监控新评论（不滚主页面）
  await scrollCommentListStep(frame, 'end');
  await page.waitForTimeout(400);

  const comments = [...merged.values()].sort((a, b) => a.time.localeCompare(b.time));
  console.log(`[浏览器] 兜底全量扫描完成，共 ${comments.length} 条去重评论`);
  return { comments, debug: firstScan.debug };
}

async function getRecentComments(page, withinMinutes, { syncAllVisible = false } = {}) {
  const cutoff = syncAllVisible || withinMinutes == null
    ? null
    : nowBeijing().subtract(withinMinutes, 'minute');
  if (cutoff) {
    console.log(`[浏览器] 获取 ${cutoff.format('HH:mm:ss')} 之后的评论...`);
  } else {
    console.log('[浏览器] 获取当前可见的全部评论（首次同步）...');
  }

  const frame = await getContentFrame(page);
  const tabResult = await ensureCommentTab(page, '全部');
  if (syncAllVisible && config.monitor.scrollOnSync) {
    await scrollCommentList(page, frame);
    await page.waitForTimeout(2000);
  }

  const comments = [];
  let rawComments = null;

  try {
    rawComments = await scanCommentsInFrame(frame);

    if (syncAllVisible && rawComments.results.length === 0) {
      console.log('[浏览器] 首次扫描无评论，等待渲染后重试...');
      await page.waitForTimeout(2000);
      rawComments = await scanCommentsInFrame(frame);
    }

    // 诊断日志
    const d = rawComments.debug;
    console.log(`[浏览器] 评论扫描: strategy=${d.strategy}, bodyText=${d.bodyTextLength}字, ${d.lineCount}行, innerText匹配=${d.innerTextMatches}, element匹配=${d.elementScanMatches}`);
    console.log(`[浏览器] 原始评论数: ${rawComments.results.length}`);

    if (rawComments.results.length === 0 && d.sampleLines.length > 0) {
      console.log('[浏览器] 页面中包含时间模式的文本行（诊断）:');
      for (const line of d.sampleLines.slice(0, 10)) {
        console.log(`  > ${line}`);
      }
    }

    if (rawComments.results.length === 0) {
      try {
        const dumpDir = path.resolve(__dirname, '..', 'data');
        if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
        fs.writeFileSync(
          path.join(dumpDir, 'debug-scan-live.json'),
          JSON.stringify(rawComments.debug, null, 2), 'utf8'
        );
      } catch {}
    }

    for (const c of rawComments.results) {
      const commentTime = parseCommentTime(c.timeStr);
      if (!commentTime.isValid()) continue;
      if (cutoff && commentTime.isBefore(cutoff)) continue;

      comments.push({
        nickname: c.nickname,
        userId: c.userId,
        time: commentTime.format('YYYY-MM-DD HH:mm:ss'),
        content: c.content,
      });
    }
  } catch (e) {
    console.error('[浏览器] 获取评论异常:', e.message);
    return { comments: [], error: e.message };
  }

  console.log(`[浏览器] 获取到 ${comments.length} 条近期评论`);
  return {
    comments,
    error: null,
    debug: rawComments?.debug || null,
    tabOk: tabResult?.ok !== false,
  };
}

/**
 * 切换到"已下单"标签页获取下单记录，然后切回"全部"
 * innerText 全文扫描 + 元素扫描 + TreeWalker 三层策略
 */
async function getOrdersFromTab(page, withinMinutes) {
  const cutoff = nowBeijing().subtract(withinMinutes, 'minute');
  const orders = [];
  const frame = await getContentFrame(page);

  try {
    await clickCommentTab(page, '已下单');
    console.log('[浏览器] 已切换到"已下单"标签');

    const rawOrders = await frame.evaluate(() => {
      const results = [];
      const seen = new Set();
      const headerRegex = /(.+?)[\(（]([^)）]+)[\)）]\s*(\d{1,2}:\d{2}(?::\d{2})?)/;

      function add(nickname, userId, timeStr) {
        const hour = parseInt(timeStr.split(':')[0], 10);
        if (hour > 23) return;
        if (nickname.includes('AI助理') || nickname.includes('问答助手')) return;
        const key = `${nickname.trim()}_${userId}_${timeStr}`;
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ nickname: nickname.trim(), userId: userId.trim(), timeStr });
      }

      // 策略0: innerText 全文扫描
      try {
        const bodyText = document.body.innerText || '';
        for (const line of bodyText.split(/\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.length < 5) continue;
          const m = trimmed.match(headerRegex);
          if (m) add(m[1], m[2], m[3]);
        }
      } catch {}

      // 策略1: 元素 textContent 扫描
      if (results.length === 0) {
        for (const el of document.querySelectorAll('div, span, li, p, a')) {
          const text = el.textContent?.trim();
          if (!text || text.length < 5 || text.length > 800) continue;
          if (!/\d{1,2}:\d{2}/.test(text)) continue;
          if (el.querySelectorAll('div, span, li, p').length > 20) continue;
          const m = text.match(headerRegex);
          if (m) add(m[1], m[2], m[3]);
        }
      }

      // 策略2: TreeWalker
      if (results.length === 0) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
          const nodeText = walker.currentNode.textContent.trim();
          if (!nodeText || nodeText.length < 5 || nodeText.length > 300) continue;
          const m = nodeText.match(headerRegex);
          if (m) add(m[1], m[2], m[3]);
        }
      }

      return results;
    });

    console.log(`[浏览器] "已下单"标签中找到 ${rawOrders.length} 条记录`);

    for (const o of rawOrders) {
      const orderTime = parseCommentTime(o.timeStr);
      if (!orderTime.isValid() || !orderTime.isAfter(cutoff)) continue;

      orders.push({
        nickname: o.nickname,
        userId: o.userId,
        time: orderTime.format('YYYY-MM-DD HH:mm:ss'),
        content: '已下单',
      });
    }
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
 * 从弹出的订单对话框/面板中提取订单数据
 * 支持三种策略：真实 <table>、div-based 表格、正则兜底
 */
async function extractOrdersFromPopup(page) {
  const frame = await getContentFrame(page);
  return frame.evaluate(() => {
    const results = [];

    // 查找包含订单信息的对话框/面板
    const dialogSelectors = [
      '[role="dialog"]',
      '[class*="modal"]',
      '[class*="dialog"]',
      '[class*="popup"]',
      '[class*="drawer"]',
      '[class*="overlay"]',
      '[class*="popover"]',
      '[class*="tooltip"]',
    ];

    let dialog = null;
    for (const sel of dialogSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = el.textContent || '';
        if (text.includes('仅展示本场直播') ||
            (text.includes('订单') && el.getBoundingClientRect().height > 100)) {
          dialog = el;
          break;
        }
      }
      if (dialog) break;
    }

    // 回退：查找 fixed/absolute 定位的弹出元素
    if (!dialog) {
      for (const el of document.querySelectorAll('div')) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (rect.height > 100 && rect.width > 200 &&
            (style.position === 'fixed' || style.position === 'absolute') &&
            style.zIndex && parseInt(style.zIndex) > 10 &&
            el.textContent.includes('订单')) {
          dialog = el;
          break;
        }
      }
    }

    // 再回退：查找最近出现的、包含订单ID格式数字的浮动元素
    if (!dialog) {
      for (const el of document.querySelectorAll('div')) {
        const rect = el.getBoundingClientRect();
        if (rect.height < 50 || rect.width < 150) continue;
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'absolute') continue;
        const text = el.textContent || '';
        if (/\d{15,25}/.test(text)) {
          dialog = el;
          break;
        }
      }
    }

    if (!dialog) return results;

    // Strategy 1: 真正的 <table> 元素
    const table = dialog.querySelector('table');
    if (table) {
      const trs = table.querySelectorAll('tr');
      for (let i = 1; i < trs.length; i++) {
        const cells = trs[i].querySelectorAll('td, th');
        if (cells.length >= 4) {
          results.push({
            productTitle: cells[0].textContent.trim(),
            orderTime: cells[1].textContent.trim().replace(/\//g, '-'),
            paymentTime: cells[2].textContent.trim().replace(/\//g, '-'),
            orderId: cells[3].textContent.trim(),
          });
        }
      }
      if (results.length > 0) return results;
    }

    // Strategy 2: div-based 表格
    const headerTexts = ['商品标题', '下单时间', '支付时间', '订单'];
    let headerRow = null;
    for (const el of dialog.querySelectorAll('div, tr, thead')) {
      const text = el.textContent || '';
      const matchCount = headerTexts.filter(h => text.includes(h)).length;
      if (matchCount >= 3 && el.getBoundingClientRect().height < 80) {
        headerRow = el;
        break;
      }
    }

    if (headerRow) {
      const dataContainer = headerRow.parentElement;
      if (dataContainer) {
        for (const row of dataContainer.querySelectorAll('div, tr')) {
          if (row === headerRow || row.contains(headerRow) || headerRow.contains(row)) continue;
          const rowText = row.textContent || '';
          const orderIdMatch = rowText.match(/(\d{15,25})/);
          if (!orderIdMatch) continue;

          const times = rowText.match(/\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/g) || [];
          results.push({
            productTitle: '',
            orderTime: times[0] ? times[0].replace(/\//g, '-') : '',
            paymentTime: times[1] ? times[1].replace(/\//g, '-') : (times[0] ? times[0].replace(/\//g, '-') : ''),
            orderId: orderIdMatch[1],
          });
        }
      }
    }

    // Strategy 3: 纯文本提取
    if (results.length === 0) {
      const dialogText = dialog.textContent || '';
      const orderIds = dialogText.match(/\d{15,25}/g) || [];
      const times = dialogText.match(/\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/g) || [];

      for (let i = 0; i < orderIds.length; i++) {
        results.push({
          productTitle: '',
          orderTime: times[i * 2] ? times[i * 2].replace(/\//g, '-') : '',
          paymentTime: times[i * 2 + 1] ? times[i * 2 + 1].replace(/\//g, '-') : '',
          orderId: orderIds[i],
        });
      }
    }

    return results;
  });
}

/**
 * 只读：若订单弹窗已打开则读取
 */
async function extractAllOrders(page) {
  try {
    const orders = await extractOrdersFromPopup(page);
    if (orders.length > 0) {
      console.log(`[浏览器] 从已打开的订单弹窗读取 ${orders.length} 条（只读）`);
      return orders;
    }
    return [];
  } catch (e) {
    console.error('[浏览器] 读取订单弹窗异常:', e.message);
    return [];
  }
}

/**
 * 在评论列表中定位与 comment 匹配的 .tc-comment-item 元素
 */
async function findCommentItemHandle(frame, comment) {
  const hm = comment.time.substring(11, 16);
  const items = await frame.$$('.tc-comment-item');

  for (const item of items) {
    const matches = await item.evaluate(
      (el, { userId, nickname, hm, content }) => {
        const nameEl = el.querySelector('.tc-comment-item-userinfo-name');
        const timeEl = el.querySelector('.alpw-comment-time');
        const contentEl = el.querySelector('.tc-comment-item-content');
        if (!nameEl || !timeEl) return false;

        const nameText = (nameEl.textContent || '').trim();
        const timeText = (timeEl.textContent || '').replace(/\s+/g, '').trim();
        const contentText = (contentEl?.textContent || '').trim();
        const contentSnippet = (content || '').trim().replace(/\[-[^\]]+\]/g, '').substring(0, 24);

        if (!nameText.includes(nickname) || !nameText.includes(userId)) return false;
        if (!timeText.includes(hm.replace(':', '')) && !timeText.includes(hm)) return false;
        if (contentSnippet.length >= 2 && !contentText.includes(contentSnippet)) return false;
        return true;
      },
      { userId: comment.userId, nickname: comment.nickname, hm, content: comment.content || '' }
    );
    if (matches) return item;
  }
  return null;
}

/**
 * 虚拟列表中滚动查找评论行（兜底扫描后 DOM 里可能没有目标行）
 */
async function findCommentItemHandleWithScroll(frame, page, comment, maxSteps = 40) {
  let item = await findCommentItemHandle(frame, comment);
  if (item) return item;

  for (let step = 0; step < maxSteps; step++) {
    const scroll = await scrollCommentListStep(frame, 'up');
    if (!scroll.found) break;
    await page.waitForTimeout(350);
    item = await findCommentItemHandle(frame, comment);
    if (item) return item;
    if (!scroll.moved && scroll.atTop) break;
  }

  return null;
}

/**
 * 针对单条评论：悬停该行 → 点击「查看订单」→ 读取弹窗（无订单则返回 null）
 *
 * 使用 Playwright element.hover() 触发 CSS :hover，避免 page.mouse 坐标偏移导致按钮不显示。
 *
 * @returns {Object|null} 订单对象 { orderId, orderTime, paymentTime, productTitle }
 */
async function viewOrderForComment(page, comment) {
  const frame = await getContentFrame(page);
  const hm = comment.time.substring(11, 16);

  let item = await findCommentItemHandle(frame, comment);
  if (!item) {
    item = await findCommentItemHandleWithScroll(frame, page, comment);
  }

  if (!item) {
    console.log(`[浏览器] 未找到评论行: ${comment.nickname}(${comment.userId}) ${hm}`);
    return null;
  }

  const preview = await item.evaluate((el) => {
    const name = el.querySelector('.tc-comment-item-userinfo-name')?.textContent?.trim() || '';
    const time = el.querySelector('.alpw-comment-time')?.textContent?.trim() || '';
    const content = el.querySelector('.tc-comment-item-content')?.textContent?.trim() || '';
    return `${name} ${time} ${content}`.substring(0, 100);
  });
  console.log(`[浏览器] 悬停评论: ${preview}`);

  await scrollCommentItemIntoView(page, item);
  await page.waitForTimeout(300);

  let orderBtn = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await item.hover();
    await page.waitForTimeout(attempt === 0 ? 700 : 450);

    orderBtn = await item.$('[data-tblalog-id="chakandingdan"]');
    if (!orderBtn) {
      orderBtn = await item.$('img[alt="订单"]');
    }
    if (!orderBtn) {
      const actionWrap = await item.$('.tc-comment-item-action-container, .tc-comment-item-action');
      if (actionWrap) {
        await actionWrap.hover().catch(() => {});
        await page.waitForTimeout(300);
        orderBtn = await item.$('[data-tblalog-id="chakandingdan"], img[alt="订单"]');
      }
    }
    if (orderBtn) {
      const visible = await orderBtn.isVisible().catch(() => false);
      if (visible) break;
      orderBtn = null;
    }
  }

  if (!orderBtn) {
    console.log('[浏览器] 悬停后未出现「查看订单」按钮，按无订单处理');
    return null;
  }

  console.log('[浏览器] 点击「查看订单」');
  await orderBtn.click();
  await page.waitForTimeout(2000);

  const orders = await extractOrdersFromPopup(page);
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  } catch {}

  if (orders.length === 0) {
    console.log('[浏览器] 该评论无关联订单');
    return null;
  }

  console.log(`[浏览器] 订单: ${orders[0].orderId}`);
  return orders[0];
}

module.exports = {
  launchBrowser,
  enterLiveRoom,
  findActivePage,
  isPageUsable,
  isRecoverablePageError,
  isCommentPanelStale,
  recoverControlPanel,
  refreshControlPanelPage,
  dumpPageDOM,
  debugScanPage,
  getTransactionCount,
  getRecentComments,
  scrollAndCollectAllComments,
  getOrdersFromTab,
  extractAllOrders,
  viewOrderForComment,
  nowBeijing,
};
