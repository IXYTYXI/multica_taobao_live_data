#!/usr/bin/env node
/**
 * 定时启停安装器：自动识别 macOS / Windows，从 .env 读取时间并写入系统计划任务
 *
 * 用法:
 *   node scripts/setup-schedule.js install
 *   node scripts/setup-schedule.js uninstall
 *   node scripts/setup-schedule.js status
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const PROJECT_DIR = path.resolve(__dirname, '..');
const LOG_FILE = path.join(os.tmpdir(), 'taobao-live-schedule.log');
const MARKER_BEGIN = '# taobao-live-schedule-begin';
const MARKER_END = '# taobao-live-schedule-end';
const TASK_START = 'TaobaoLive-Start';
const TASK_STOP = 'TaobaoLive-Stop';

const schedule = {
  enabled: process.env.SCHEDULE_ENABLED !== 'false',
  startTime: (process.env.SCHEDULE_START_TIME || '08:00').trim(),
  stopTime: (process.env.SCHEDULE_STOP_TIME || '00:06').trim(),
  pm2Name: (process.env.SCHEDULE_PM2_NAME || 'taobao-live').trim(),
};

function parseTimeHHmm(value, label) {
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    throw new Error(`${label} 格式无效: "${value}"，应为 HH:mm（如 08:00、00:06）`);
  }
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour > 23 || minute > 59) {
    throw new Error(`${label} 超出范围: "${value}"`);
  }
  return { hour, minute };
}

function detectPlatform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'unsupported';
}

function scriptPaths(platform) {
  if (platform === 'macos') {
    return {
      start: path.join(PROJECT_DIR, 'scripts', 'macos', 'schedule-start.sh'),
      stop: path.join(PROJECT_DIR, 'scripts', 'macos', 'schedule-stop.sh'),
    };
  }
  return {
    start: path.join(PROJECT_DIR, 'scripts', 'windows', 'schedule-start.bat'),
    stop: path.join(PROJECT_DIR, 'scripts', 'windows', 'schedule-stop.bat'),
  };
}

function ensureScriptsExist(platform) {
  const { start, stop } = scriptPaths(platform);
  for (const p of [start, stop]) {
    if (!fs.existsSync(p)) {
      throw new Error(`找不到脚本: ${p}`);
    }
  }
  if (platform === 'macos') {
    try {
      fs.chmodSync(path.join(PROJECT_DIR, 'scripts', 'macos', 'schedule-start.sh'), 0o755);
      fs.chmodSync(path.join(PROJECT_DIR, 'scripts', 'macos', 'schedule-stop.sh'), 0o755);
    } catch {}
  }
  return { start, stop };
}

function printConfig(platform) {
  console.log('========================================');
  console.log('  淘宝直播采集 - 定时启停配置');
  console.log('========================================');
  console.log(`  平台:     ${platform}`);
  console.log(`  项目目录: ${PROJECT_DIR}`);
  console.log(`  启用:     ${schedule.enabled}`);
  console.log(`  启动时间: ${schedule.startTime}`);
  console.log(`  停止时间: ${schedule.stopTime}`);
  console.log(`  pm2 名称: ${schedule.pm2Name}`);
  console.log('========================================');
}

function installMacOS({ start, stop }) {
  const startParts = parseTimeHHmm(schedule.startTime, 'SCHEDULE_START_TIME');
  const stopParts = parseTimeHHmm(schedule.stopTime, 'SCHEDULE_STOP_TIME');

  const block = [
    MARKER_BEGIN,
    `# 由 npm run schedule:install 生成，请勿手动修改此行之间内容`,
    `${startParts.minute} ${startParts.hour} * * * ${start} >> ${LOG_FILE} 2>&1`,
    `${stopParts.minute} ${stopParts.hour} * * * ${stop} >> ${LOG_FILE} 2>&1`,
    MARKER_END,
  ].join('\n');

  let existing = '';
  try {
    existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch {
    existing = '';
  }

  const lines = existing.split('\n').filter((line) => {
    if (line.includes(MARKER_BEGIN) || line.includes(MARKER_END)) return false;
    if (line.includes('taobao-live-schedule') || line.includes('schedule-start.sh') || line.includes('schedule-stop.sh')) {
      return false;
    }
    return line.trim().length > 0;
  });

  const next = [...lines, '', block, ''].join('\n');
  execSync(`crontab -`, { input: next, encoding: 'utf8' });

  console.log('[schedule] macOS crontab 已更新');
  console.log(`[schedule] 启动: 每天 ${schedule.startTime}`);
  console.log(`[schedule] 停止: 每天 ${schedule.stopTime}`);
  console.log(`[schedule] 日志: ${LOG_FILE}`);
  console.log('[schedule] 查看: crontab -l');
}

function uninstallMacOS() {
  let existing = '';
  try {
    existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch {
    console.log('[schedule] 当前无 crontab 条目');
    return;
  }

  let inBlock = false;
  const lines = existing.split('\n').filter((line) => {
    if (line.includes(MARKER_BEGIN)) {
      inBlock = true;
      return false;
    }
    if (line.includes(MARKER_END)) {
      inBlock = false;
      return false;
    }
    if (inBlock) return false;
    if (line.includes('schedule-start.sh') || line.includes('schedule-stop.sh')) return false;
    return line.trim().length > 0;
  });

  if (lines.length === 0) {
    try {
      execSync('crontab -r 2>/dev/null');
    } catch {}
  } else {
    execSync('crontab -', { input: lines.join('\n') + '\n', encoding: 'utf8' });
  }
  console.log('[schedule] macOS crontab 已移除定时任务');
}

function statusMacOS() {
  try {
    const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    const has = existing.includes(MARKER_BEGIN);
    console.log(has ? '[schedule] 已安装（crontab 中存在 taobao-live 条目）' : '[schedule] 未安装');
    if (has) console.log(existing.split('\n').filter((l) => l.includes('schedule-') || l.includes(MARKER_BEGIN)).join('\n'));
  } catch {
    console.log('[schedule] 未安装（无 crontab）');
  }
}

function runSchtasks(args) {
  const result = spawnSync('schtasks', args, { encoding: 'utf8', shell: true });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim();
    throw new Error(msg || `schtasks 失败: ${args.join(' ')}`);
  }
  return result.stdout;
}

function installWindows({ start, stop }) {
  parseTimeHHmm(schedule.startTime, 'SCHEDULE_START_TIME');
  parseTimeHHmm(schedule.stopTime, 'SCHEDULE_STOP_TIME');

  const startTr = `"${start}"`;
  const stopTr = `"${stop}"`;

  runSchtasks([
    '/Create',
    '/TN', TASK_START,
    '/TR', startTr,
    '/SC', 'DAILY',
    '/ST', schedule.startTime,
    '/F',
  ]);

  runSchtasks([
    '/Create',
    '/TN', TASK_STOP,
    '/TR', stopTr,
    '/SC', 'DAILY',
    '/ST', schedule.stopTime,
    '/F',
  ]);

  console.log('[schedule] Windows 任务计划已创建/更新');
  console.log(`[schedule] 启动任务: ${TASK_START}  每天 ${schedule.startTime}`);
  console.log(`[schedule] 停止任务: ${TASK_STOP}  每天 ${schedule.stopTime}`);
  console.log('[schedule] 查看: 任务计划程序，或 schtasks /Query /TN TaobaoLive-Start');
}

function uninstallWindows() {
  for (const name of [TASK_START, TASK_STOP]) {
    try {
      runSchtasks(['/Delete', '/TN', name, '/F']);
      console.log(`[schedule] 已删除任务: ${name}`);
    } catch (e) {
      console.log(`[schedule] 任务不存在或已删除: ${name}`);
    }
  }
}

function statusWindows() {
  for (const name of [TASK_START, TASK_STOP]) {
    try {
      const out = execSync(`schtasks /Query /TN "${name}" /FO LIST /V`, { encoding: 'utf8' });
      const next = out.split('\n').find((l) => l.includes('下次运行时间') || l.includes('Next Run Time'));
      console.log(`[schedule] ${name}: 已安装${next ? ` (${next.trim()})` : ''}`);
    } catch {
      console.log(`[schedule] ${name}: 未安装`);
    }
  }
}

function main() {
  const action = (process.argv[2] || 'install').toLowerCase();
  const platform = detectPlatform();

  if (platform === 'unsupported') {
    console.error(`[schedule] 不支持的操作系统: ${process.platform}，仅支持 macOS 与 Windows`);
    process.exit(1);
  }

  printConfig(platform);

  if (action === 'status') {
    if (platform === 'macos') statusMacOS();
    else statusWindows();
    return;
  }

  if (action === 'uninstall') {
    if (platform === 'macos') uninstallMacOS();
    else uninstallWindows();
    return;
  }

  if (action !== 'install') {
    console.error('用法: node scripts/setup-schedule.js [install|uninstall|status]');
    process.exit(1);
  }

  if (!schedule.enabled) {
    console.log('[schedule] SCHEDULE_ENABLED=false，跳过安装。若要启用请在 .env 中设置 SCHEDULE_ENABLED=true');
    process.exit(0);
  }

  const scripts = ensureScriptsExist(platform);

  // 将 pm2 名称写入环境，供 shell 脚本读取（可选增强）
  process.env.SCHEDULE_PM2_NAME = schedule.pm2Name;

  console.log('[schedule] 请先确保已执行: npm install -g pm2 && pm2 start npm --name taobao-live -- start');
  console.log('[schedule] 正在写入系统计划任务...\n');

  if (platform === 'macos') installMacOS(scripts);
  else installWindows(scripts);

  console.log('\n[schedule] 完成。修改时间后重新执行: npm run schedule:install');
}

try {
  main();
} catch (e) {
  console.error('[schedule] 失败:', e.message);
  process.exit(1);
}
