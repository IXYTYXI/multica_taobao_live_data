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
 * 多策略提取：
 *   1. 元素级 textContent 扫描（主策略 — 处理文本分散在多个子元素的情况）
 *   2. TreeWalker 文本节点扫描（补充 — 处理文本在单个节点的情况）
 *   3. 自动检测并使用正确的 frame（处理 iframe 场景）
 *
 * 每轮都输出诊断日志，方便排查问题。
 */
async function getRecentComments(page, withinMinutes) {
  const cutoff = nowBeijing().subtract(withinMinutes, 'minute');
  console.log(`[浏览器] 获取 ${cutoff.format('HH:mm:ss')} 之后的评论...`);

  const frame = await getContentFrame(page);
  await clickCommentTab(page, '全部');

  const comments = [];

  try {
    const rawComments = await frame.evaluate(() => {
      const results = [];
      const seen = new Set();
      // 支持半角()和全角（）
      const headerRegex = /(.+?)[\(（]([^)）]+)[\)）]\s*(\d{1,2}:\d{2}(?::\d{2})?)/;

      const debug = {
        strategy: 'none',
        elementsScanCount: 0,
        timePatternCount: 0,
        headerMatchCount: 0,
        contentFoundCount: 0,
        treewalkerMatchCount: 0,
      };

      // ── 策略1: 元素 textContent 扫描 ──
      // 这是主策略：el.textContent 会自动拼接所有子节点的文本，
      // 所以即使昵称、ID、时间在不同的 <span> 中也能匹配到
      const allElements = document.querySelectorAll('div, span, li, p, a, td');
      for (const el of allElements) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.left > window.innerWidth * 0.6) continue;
        // 跳过非常大的容器（包含多条评论的面板）
        if (rect.height > 200) continue;
        if (rect.height < 8) continue;

        debug.elementsScanCount++;

        const text = el.textContent?.trim();
        if (!text || text.length < 5) continue;

        // 快速过滤：必须包含时间模式
        if (!/\d{1,2}:\d{2}/.test(text)) continue;
        debug.timePatternCount++;

        // 跳过子元素过多的容器
        const childCount = el.querySelectorAll('div, span, li, p').length;
        if (childCount > 15) continue;
        if (text.length > 500) continue;

        const m = text.match(headerRegex);
        if (!m) continue;
        debug.headerMatchCount++;

        const [fullMatch, nickname, userId, timeStr] = m;
        const hour = parseInt(timeStr.split(':')[0], 10);
        if (hour > 23) continue;
        if (nickname.includes('AI助理') || nickname.includes('问答助手')) continue;
        if (nickname.includes('系统消息') || nickname.includes('管理员')) continue;

        // 提取评论内容
        let content = '';

        // 方法A: 全匹配之后、同元素内的剩余文本
        const afterIdx = text.indexOf(fullMatch);
        if (afterIdx >= 0) {
          const afterText = text.substring(afterIdx + fullMatch.length).trim();
          if (afterText) {
            // 取第一行，排除后续评论的头部
            const lines = afterText.split(/[\n\r]+/);
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed && !headerRegex.test(trimmed)) {
                content = trimmed;
                break;
              }
            }
          }
        }

        // 方法B: 当前元素的下一个兄弟元素
        if (!content) {
          const nextSib = el.nextElementSibling;
          if (nextSib) {
            const sibText = nextSib.textContent?.trim();
            if (sibText && sibText.length < 300 && !headerRegex.test(sibText)) {
              content = sibText.split(/[\n\r]+/)[0].trim();
            }
          }
        }

        // 方法C: 父元素中，当前元素之后的下一个子元素
        if (!content && el.parentElement) {
          let foundEl = false;
          for (const child of el.parentElement.children) {
            if (child === el || child.contains(el)) { foundEl = true; continue; }
            if (foundEl) {
              const childText = child.textContent?.trim();
              if (childText && childText.length < 300 && !headerRegex.test(childText)) {
                content = childText.split(/[\n\r]+/)[0].trim();
                break;
              }
            }
          }
        }

        // 方法D: 向上找父容器，取父容器中本头部之后的文本
        if (!content) {
          for (let parent = el.parentElement; parent && !content; parent = parent.parentElement) {
            const pr = parent.getBoundingClientRect();
            if (pr.height > 150) break;
            let foundEl = false;
            for (const child of parent.children) {
              if (child === el || child.contains(el)) { foundEl = true; continue; }
              if (foundEl) {
                const childText = child.textContent?.trim();
                if (childText && childText.length < 300 && !headerRegex.test(childText)) {
                  content = childText.split(/[\n\r]+/)[0].trim();
                  break;
                }
              }
            }
          }
        }

        if (!content) continue;
        if (content.startsWith('私密回复')) continue;
        debug.contentFoundCount++;

        const key = `${nickname.trim()}_${userId}_${timeStr}_${content}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          nickname: nickname.trim(),
          userId: userId.trim(),
          timeStr,
          content,
        });
      }

      if (results.length > 0) {
        debug.strategy = 'element-scan';
      }

      // ── 策略2: TreeWalker 文本节点扫描（回退） ──
      if (results.length === 0) {
        const walker = document.createTreeWalker(
          document.body, NodeFilter.SHOW_TEXT, null
        );
        while (walker.nextNode()) {
          const nodeText = walker.currentNode.textContent.trim();
          if (!nodeText || nodeText.length < 5 || nodeText.length > 200) continue;

          const match = nodeText.match(headerRegex);
          if (!match) continue;
          debug.treewalkerMatchCount++;

          const [fullMatch, nickname, userId, timeStr] = match;
          const hour = parseInt(timeStr.split(':')[0], 10);
          if (hour > 23) continue;
          if (nickname.includes('AI助理') || nickname.includes('问答助手')) continue;

          const headerEl = walker.currentNode.parentElement;
          if (!headerEl) continue;

          const rect = headerEl.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.left > window.innerWidth * 0.6) continue;

          let content = '';

          // 时间之后同一文本节点中的内容
          const afterTime = nodeText.substring(nodeText.indexOf(timeStr) + timeStr.length).trim();
          if (afterTime) {
            content = afterTime.split(/[\n\r]+/)[0].trim();
          }

          // 下一个兄弟元素
          if (!content) {
            const nextSib = headerEl.nextElementSibling;
            if (nextSib) {
              const sibText = nextSib.textContent?.trim();
              if (sibText && sibText.length < 300 && !sibText.match(headerRegex)) {
                content = sibText.split(/[\n\r]+/)[0].trim();
              }
            }
          }

          // 父容器的下一个子元素
          if (!content && headerEl.parentElement) {
            let foundHeader = false;
            for (const child of headerEl.parentElement.children) {
              if (child === headerEl) { foundHeader = true; continue; }
              if (foundHeader) {
                const childText = child.textContent?.trim();
                if (childText && childText.length < 300 && !childText.match(headerRegex)) {
                  content = childText.split(/[\n\r]+/)[0].trim();
                  break;
                }
              }
            }
          }

          if (!content) continue;
          if (content.startsWith('私密回复')) continue;

          const key = `${nickname.trim()}_${userId}_${timeStr}_${content}`;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            nickname: nickname.trim(),
            userId: userId.trim(),
            timeStr,
            content,
          });
        }

        if (results.length > 0) {
          debug.strategy = 'treewalker';
        }
      }

      return { results, debug };
    });

    // 输出诊断日志
    const d = rawComments.debug;
    console.log(`[浏览器] 评论扫描诊断: strategy=${d.strategy}, elements=${d.elementsScanCount}, timePat=${d.timePatternCount}, headerMatch=${d.headerMatchCount}, contentFound=${d.contentFoundCount}, treewalker=${d.treewalkerMatchCount}`);
    console.log(`[浏览器] 原始评论数: ${rawComments.results.length}`);

    if (rawComments.results.length === 0) {
      // 额外诊断：保存当前页面快照以便调试
      try {
        const dumpDir = path.resolve(__dirname, '..', 'data');
        const scanResult = await debugScanPage(page);
        fs.writeFileSync(
          path.join(dumpDir, 'debug-scan-live.json'),
          JSON.stringify(scanResult, null, 2), 'utf8'
        );
        console.log('[浏览器] 未找到评论，已保存实时诊断到 data/debug-scan-live.json');
      } catch {}
    }

    for (const c of rawComments.results) {
      const commentTime = parseCommentTime(c.timeStr);
      if (!commentTime.isValid() || !commentTime.isAfter(cutoff)) continue;

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
  return { comments, error: null };
}

/**
 * 切换到"已下单"标签页获取下单记录，然后切回"全部"
 * 使用元素 textContent + TreeWalker 双策略，支持 iframe
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

      // 策略1: 元素 textContent 扫描（主策略）
      for (const el of document.querySelectorAll('div, span, li, p, a')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.left > window.innerWidth * 0.6) continue;
        if (rect.height > 200 || rect.height < 8) continue;

        const text = el.textContent?.trim();
        if (!text || text.length < 5 || text.length > 500) continue;
        if (!/\d{1,2}:\d{2}/.test(text)) continue;
        if (el.querySelectorAll('div, span, li, p').length > 15) continue;

        const m = text.match(headerRegex);
        if (!m) continue;

        const [, nickname, userId, timeStr] = m;
        const hour = parseInt(timeStr.split(':')[0], 10);
        if (hour > 23) continue;
        if (nickname.includes('AI助理') || nickname.includes('问答助手')) continue;

        const key = `${nickname.trim()}_${userId}_${timeStr}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          nickname: nickname.trim(),
          userId: userId.trim(),
          timeStr,
        });
      }

      // 策略2: TreeWalker 回退
      if (results.length === 0) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
          const nodeText = walker.currentNode.textContent.trim();
          if (!nodeText || nodeText.length < 5 || nodeText.length > 200) continue;
          const match = nodeText.match(headerRegex);
          if (!match) continue;

          const [, nickname, userId, timeStr] = match;
          const hour = parseInt(timeStr.split(':')[0], 10);
          if (hour > 23) continue;
          if (nickname.includes('AI助理') || nickname.includes('问答助手')) continue;

          const headerEl = walker.currentNode.parentElement;
          if (!headerEl) continue;
          const rect = headerEl.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.left > window.innerWidth * 0.6) continue;

          const key = `${nickname.trim()}_${userId}_${timeStr}`;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({ nickname: nickname.trim(), userId: userId.trim(), timeStr });
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
 * 从"全部"标签中找到"查看订单"入口并提取订单数据
 *
 * 用户反馈：需要在"全部"标签的评论数据右侧找到"查看订单"按钮。
 * 策略：
 *   1. 直接搜索页面上可见的"查看订单"（不限制左右位置）
 *   2. 悬停"已下单"评论条目，在其右侧查找悬停后出现的"查看订单"
 *   3. 点击后从弹出的订单详情中提取数据
 */
