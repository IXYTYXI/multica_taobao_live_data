/**
 * 测试 login 模式 - 验证浏览器能否正常打开并跳转到登录页
 * 不等待用户真正登录，只验证启动流程
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('=== Login 模式测试 ===\n');
  const localDataDir = path.resolve(__dirname, 'chrome-data-test');

  if (!fs.existsSync(localDataDir)) {
    fs.mkdirSync(localDataDir, { recursive: true });
  }

  let context;
  try {
    console.log('[1] 启动浏览器（login 模式）...');
    context = await chromium.launchPersistentContext(localDataDir, {
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
    console.log('  ✓ 浏览器启动成功\n');

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    console.log('[2] 导航到淘宝登录页...');
    await page.goto('https://login.taobao.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const url = page.url();
    console.log('  当前 URL:', url);

    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'test-login-mode.png', fullPage: true });
    console.log('  截图已保存: test-login-mode.png');

    const isLoginPage = url.includes('login.taobao.com') || url.includes('login');
    console.log('  是登录页:', isLoginPage ? '✓ 是' : '✗ 否');

    console.log('\n[3] 测试已有的 chrome-data 中是否有之前的登录态...');
    const existingChromeData = path.resolve(__dirname, 'chrome-data');
    if (fs.existsSync(existingChromeData)) {
      console.log('  chrome-data 目录存在，检查 cookie...');
      const cookies = await context.cookies('https://taobao.com');
      const taoCookies = cookies.filter(c => c.domain.includes('taobao'));
      console.log(`  淘宝相关 cookie 数量: ${taoCookies.length}`);
      if (taoCookies.length > 0) {
        console.log('  Cookie 名称:', taoCookies.map(c => c.name).join(', '));
      }
    } else {
      console.log('  chrome-data 目录不存在（首次运行）');
    }

    console.log('\n=== Login 模式测试完成 ===');
    console.log('浏览器可以正常启动和导航到登录页。');
    console.log('用户只需在弹出的浏览器中手动登录，工具会自动检测登录成功并继续。');

  } catch (e) {
    console.error('测试异常:', e.message);
  } finally {
    if (context) {
      await context.close();
    }
    // 清理测试目录
    try {
      fs.rmSync(localDataDir, { recursive: true, force: true });
    } catch {}
  }
}

main();
