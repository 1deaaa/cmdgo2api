/**
 * 调用日志的持久化与分页读取（本分支新增）。
 *
 * 设计目标：
 * - 内存只保留最近 `memoryLimit` 条，供首页和实时刷新快速读取；
 * - 磁盘 JSONL 保留完整的 `retention` 条历史，翻到较深页码时按需从磁盘读取；
 * - 文件超过轮转阈值时整体重写为最近 `retention` 条，避免无限增长，
 *   而不是像旧实现那样只留下内存里的 300 条。
 *
 * 该模块不依赖 admin.mjs，便于单独测试。
 */

import { randomBytes } from 'crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';

const DEFAULT_MEMORY_LIMIT = 300;
const DEFAULT_RETENTION = 5000;
// 轮转时多保留一点余量，避免每追加一条就重写整个文件。
const DEFAULT_ROTATE_SLACK = 500;
// 单次读取上限，防止调用方传入过大的 limit 造成不必要的内存占用。
const MAX_PAGE_SIZE = 500;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRequestLogRecord(value) {
  return isObject(value) && typeof value.id === 'string' && typeof value.at === 'string';
}

/**
 * 读取整个日志文件。
 * @param {string} filePath
 * @returns {{ records: object[], lineCount: number }} records 按时间从旧到新排列
 */
function readLogFile(filePath) {
  if (!existsSync(filePath)) return { records: [], lineCount: 0 };
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { records: [], lineCount: 0 };
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const records = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (isRequestLogRecord(value)) records.push(value);
    } catch {
      // 跳过损坏行；轮转时会把文件重写为纯合法内容
    }
  }
  return { records, lineCount: lines.length };
}

/**
 * 创建调用日志存储。
 *
 * @param {{
 *   filePath: string,
 *   memoryLimit?: number,
 *   retention?: number,
 *   persistence?: boolean,
 *   rotateThreshold?: number,
 * }} options
 */
export function createRequestLogStore({
  filePath,
  memoryLimit = DEFAULT_MEMORY_LIMIT,
  retention = DEFAULT_RETENTION,
  persistence = true,
  rotateThreshold = retention + DEFAULT_ROTATE_SLACK,
} = {}) {
  if (!filePath) throw new Error('filePath 不能为空');

  const retentionCap = Math.max(1, Math.trunc(retention));
  // 内存缓存不可能比磁盘保留量更有价值，避免配置矛盾。
  const memoryCap = Math.min(Math.max(1, Math.trunc(memoryLimit)), retentionCap);
  const rotateAt = Math.max(retentionCap + 1, Math.trunc(rotateThreshold));

  const records = []; // 最新在前
  let fileLineCount = 0;
  let fileRecordCount = 0;

  if (persistence) {
    const stored = readLogFile(filePath);
    records.push(...stored.records.slice(-memoryCap).reverse());
    fileLineCount = stored.lineCount;
    fileRecordCount = stored.records.length;
  }

  function ensureDirectory() {
    const directory = dirname(filePath);
    if (!directory || directory === '.') return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  /** 原子重写文件，只保留传入的记录（按时间从旧到新）。 */
  function rewriteFile(kept) {
    ensureDirectory();
    const temporary = join(
      dirname(filePath),
      `.request-log.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    const body = kept.map((item) => JSON.stringify(item)).join('\n');
    try {
      writeFileSync(temporary, body ? `${body}\n` : '', { encoding: 'utf8', mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, filePath);
      chmodSync(filePath, 0o600);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // 临时文件可能尚未创建，忽略清理失败
      }
      throw error;
    }
    fileLineCount = kept.length;
    fileRecordCount = kept.length;
  }

  function rotateIfNeeded() {
    if (fileLineCount < rotateAt) return;
    const stored = readLogFile(filePath);
    rewriteFile(stored.records.slice(-retentionCap));
  }

  /**
   * 追加一条日志。写入磁盘失败时只影响持久化，内存日志仍然可用。
   * @param {object} record
   */
  function add(record) {
    if (!isRequestLogRecord(record)) return;
    records.unshift(record);
    if (records.length > memoryCap) records.length = memoryCap;
    if (!persistence) return;

    // 轮转失败不应该阻止本次追加，否则一条坏记录会连带丢掉后续日志。
    try {
      rotateIfNeeded();
    } catch {
      // 下一轮追加会再次尝试轮转
    }
    try {
      ensureDirectory();
      appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      fileLineCount += 1;
      fileRecordCount += 1;
    } catch {
      // 落盘失败不影响代理主流程，内存日志仍然可用
    }
  }

  /**
   * 按“最新在前”的顺序分页读取。
   *
   * offset 为跳过的记录数，limit 为返回条数。页码完全落在内存缓存内时走快路径，
   * 否则读取磁盘，并把尚未成功落盘的内存记录合并到最前面。
   *
   * @param {{ offset?: number, limit?: number }} [options]
   * @returns {{ records: object[], total: number }}
   */
  function list({ offset = 0, limit = 50 } = {}) {
    const start = Math.max(0, Math.trunc(Number(offset) || 0));
    const size = Math.min(Math.max(1, Math.trunc(Number(limit) || 50)), MAX_PAGE_SIZE);

    if (!persistence) {
      return { records: records.slice(start, start + size), total: records.length };
    }

    if (start + size <= records.length) {
      return {
        records: records.slice(start, start + size),
        // 磁盘里可能还有更早的历史，取较大值作为总数。
        total: Math.max(fileRecordCount, records.length),
      };
    }

    const stored = readLogFile(filePath); // 旧 -> 新
    const persistedIds = new Set(stored.records.map((item) => item.id));
    const unpersisted = records.filter((item) => !persistedIds.has(item.id)); // 新 -> 旧
    // 未落盘的内存记录一定比磁盘中的记录更晚，反转后拼在磁盘记录后面。
    const chronological = unpersisted.length
      ? unpersisted.slice().reverse().concat(stored.records)
      : stored.records;
    const newestFirst = chronological.slice().reverse();
    return { records: newestFirst.slice(start, start + size), total: newestFirst.length };
  }

  return {
    add,
    list,
    /** 当前可展示的总条数（磁盘历史 + 未落盘内存记录）。 */
    get total() {
      return persistence ? Math.max(fileRecordCount, records.length) : records.length;
    },
    /** 内存缓存条数，供诊断或测试使用。 */
    get memorySize() {
      return records.length;
    },
  };
}
