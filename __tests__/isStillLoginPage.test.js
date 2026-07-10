/**
 * isStillLoginPage 逻辑单元测试
 * 使用 mock page 对象模拟 Playwright 页面
 */

// 复现 browser.js 中 isStillLoginPage 的核心逻辑
async function isStillLoginPage(page) {
  try {
    const url = page.url();
    if (url.includes('login.taobao.com') || url.includes('login.tmall.com')) {
      return true;
    }
    const result = await page.evaluate(() => {});
    if (result.hasLoginForm || result.hasLoginTitle || result.hasLoginCSS) {
      if (!result.hasLiveContent) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function createMockPage(url, evaluateResult) {
  return {
    url: () => url,
    evaluate: jest.fn().mockResolvedValue(evaluateResult),
  };
}

describe('isStillLoginPage', () => {
  test('login.taobao.com URL → 是登录页', async () => {
    const page = createMockPage('https://login.taobao.com/member/login.jhtml', {});
    expect(await isStillLoginPage(page)).toBe(true);
  });

  test('login.tmall.com URL → 是登录页', async () => {
    const page = createMockPage('https://login.tmall.com/login', {});
    expect(await isStillLoginPage(page)).toBe(true);
  });

  test('liveplatform URL + 有登录表单 + 无直播内容 → 是登录页', async () => {
    const page = createMockPage('https://liveplatform.taobao.com/restful/index/live/list', {
      hasLoginForm: true,
      hasLoginTitle: false,
      hasLoginCSS: false,
      hasLiveContent: false,
    });
    expect(await isStillLoginPage(page)).toBe(true);
  });

  test('liveplatform URL + 有登录标题 + 无直播内容 → 是登录页', async () => {
    const page = createMockPage('https://liveplatform.taobao.com/', {
      hasLoginForm: false,
      hasLoginTitle: true,
      hasLoginCSS: false,
      hasLiveContent: false,
    });
    expect(await isStillLoginPage(page)).toBe(true);
  });

  test('liveplatform URL + 有登录 CSS + 无直播内容 → 是登录页', async () => {
    const page = createMockPage('https://liveplatform.taobao.com/', {
      hasLoginForm: false,
      hasLoginTitle: false,
      hasLoginCSS: true,
      hasLiveContent: false,
    });
    expect(await isStillLoginPage(page)).toBe(true);
  });

  test('liveplatform URL + 有登录表单 + 有直播内容 → 不是登录页（重定向中间态）', async () => {
    const page = createMockPage('https://liveplatform.taobao.com/', {
      hasLoginForm: true,
      hasLoginTitle: false,
      hasLoginCSS: false,
      hasLiveContent: true,
    });
    expect(await isStillLoginPage(page)).toBe(false);
  });

  test('liveplatform URL + 无登录特征 → 不是登录页', async () => {
    const page = createMockPage('https://liveplatform.taobao.com/restful/index/live/list', {
      hasLoginForm: false,
      hasLoginTitle: false,
      hasLoginCSS: false,
      hasLiveContent: true,
    });
    expect(await isStillLoginPage(page)).toBe(false);
  });

  test('evaluate 抛异常（页面导航中）→ 视为登录页', async () => {
    const page = {
      url: () => 'about:blank',
      evaluate: jest.fn().mockRejectedValue(new Error('Navigation interrupted')),
    };
    expect(await isStillLoginPage(page)).toBe(true);
  });

  test('普通 taobao.com 页面 + 无登录特征 → 不是登录页', async () => {
    const page = createMockPage('https://www.taobao.com/', {
      hasLoginForm: false,
      hasLoginTitle: false,
      hasLoginCSS: false,
      hasLiveContent: false,
    });
    expect(await isStillLoginPage(page)).toBe(false);
  });
});
