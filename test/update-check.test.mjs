import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateChecker, detectProcessSupervisor } from '../web/update-check.mjs';

const REMOTE = 'https://github.com/1deaaa/cmdgo2api.git';
const REMOTE_PATTERN = /github\.com[:/]1deaaa\/cmdgo2api(?:\.git)?\/?$/i;
const CURRENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LATEST = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makeGit(overrides = {}) {
  const state = {
    branch: 'main',
    dirty: '',
    remotes: `origin\t${REMOTE} (fetch)\norigin\t${REMOTE} (push)\n`,
    current: CURRENT,
    latest: LATEST,
    ahead: 0,
    behind: 1,
    fetchError: null,
    ...overrides,
  };
  const calls = [];

  async function runGit(args) {
    const command = args.join(' ');
    calls.push(command);
    if (command === 'remote -v') return state.remotes;
    if (command === 'rev-parse --abbrev-ref HEAD') return `${state.branch}\n`;
    if (command === 'status --porcelain --untracked-files=all') return state.dirty;
    if (command === 'rev-parse HEAD') return `${state.current}\n`;
    if (command === 'rev-parse FETCH_HEAD') return `${state.latest}\n`;
    if (command.startsWith('rev-list --left-right --count HEAD...')) return `${state.ahead}\t${state.behind}\n`;
    if (command.startsWith('fetch --prune ')) {
      if (state.fetchError) throw new Error(state.fetchError);
      return '';
    }
    throw new Error(`未知 git 命令：${command}`);
  }

  return { runGit, calls, state };
}

function makeChecker(git, options = {}) {
  return createUpdateChecker({
    runGit: git.runGit,
    branch: 'main',
    remotePattern: REMOTE_PATTERN,
    now: () => 1_000_000,
    ...options,
  });
}

test('detectProcessSupervisor 能识别 systemd 注入的环境变量', () => {
  assert.equal(detectProcessSupervisor({ INVOCATION_ID: 'abc' }), 'systemd');
  assert.equal(detectProcessSupervisor({ JOURNAL_STREAM: '1:2' }), 'systemd');
  assert.equal(detectProcessSupervisor({ SYSTEMD_EXEC_PID: '42' }), 'systemd');
  assert.equal(detectProcessSupervisor({}), 'standalone');
});

test('有未拉取提交时报告 updateAvailable / canUpdate', async () => {
  const git = makeGit({ ahead: 0, behind: 2 });
  const checker = makeChecker(git);
  const status = await checker.status();

  assert.equal(status.ok, true);
  assert.equal(status.supported, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.remote, 'origin');
  assert.equal(status.currentShort, CURRENT.slice(0, 7));
  assert.equal(status.latestShort, LATEST.slice(0, 7));
  assert.equal(status.behind, 2);
  assert.equal(status.updateAvailable, true);
  assert.equal(status.canUpdate, true);
  assert.equal(status.cached, false);
});

test('TTL 内命中缓存，不再重复 fetch；force 会强制重新检查', async () => {
  const git = makeGit();
  const checker = makeChecker(git);

  await checker.status();
  const fetchCalls = () => git.calls.filter((call) => call.startsWith('fetch --prune ')).length;
  assert.equal(fetchCalls(), 1);

  const cached = await checker.status();
  assert.equal(cached.cached, true);
  assert.equal(fetchCalls(), 1);

  await checker.status({ force: true });
  assert.equal(fetchCalls(), 2);
});

test('工作树有未提交改动时禁止自动更新，但仍显示待拉取提交数', async () => {
  const git = makeGit({ dirty: ' M web/admin.mjs\n' });
  const checker = makeChecker(git);
  const status = await checker.status();

  assert.equal(status.updateAvailable, true);
  assert.equal(status.canUpdate, false);
  assert.equal(status.dirty, true);
  assert.match(status.blockedReason, /未提交改动/);
});

test('没有新提交时 canUpdate 为 false', async () => {
  const git = makeGit({ behind: 0, ahead: 0, latest: CURRENT });
  const checker = makeChecker(git);
  const status = await checker.status();

  assert.equal(status.updateAvailable, false);
  assert.equal(status.canUpdate, false);
  assert.equal(status.behind, 0);
});

test('非 main 分支：inspect 抛 409，status 返回软失败', async () => {
  const git = makeGit({ branch: 'dev' });
  const checker = makeChecker(git);

  await assert.rejects(checker.inspect(), (error) => error.status === 409 && /dev/.test(error.message));
  const status = await checker.status();
  assert.equal(status.ok, false);
  assert.equal(status.supported, false);
  assert.equal(status.canUpdate, false);
  assert.match(status.error, /main/);
});

test('找不到目标 remote 时返回软失败', async () => {
  const git = makeGit({ remotes: 'origin\thttps://example.com/other.git (fetch)\n' });
  const checker = makeChecker(git);
  const status = await checker.status();

  assert.equal(status.ok, false);
  assert.equal(status.supported, false);
  assert.match(status.error, /1deaaa\/cmdgo2api/);
});

test('fetch 失败会软失败并按 errorTtl 缓存，force 可重试', async () => {
  let clock = 1_000_000;
  const git = makeGit({ fetchError: '网络不可达' });
  const checker = makeChecker(git, { now: () => clock });

  const failed = await checker.status();
  assert.equal(failed.ok, false);
  assert.equal(failed.updateAvailable, false);
  assert.match(failed.error, /网络不可达/);
  const fetchCalls = () => git.calls.filter((call) => call.startsWith('fetch --prune ')).length;
  assert.equal(fetchCalls(), 1);

  clock += 5_000;
  const cached = await checker.status();
  assert.equal(cached.cached, true);
  assert.equal(fetchCalls(), 1);

  clock += 60_000;
  await checker.status();
  assert.equal(fetchCalls(), 2);

  await checker.status({ force: true });
  assert.equal(fetchCalls(), 3);
});

test('record 可以写入已知结果，避免更新完成后立刻重新 fetch', async () => {
  const git = makeGit();
  const checker = makeChecker(git);
  const known = { ok: true, supported: true, updateAvailable: false, canUpdate: false, behind: 0 };
  checker.record(known);

  const status = await checker.status();
  assert.equal(status.cached, true);
  assert.equal(status.updateAvailable, false);
  assert.equal(git.calls.filter((call) => call.startsWith('fetch --prune ')).length, 0);
});
