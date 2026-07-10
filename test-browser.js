/**
 * 浏览器端到端测试
 * 使用 profile 模式启动浏览器，导航到淘宝直播列表页面，
 * 验证登录态是否有效，并截图留证。
 */
const { launchBrowser, enterLiveRoom, nowBeijing } = require('./src/browser');
const fs = require('fs');

async function main() {
  console.log('=== 浏览器端到端测试 ===');
  console.log('当前北京时间:', nowBeijing().format('YYYY-MM-DD HH:mm:ss'));
  console.log('');

  let context, page;
  try {
    // 1. 启动浏览器
    console.log('[1] 启动浏览器（profile 模式）...');
    const result = await launchBrowser();
    context = result.context;
    page = result.page;
    console.log('  ✓ 浏览器启动成功\n');

    // 2. 导航到淘宝直播列表
    console.log('[2] 导航到淘宝直播列表页面...');
    await page.goto('https://liveplatform.taobao.com/restful/index/live/list', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const url = page.url();
    console.log('  当前 URL:', url);

    // 3. 检查是否需要登录
    if (url.includes('login') || url.includes('sign')) {
      console.log('  ✗ 被重定向到登录页 — 登录态未继承成功');
      console.log('  建议切换到 BROWSER_MODE=login 手动登录\n');

      // 截图
      await page.screenshot({ path: 'test-login-page.png', fullPage: true });
      console.log('  截图已保存: test-login-page.png');
    } else {
      console.log('  ✓ 未被重定向到登录页\n');

      // 4. 检查页面内容
      console.log('[3] 分析页面内容...');
      const bodyText = await page.textContent('body');
      const trimmedText = bodyText?.replace(/\s+/g, ' ').substring(0, 1000);
      console.log('  页面文本 (前1000字):', trimmedText);

      // 检查是否有直播相关内容
      const hasLiveContent = bodyText?.includes('直播') || bodyText?.includes('场次');
      const hasLivingSession = bodyText?.includes('直播中');

      console.log('');
      console.log('  包含"直播"关键词:', hasLiveContent ? '✓ 是' : '✗ 否');
      console.log('  有"直播中"的场次:', hasLivingSession ? '✓ 是' : '✗ 否');

      // 截图
      await page.screenshot({ path: 'test-live-list.png', fullPage: true });
      console.log('\n  截图已保存: test-live-list.png');

      // 5. 如果有直播中的场次，尝试进入中控台
      if (hasLivingSession) {
        console.log('\n[4] 尝试进入直播中控台...');
        const entered = await enterLiveRoom(page);
        if (entered) {
          console.log('  ✓ 成功进入中控台');
          await page.waitForTimeout(3000);
          await page.screenshot({ path: 'test-control-panel.png', fullPage: true });
          console.log('  截图已保存: test-control-panel.png');

          // 检查中控台内容
          const controlText = await page.textContent('body');
          const hasTransaction = controlText?.includes('成交人数') || controlText?.includes('成交');
          const hasInteraction = controlText?.includes('互动') || controlText?.includes('评论');
          console.log('  中控台包含"成交":', hasTransaction ? '✓' : '✗');
          console.log('  中控台包含"互动/评论":', hasInteraction ? '✓' : '✗');
        } else {
          console.log('  ✗ 未能进入中控台（可能当前没有直播场次）');
        }
      } else {
        console.log('\n[4] 当前没有直播中的场次，跳过中控台测试');
      }
    }

    console.log('\n=== 测试完成 ===');
  } catch (e) {
    console.error('测试异常:', e.message);
    console.error(e.stack);
    if (page) {
      try {
        await page.screenshot({ path: 'test-error.png', fullPage: true });
        console.log('错误截图已保存: test-error.png');
      } catch {}
    }
  } finally {
    // 关闭浏览器
    if (context) {
      try {
        await context.close();
      } catch {}
    }
  }
}

main();
