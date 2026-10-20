import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequestLogStore } from '../web/request-log-store.mjs';

function record(id) {
  return {
    id,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.slice(1)) || 0)).toISOString(),
    model: 'test-model',
  };
}

function makeTempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-request-log-'));
  return { dir, filePath: join(dir, 'request-log.jsonl') };
}

function ids(page) {
  return page.records.map((item) => item.id);
}

test('深页从磁盘读取，不受内存缓存条数限制', () => {
  const { dir, filePath } = makeTempFile();
  try {
    const store = createRequestLogStore({ filePath, memoryLimit: 2, retention: 10 });
    for (let index = 1; index <= 6; index += 1) store.add(record(`r${index}`));

    assert.equal(store.memorySize, 2);
    assert.equal(store.total, 6);
    assert.deepEqual(ids(store.list({ offset: 0, limit: 2 })), ['r6', 'r5']);

    // offset 4 已经超出内存缓存，必须回读磁盘才能拿到。
    const deep = store.list({ offset: 4, limit: 2 });
    assert.deepEqual(ids(deep), ['r2', 'r1']);
    assert.equal(deep.total, 6);

    const beyond = store.list({ offset: 6, limit: 2 });
    assert.deepEqual(beyond.records, []);
    assert.equal(beyond.total, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('进程重启后仍能从磁盘翻到内存缓存以外的历史', () => {
  const { dir, filePath } = makeTempFile();
  try {
    const first = createRequestLogStore({ filePath, memoryLimit: 2, retention: 10 });
    for (let index = 1; index <= 6; index += 1) first.add(record(`r${index}`));

    // 模拟进程重启：新实例只把最近 2 条载入内存，更早的记录留在磁盘。
    const restarted = createRequestLogStore({ filePath, memoryLimit: 2, retention: 10 });
    assert.equal(restarted.memorySize, 2);
    assert.equal(restarted.total, 6);
    assert.deepEqual(ids(restarted.list({ offset: 2, limit: 2 })), ['r4', 'r3']);
    assert.deepEqual(ids(restarted.list({ offset: 4, limit: 2 })), ['r2', 'r1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件轮转保留最近 retention 条，而不是退化为内存缓存大小', () => {
  const { dir, filePath } = makeTempFile();
  try {
    const store = createRequestLogStore({
      filePath,
      memoryLimit: 2,
      retention: 4,
      rotateThreshold: 6,
    });
    for (let index = 1; index <= 9; index += 1) store.add(record(`r${index}`));

    const page = store.list({ offset: 0, limit: 10 });
    assert.deepEqual(ids(page), ['r9', 'r8', 'r7', 'r6', 'r5']);
    assert.equal(page.total, 5);
    assert.equal(readFileSync(filePath, 'utf8').trim().split('\n').length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏行会被跳过，且不落盘模式仍可分页', () => {
  const { dir, filePath } = makeTempFile();
  try {
    writeFileSync(filePath, `${JSON.stringify(record('r1'))}\nnot-json\n${JSON.stringify(record('r2'))}\n`, 'utf8');
    const store = createRequestLogStore({ filePath, memoryLimit: 1, retention: 10 });
    assert.equal(store.total, 2);
    assert.deepEqual(ids(store.list({ offset: 1, limit: 1 })), ['r1']);

    const memoryOnly = createRequestLogStore({ filePath, memoryLimit: 2, persistence: false });
    for (let index = 1; index <= 3; index += 1) memoryOnly.add(record(`m${index}`));
    assert.equal(memoryOnly.total, 2);
    assert.deepEqual(ids(memoryOnly.list({ offset: 0, limit: 2 })), ['m3', 'm2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
