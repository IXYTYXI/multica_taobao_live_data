/**
 * 端到端流程测试 — 逐步走完登录→直播列表→中控台
 * 每一步截图并打印页面信息，用于调试选择器
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const { nowBeijing } = require('./src/browser');

const LIVE_LIST_URL = 'https://liveplatform.taobao.com/restful/index/live/list';

async function main() {
  console.log('=== 端到端流程测试 ===');
  console.log('北京时间:', nowBeijing().format('YYYY-MM-DD HH:mm:ss'));
  console.log('');

  const localDataDir = path.resolve(__dirname, 'chrome-data');
  if (!fs.existsSync(localDataDir)) {
    fs.mkdirSync(localDataDir, { recursive: true });
  }

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

  try {
    // Step 1: 检查是否已有登录态
    console.log('[Step 1] 检查登录态...');
    const cookies = await context.cookies('https://taobao.com');
    const loginCookies = cookies.filter(c =>
      c.name === 'login' || c.name === '_tb_token_' || c.name === 'munb' || c.name === 'sgcookie'
    );
    console.log('  淘宝 cookie 数:', cookies.length);
    console.log('  登录相关 cookie:', loginCookies.map(c => `${c.name}=${c.value.substring(0, 20)}...`).join(', ') || '无');

    if (loginCookies.length === 0) {
      // 需要登录
      console.log('\n[Step 1b] 未检测到登录态，打开登录页...');
      await page.goto('https://login.taobao.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('  ⏳ 请在浏览器中登录淘宝（5分钟超时）...');

      const startTime = Date.now();
      while (Date.now() - startTime < 300000) {
        const url = page.url();
        if (!url.includes('login.taobao.com') && !url.includes('login.tmall.com') && !url.includes('about:blank')) {
          console.log('  ✅ 页面已跳转，登录成功');
          break;
        }
        const ck = await context.cookies('https://taobao.com');
        if (ck.some(c => c.name === '_tb_token_' || c.name === 'munb' || c.name === 'sgcookie')) {
          console.log('  ✅ 检测到登录 cookie');
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    } else {
      console.log('  ✓ 已有登录态');
    }

    // Step 2: 导航到直播列表
    console.log('\n[Step 2] 导航到直播列表页面...');
    console.log('  URL:', LIVE_LIST_URL);
    await page.goto(LIVE_LIST_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(5000); // 多等一会让页面完全渲染

    const currentUrl = page.url();
    console.log('  当前 URL:', currentUrl);

    // 检查是否被重定向到登录页
    if (currentUrl.includes('login')) {
      console.log('  ⚠ 被重定向到登录页面！登录态可能未生效。');
      console.log('  请在浏览器中手动登录后，我会自动继续...');

      // 等待用户在当前页面登录
      const startTime = Date.now();
      while (Date.now() - startTime < 300000) {
        const url = page.url();
        if (!url.includes('login')) {
          console.log('  ✅ 登录成功，继续...');
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      // 登录后重新导航
      await page.goto(LIVE_LIST_URL, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(5000);
      console.log('  重新导航后 URL:', page.url());
    }

    await page.screenshot({ path: 'debug-step2-list.png', fullPage: true });
    console.log('  截图: debug-step2-list.png');

    // 打印页面标题
    const title = await page.title();
    console.log('  页面标题:', title);

    // 打印可见文本（过滤掉 script/style）
    const visibleText = await page.evaluate(() => {
      const body = document.body;
      if (!body) return '';
      const clone = body.cloneNode(true);
      clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
      return clone.textContent?.replace(/\s+/g, ' ').trim().substring(0, 2000) || '';
    });
    console.log('  页面可见文本:', visibleText.substring(0, 500));

    // Step 3: 查找直播场次
    console.log('\n[Step 3] 查找直播场次...');

    // 打印所有链接
    const allLinks = await page.$$eval('a', anchors =>
      anchors.map(a => ({
        href: a.href,
        text: a.textContent?.trim()?.substring(0, 80),
        visible: a.offsetParent !== null,
      })).filter(l => l.text && l.text.length > 0)
    );
    console.log('  页面链接数:', allLinks.length);
    for (const link of allLinks.slice(0, 30)) {
      console.log(`    ${link.visible ? '👁' : '  '} "${link.text}" -> ${link.href}`);
    }

    // 查找"直播中"相关元素
    const liveElements = await page.$$eval('*', els =>
      els.filter(el => {
        const text = el.textContent?.trim();
        return text && (text.includes('直播中') || text.includes('直播详情'));
      }).map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim()?.substring(0, 100),
        className: typeof el.className === 'string' ? el.className.substring(0, 80) : '',
      })).slice(0, 20)
    );
    console.log('\n  包含"直播中/直播详情"的元素:');
    for (const el of liveElements) {
      console.log(`    <${el.tag} class="${el.className}"> ${el.text}`);
    }

    // 查找按钮
    const buttons = await page.$$eval('button, a[role="button"], [class*="btn"]', els =>
      els.map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim()?.substring(0, 60),
        className: typeof el.className === 'string' ? el.className.substring(0, 80) : '',
        href: el.href || '',
      })).filter(b => b.text).slice(0, 20)
    );
    console.log('\n  按钮元素:');
    for (const b of buttons) {
      console.log(`    <${b.tag} class="${b.className}"> "${b.text}" ${b.href}`);
    }

    // Step 4: 尝试找到并点击直播详情
    console.log('\n[Step 4] 尝试进入中控台...');

    // 检查是否有 iframe
    const frames = page.frames();
    console.log('  页面 frame 数:', frames.length);
    for (const frame of frames) {
      console.log(`    frame: ${frame.url()}`);
    }

    // 尝试查找直播中的场次
    let foundEntry = false;

    // 方法1: 直接文本匹配
    const detailBtn = await page.$('text=直播详情');
    if (detailBtn) {
      console.log('  ✓ 找到"直播详情"按钮');
      await detailBtn.click();
      await page.waitForTimeout(5000);
      foundEntry = true;
    }

    if (!foundEntry) {
      // 方法2: 查找表格行中的操作按钮
      const rows = await page.$$('tr, [class*="row"], [class*="item"], [class*="card"]');
      console.log(`  查找行元素: ${rows.length} 个`);
      for (const row of rows) {
        const rowText = await row.textContent();
        if (rowText && rowText.includes('直播中')) {
          console.log('  ✓ 找到包含"直播中"的行');
          const links = await row.$$('a');
          for (const link of links) {
            const linkText = await link.textContent();
            console.log(`    行内链接: "${linkText?.trim()}"`);
            if (linkText?.includes('详情') || linkText?.includes('进入')) {
              await link.click();
              await page.waitForTimeout(5000);
              foundEntry = true;
              break;
            }
          }
          if (foundEntry) break;

          // 如果没找到链接，试试按钮
          const btns = await row.$$('button');
          for (const btn of btns) {
            const btnText = await btn.textContent();
            console.log(`    行内按钮: "${btnText?.trim()}"`);
          }
          break;
        }
      }
    }

    if (foundEntry) {
      await page.screenshot({ path: 'debug-step4-control.png', fullPage: true });
      console.log('  进入后截图: debug-step4-control.png');
      console.log('  当前 URL:', page.url());

      // 分析中控台页面
      const ctrlText = await page.evaluate(() => {
        const body = document.body;
        if (!body) return '';
        const clone = body.cloneNode(true);
        clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
        return clone.textContent?.replace(/\s+/g, ' ').trim().substring(0, 3000) || '';
      });
      console.log('  中控台文本:', ctrlText.substring(0, 500));
    } else {
      console.log('  ✗ 未能找到直播入口（当前可能没有直播中的场次）');
    }

    console.log('\n=== 测试完成 ===');
    console.log('按 Ctrl+C 关闭浏览器');

    // 保持浏览器打开让用户检查
    await new Promise(r => setTimeout(r, 30000));

  } catch (e) {
    console.error('异常:', e.message);
    await page.screenshot({ path: 'debug-error.png', fullPage: true });
  } finally {
    await context.close();
  }
}

main();
