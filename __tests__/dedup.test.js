/**
 * index.js 去重逻辑单元测试
 * 测试评论去重 key 生成和重复检测
 */

describe('评论去重逻辑', () => {
  // 复现 index.js 中的去重 key 生成逻辑
  function makeDedupeKey(comment) {
    return `${comment.userId}_${comment.time}_${comment.content}`;
  }

  test('相同评论生成相同的 key', () => {
    const comment1 = { userId: 'user1', time: '2026-07-10 14:30:00', content: '好看' };
    const comment2 = { userId: 'user1', time: '2026-07-10 14:30:00', content: '好看' };
    expect(makeDedupeKey(comment1)).toBe(makeDedupeKey(comment2));
  });

  test('不同用户生成不同的 key', () => {
    const comment1 = { userId: 'user1', time: '2026-07-10 14:30:00', content: '好看' };
    const comment2 = { userId: 'user2', time: '2026-07-10 14:30:00', content: '好看' };
    expect(makeDedupeKey(comment1)).not.toBe(makeDedupeKey(comment2));
  });

  test('不同时间生成不同的 key', () => {
    const comment1 = { userId: 'user1', time: '2026-07-10 14:30:00', content: '好看' };
    const comment2 = { userId: 'user1', time: '2026-07-10 14:31:00', content: '好看' };
    expect(makeDedupeKey(comment1)).not.toBe(makeDedupeKey(comment2));
  });

  test('不同内容生成不同的 key', () => {
    const comment1 = { userId: 'user1', time: '2026-07-10 14:30:00', content: '好看' };
    const comment2 = { userId: 'user1', time: '2026-07-10 14:30:00', content: '不好看' };
    expect(makeDedupeKey(comment1)).not.toBe(makeDedupeKey(comment2));
  });

  test('Set 去重功能正确', () => {
    const recorded = new Set();
    const comments = [
      { userId: 'u1', time: '14:30', content: 'c1' },
      { userId: 'u2', time: '14:31', content: 'c2' },
      { userId: 'u1', time: '14:30', content: 'c1' }, // 重复
      { userId: 'u3', time: '14:32', content: 'c3' },
      { userId: 'u2', time: '14:31', content: 'c2' }, // 重复
    ];

    const newRecords = [];
    for (const comment of comments) {
      const key = makeDedupeKey(comment);
      if (!recorded.has(key)) {
        newRecords.push(comment);
        recorded.add(key);
      }
    }

    expect(newRecords).toHaveLength(3);
    expect(newRecords[0].userId).toBe('u1');
    expect(newRecords[1].userId).toBe('u2');
    expect(newRecords[2].userId).toBe('u3');
  });

  test('空字段的 key 仍然唯一', () => {
    const comment1 = { userId: '', time: '', content: '' };
    const comment2 = { userId: 'user1', time: '14:30', content: '' };
    expect(makeDedupeKey(comment1)).not.toBe(makeDedupeKey(comment2));
  });

  test('key 中包含中文内容正确处理', () => {
    const comment = { userId: '小红', time: '2026-07-10 14:30:00', content: '这个商品太棒了！' };
    const key = makeDedupeKey(comment);
    expect(key).toBe('小红_2026-07-10 14:30:00_这个商品太棒了！');
  });
});

describe('记录构造逻辑', () => {
  // 复现 index.js handleTransactionChange 中的记录构造
  function buildRecord(comment, orderInfo) {
    return {
      commenterID: comment.userId,
      commentTime: comment.time,
      commentContent: comment.content,
      orderNumber: orderInfo?.orderNumber || '',
      paymentTime: orderInfo?.paymentTime || '',
    };
  }

  test('有订单信息时完整填充', () => {
    const comment = { userId: 'u1', time: '14:30', content: 'test' };
    const order = { orderNumber: 'ORD123', paymentTime: '2026-07-10 14:25:00', buyerId: 'b1' };
    const record = buildRecord(comment, order);
    expect(record.commenterID).toBe('u1');
    expect(record.orderNumber).toBe('ORD123');
    expect(record.paymentTime).toBe('2026-07-10 14:25:00');
  });

  test('无订单信息时字段为空字符串', () => {
    const comment = { userId: 'u1', time: '14:30', content: 'test' };
    const record = buildRecord(comment, null);
    expect(record.orderNumber).toBe('');
    expect(record.paymentTime).toBe('');
  });

  test('订单信息部分缺失时正确处理', () => {
    const comment = { userId: 'u1', time: '14:30', content: 'test' };
    const order = { orderNumber: 'ORD123', paymentTime: '' };
    const record = buildRecord(comment, order);
    expect(record.orderNumber).toBe('ORD123');
    expect(record.paymentTime).toBe('');
  });
});