async function extractAllOrders(page) {
  const frame = await getContentFrame(page);
  try {
    // 确保在"全部"标签（用户说"查看订单"在全部数据的评论右侧）
    await clickCommentTab(page, '全部');
    await page.waitForTimeout(500);

    // ── 第1步：直接搜索"查看订单"（不过滤位置——按钮在评论数据右侧）──
    const directBtn = await frame.evaluate(() => {
      const keywords = ['查看订单', '查看全部订单', '订单详情'];
      const candidates = [];

      // TreeWalker 搜索文本
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent.trim();
        if (!keywords.includes(text)) continue;
        const el = walker.currentNode.parentElement;
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width > 500 || rect.height > 100) continue;
        candidates.push({
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          text,
          area: rect.width * rect.height,
        });
      }

      // 搜索 title/aria-label 属性
      for (const el of document.querySelectorAll('[title*="查看订单"], [aria-label*="查看订单"], [title*="订单"], [aria-label*="订单"]')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width > 300 || rect.height > 80) continue;
        const attrText = el.getAttribute('title') || el.getAttribute('aria-label') || '';
        if (!candidates.some(c => Math.abs(c.x - (rect.x + rect.width / 2)) < 5 &&
                                   Math.abs(c.y - (rect.y + rect.height / 2)) < 5)) {
          candidates.push({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            text: attrText,
            area: rect.width * rect.height,
          });
        }
      }

      // 搜索小型可点击元素中包含"订单"的（按钮、链接、图标）
      for (const el of document.querySelectorAll('a, button, [role="button"], svg')) {
        const text = el.textContent?.trim() || el.getAttribute('title') || '';
        if (!text.includes('订单')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width > 200 || rect.height > 60) continue;
        if (!candidates.some(c => Math.abs(c.x - (rect.x + rect.width / 2)) < 5 &&
                                   Math.abs(c.y - (rect.y + rect.height / 2)) < 5)) {
          candidates.push({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            text,
            area: rect.width * rect.height,
          });
        }
      }

      candidates.sort((a, b) => a.area - b.area);
      return candidates.length > 0 ? candidates[0] : null;
    });

    if (directBtn) {
      console.log(`[浏览器] 找到订单入口: "${directBtn.text}" (${directBtn.x.toFixed(0)}, ${directBtn.y.toFixed(0)})`);
      await page.mouse.click(directBtn.x, directBtn.y);
      await page.waitForTimeout(2000);

      const orders = await extractOrdersFromPopup(page);
      try { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } catch {}

      if (orders.length > 0) {
        console.log(`[浏览器] 从订单弹窗提取到 ${orders.length} 条订单`);
        return orders;
      }
      console.log('[浏览器] 点击后未能提取到订单数据，尝试悬停方式...');
    }

    // ── 第2步：悬停"已下单"条目，在其右侧寻找"查看订单" ──
    console.log('[浏览器] 查找"已下单"条目进行悬停...');

    const entryPositions = await frame.evaluate(() => {
      const positions = [];
      const seen = new Set();

      // 用 TreeWalker 找"已下单"文本
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent.trim();
        if (text !== '已下单') continue;
        const el = walker.currentNode.parentElement;
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        // 向上找条目容器（高度30-120px的父元素）
        let container = el;
        for (let i = 0; i < 5; i++) {
          if (!container.parentElement) break;
          const pr = container.parentElement.getBoundingClientRect();
          if (pr.height >= 30 && pr.height <= 150 && pr.width > 100) {
            container = container.parentElement;
          } else if (pr.height > 150) {
            break;
          }
        }

        const cr = container.getBoundingClientRect();
        const key = `${Math.round(cr.y)}_${Math.round(cr.x)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        positions.push({
          centerX: cr.x + cr.width / 2,
          centerY: cr.y + cr.height / 2,
          rightX: cr.right - 20,
          top: cr.top,
          bottom: cr.bottom,
        });
      }

      return positions;
    });

    console.log(`[浏览器] 找到 ${entryPositions.length} 个"已下单"条目`);

    const allOrders = [];
    for (const pos of entryPositions.slice(0, 8)) {
      // 悬停在条目中央
      await page.mouse.move(pos.centerX, pos.centerY);
      await page.waitForTimeout(600);

      // 再悬停到条目右侧（"查看订单"可能在右侧边缘）
      await page.mouse.move(pos.rightX, pos.centerY);
      await page.waitForTimeout(600);

      // 搜索悬停后出现的"查看订单"
      const hoverBtn = await frame.evaluate((entryY) => {
        const keywords = ['查看订单', '查看', '订单详情', '订单'];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        const candidates = [];

        while (walker.nextNode()) {
          const text = walker.currentNode.textContent.trim();
          if (!keywords.includes(text)) continue;
          const el = walker.currentNode.parentElement;
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.width > 300 || rect.height > 60) continue;
          const yDist = Math.abs(rect.y + rect.height / 2 - entryY);
          if (yDist > 80) continue;
          candidates.push({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            text,
            yDist,
            area: rect.width * rect.height,
          });
        }

        // 也搜索 title/aria-label
        for (const el of document.querySelectorAll('[title*="订单"], [aria-label*="订单"]')) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.width > 200 || rect.height > 60) continue;
          const yDist = Math.abs(rect.y + rect.height / 2 - entryY);
          if (yDist > 80) continue;
          const attrText = el.getAttribute('title') || el.getAttribute('aria-label') || '';
          candidates.push({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            text: attrText,
            yDist,
            area: rect.width * rect.height,
          });
        }

        if (candidates.length === 0) return null;
        // 优先最近 + 最小面积
        candidates.sort((a, b) => (a.yDist - b.yDist) || (a.area - b.area));
        return candidates[0];
      }, pos.centerY);

      if (!hoverBtn) continue;

      console.log(`[浏览器] 悬停后找到"${hoverBtn.text}"`);
      await page.mouse.click(hoverBtn.x, hoverBtn.y);
      await page.waitForTimeout(2000);

      const orders = await extractOrdersFromPopup(page);
      try { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } catch {}

      if (orders.length > 0) {
        allOrders.push(...orders);
        // 如果是全量订单弹窗（多条），不需要逐条悬停
        if (orders.length > 1) {
          console.log(`[浏览器] 获取到全量订单 ${orders.length} 条，停止逐条悬停`);
          break;
        }
      }
    }

    console.log(`[浏览器] 共提取到 ${allOrders.length} 条订单`);
    return allOrders;
  } catch (e) {
    console.error('[浏览器] 提取订单异常:', e.message);
    try { await page.keyboard.press('Escape'); } catch {}
    return [];
  }
}

module.exports = {
  launchBrowser,
  enterLiveRoom,
  dumpPageDOM,
  debugScanPage,
  getTransactionCount,
  getRecentComments,
  getOrdersFromTab,
  extractAllOrders,
  nowBeijing,
};
