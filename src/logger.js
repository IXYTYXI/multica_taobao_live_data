/**
 * 文件日志：桥接 console，按北京时间按天写入 logs/，启动时清理超过保留期的旧文件
 */
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const BEIJING_TZ = 'Asia/Shanghai';
const LOG_PREFIX = 'taobao-live';
const LOG_NAME_RE = /^taobao-live-(\d{4}-\d{2}-\d{2})\.log$/;

let logDir = '';
let fileEnabled = true;
let retentionDays = 30;
let currentDateKey = '';
/** @type {import('fs').WriteStream|null} */
let fileStream = null;
let bridgeInstalled = false;

function nowBeijingStr() {
  return dayjs().tz(BEIJING_TZ).format('YYYY-MM-DD HH:mm:ss');
}

function readOptions() {
  require('dotenv').config();
  const projectRoot = path.resolve(__dirname, '..');
  logDir = process.env.LOG_DIR
    ? path.resolve(process.env.LOG_DIR)
    : path.join(projectRoot, 'logs');
  fileEnabled = process.env.LOG_TO_FILE !== 'false';
  const days = parseInt(process.env.LOG_RETENTION_DAYS || '30', 10);
  retentionDays = Number.isFinite(days) && days > 0 ? days : 30;
}

function formatArg(arg) {
  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function formatMessage(args) {
  return args.map(formatArg).join(' ');
}

function logFilePathForDate(dateKey) {
  return path.join(logDir, `${LOG_PREFIX}-${dateKey}.log`);
}

function ensureFileStream() {
  if (!fileEnabled) return;
  const dateKey = dayjs().tz(BEIJING_TZ).format('YYYY-MM-DD');
  if (dateKey === currentDateKey && fileStream) return;

  if (fileStream) {
    try {
      fileStream.end();
    } catch {}
    fileStream = null;
  }

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  currentDateKey = dateKey;
  fileStream = fs.createWriteStream(logFilePathForDate(dateKey), { flags: 'a' });
  fileStream.on('error', () => {});
}

function writeFileLine(level, args) {
  if (!fileEnabled) return;
  try {
    ensureFileStream();
    if (!fileStream) return;
    const line = `[${nowBeijingStr()}] [${level}] ${formatMessage(args)}\n`;
    fileStream.write(line);
  } catch {
    // 写日志失败不影响采集
  }
}

/**
 * 删除超过 LOG_RETENTION_DAYS（默认 30 天）的 taobao-live-YYYY-MM-DD.log
 */
function cleanupOldLogs() {
  if (!logDir) readOptions();
  if (!fs.existsSync(logDir)) return { removed: 0 };

  const cutoff = dayjs().tz(BEIJING_TZ).subtract(retentionDays, 'day').startOf('day');
  let removed = 0;

  for (const name of fs.readdirSync(logDir)) {
    if (!LOG_NAME_RE.test(name)) continue;

    const full = path.join(logDir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const m = name.match(LOG_NAME_RE);
    let fileDay = m ? dayjs.tz(m[1], 'YYYY-MM-DD', BEIJING_TZ) : null;
    if (!fileDay || !fileDay.isValid()) {
      fileDay = dayjs(stat.mtime);
    }

    if (fileDay.isBefore(cutoff)) {
      try {
        fs.unlinkSync(full);
        removed += 1;
      } catch {}
    }
  }

  return { removed };
}

function initLogger() {
  readOptions();
  if (fileEnabled && !fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const { removed } = cleanupOldLogs();
  ensureFileStream();
  if (fileEnabled) {
    const keepMsg = `[logger] 文件日志目录: ${logDir}，保留 ${retentionDays} 天`;
    process.stdout.write(`${keepMsg}${removed > 0 ? `，本次清理 ${removed} 个旧文件` : ''}\n`);
    writeFileLine('INFO', [keepMsg + (removed > 0 ? `，本次清理 ${removed} 个旧文件` : '')]);
  }
}

function installConsoleBridge() {
  if (bridgeInstalled) return;
  bridgeInstalled = true;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args) => {
    orig.log(...args);
    writeFileLine('INFO', args);
  };
  console.info = (...args) => {
    orig.info(...args);
    writeFileLine('INFO', args);
  };
  console.warn = (...args) => {
    orig.warn(...args);
    writeFileLine('WARN', args);
  };
  console.error = (...args) => {
    orig.error(...args);
    writeFileLine('ERROR', args);
  };
}

function closeLogger() {
  if (fileStream) {
    try {
      fileStream.end();
    } catch {}
    fileStream = null;
  }
  currentDateKey = '';
}

module.exports = {
  initLogger,
  installConsoleBridge,
  cleanupOldLogs,
  closeLogger,
  getLogDir: () => logDir,
};
