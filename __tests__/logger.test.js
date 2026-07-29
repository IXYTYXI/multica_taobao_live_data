const fs = require('fs');
const path = require('path');
const os = require('os');

describe('logger cleanupOldLogs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taobao-log-'));
    process.env.LOG_DIR = tmpDir;
    process.env.LOG_RETENTION_DAYS = '30';
    process.env.LOG_TO_FILE = 'true';
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.LOG_DIR;
    delete process.env.LOG_RETENTION_DAYS;
    delete process.env.LOG_TO_FILE;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test('删除超过保留期的按日日志文件', () => {
    const oldName = 'taobao-live-2020-01-01.log';
    const recentName = 'taobao-live-2099-01-01.log';
    fs.writeFileSync(path.join(tmpDir, oldName), 'old\n');
    fs.writeFileSync(path.join(tmpDir, recentName), 'recent\n');
    fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'skip\n');

    const { cleanupOldLogs } = require('../src/logger');
    const { removed } = cleanupOldLogs();

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, oldName))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, recentName))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'other.txt'))).toBe(true);
  });
});
