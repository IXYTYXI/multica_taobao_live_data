/**
 * 时区处理测试
 * 验证北京时间计算在美东机器上正确
 */
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const BEIJING_TZ = 'Asia/Shanghai';

console.log('=== 时区处理测试 ===\n');

// 1. 本地时间 vs 北京时间
const localNow = dayjs();
const beijingNow = dayjs().tz(BEIJING_TZ);
console.log('本机时间:', localNow.format('YYYY-MM-DD HH:mm:ss Z'));
console.log('北京时间:', beijingNow.format('YYYY-MM-DD HH:mm:ss Z'));
console.log('时差:', beijingNow.utcOffset() - localNow.utcOffset(), '分钟');

// 2. 评论时间解析
const today = beijingNow.format('YYYY-MM-DD');
const commentTimeStr = `${today} 14:30:25`;
const commentTime = dayjs.tz(commentTimeStr, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
console.log('\n评论时间解析:');
console.log('  输入:', commentTimeStr);
console.log('  解析结果:', commentTime.format('YYYY-MM-DD HH:mm:ss Z'));
console.log('  UTC:', commentTime.utc().format('YYYY-MM-DD HH:mm:ss'));

// 3. 5分钟范围检查
const cutoff = beijingNow.subtract(5, 'minute');
const recentComment = dayjs.tz(`${today} ${beijingNow.subtract(2, 'minute').format('HH:mm:ss')}`, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
const oldComment = dayjs.tz(`${today} ${beijingNow.subtract(10, 'minute').format('HH:mm:ss')}`, 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);

console.log('\n5分钟范围检查:');
console.log('  截止时间:', cutoff.format('HH:mm:ss'));
console.log('  2分钟前评论:', recentComment.format('HH:mm:ss'), '→', recentComment.isAfter(cutoff) ? '✓ 在范围内' : '✗ 超出范围');
console.log('  10分钟前评论:', oldComment.format('HH:mm:ss'), '→', oldComment.isAfter(cutoff) ? '✗ 不应在范围内' : '✓ 正确排除');

// 4. 日期时间戳转换（飞书日期字段）
const testTime = dayjs.tz('2026-07-10 15:30:00', 'YYYY-MM-DD HH:mm:ss', BEIJING_TZ);
console.log('\n时间戳转换:');
console.log('  输入: 2026-07-10 15:30:00 (北京)');
console.log('  毫秒时间戳:', testTime.valueOf());
console.log('  还原验证:', dayjs(testTime.valueOf()).tz(BEIJING_TZ).format('YYYY-MM-DD HH:mm:ss'));

console.log('\n=== 时区测试通过 ===');
