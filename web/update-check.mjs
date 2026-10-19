/**
 * 上游更新检查（本分支新增）
 *
 * 只负责判断「1deaaa/cmdgo2api 上是否有尚未拉取的提交」，不执行合并、
 * 构建或进程重启；这些动作仍由 proxy.mjs 的 updateProject() 负责。
 *
 * 拆成独立模块的原因：
 * 1. 控制台每次进入设置页都会请求更新状态，需要 TTL 缓存与单飞（single-flight），
 *    否则会反复触发 git fetch；
 * 2. 用注入的 runGit 作为边界，可以在单元测试里完全离线验证分支、工作树、
 *    remote、ahead/behind 等判断，避免把 git 逻辑继续堆进 proxy.mjs。
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ERROR_TTL_MS = 30 * 1000;

function failure(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * 判断当前进程由谁监管。
 *
 * systemd 会在服务进程环境中注入 INVOCATION_ID / JOURNAL_STREAM（以及较新版本的
 * SYSTEMD_EXEC_PID）。这一点非常关键：systemd 默认按 control-group 回收整个
 * cgroup，如果此时再 spawn 一个「替代进程」并让主进程退出，替代进程会随
 * cgroup 一起被杀掉，服务就彻底停摆了。
 */
export function detectProcessSupervisor(env = process.env) {
  if (env?.INVOCATION_ID || env?.JOURNAL_STREAM || env?.SYSTEMD_EXEC_PID) return 'systemd';
  return 'standalone';
}

/**
 * @param {object} options
 * @param {(args: string[]) => Promise<string>} options.runGit 执行 git 并返回 stdout
 * @param {string} [options.branch] 允许自动维护的分支，默认 main
 * @param {RegExp} options.remotePattern 目标 remote URL 匹配规则
 * @param {number} [options.ttlMs] 成功结果的缓存时长
 * @param {number} [options.errorTtlMs] 失败结果的缓存时长（避免网络异常时反复重试）
 * @param {() => number} [options.now] 注入时钟，便于测试
 */
export function createUpdateChecker({
  runGit,
  branch = 'main',
  remotePattern,
  ttlMs = DEFAULT_TTL_MS,
  errorTtlMs = DEFAULT_ERROR_TTL_MS,
  now = Date.now,
} = {}) {
  if (typeof runGit !== 'function') throw new TypeError('runGit 必须是函数');
  if (!(remotePattern instanceof RegExp)) throw new TypeError('remotePattern 必须是正则表达式');

  let cache = null;
  let inflight = null;

  async function resolveRemote() {
    const stdout = await runGit(['remote', '-v']);
    const seen = new Set();
    const remotes = [];
    for (const line of String(stdout).split(/\r?\n/)) {
      const [name, url, kind] = line.trim().split(/\s+/);
      if (!name || !url || kind !== '(fetch)' || seen.has(name)) continue;
      seen.add(name);
      // 测试传入的正则可能是全局模式，显式重置 lastIndex，避免跨行状态污染。
      remotePattern.lastIndex = 0;
      if (remotePattern.test(url.replace(/\/+$/, ''))) remotes.push({ name, url });
    }
    if (remotes.length === 0) {
      throw failure('未找到指向 1deaaa/cmdgo2api 的 git remote，已停止更新。', 409);
    }
    return (remotes.find((item) => item.name === 'origin') || remotes[0]).name;
  }

  /**
   * 强制执行一次完整检查（status / 分支 / remote / fetch / ahead-behind）。
   * 失败时抛出带 status 的错误，交由调用方决定是软失败展示还是直接报错。
   */
  async function inspect() {
    const dirtyOutput = await runGit(['status', '--porcelain', '--untracked-files=all']);
    const branchName = String(await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branchName !== branch) {
      throw failure(`当前分支为 ${branchName}，软件维护仅支持 ${branch} 分支。`, 409);
    }

    const remote = await resolveRemote();
    const current = String(await runGit(['rev-parse', 'HEAD'])).trim();

    await runGit(['fetch', '--prune', remote, branch]);
    const latest = String(await runGit(['rev-parse', 'FETCH_HEAD'])).trim();

    // rev-list --left-right --count A...B → "<仅在 A 的提交数>\t<仅在 B 的提交数>"
    const counts = String(await runGit(['rev-list', '--left-right', '--count', `HEAD...${latest}`]))
      .trim()
      .split(/\s+/);
    const ahead = Number.parseInt(counts[0], 10) || 0;
    const behind = Number.parseInt(counts[1], 10) || 0;
    const dirty = Boolean(String(dirtyOutput).trim());

    return {
      ok: true,
      supported: true,
      branch: branchName,
      remote,
      current,
      currentShort: current.slice(0, 7),
      latest,
      latestShort: latest.slice(0, 7),
      ahead,
      behind,
      dirty,
      updateAvailable: behind > 0,
      canUpdate: behind > 0 && !dirty,
      blockedReason: dirty ? '工作树存在未提交改动，自动更新已停止' : null,
      checkedAt: new Date(now()).toISOString(),
      cached: false,
    };
  }

  /**
   * 供控制台展示的软失败版本：不会抛错，失败时返回 ok:false + error。
   * 命中缓存时直接返回上次结果，并标记 cached:true。
   */
  async function status({ force = false } = {}) {
    const at = now();
    if (!force && cache) {
      const ttl = cache.payload.ok ? ttlMs : errorTtlMs;
      if (at - cache.at < ttl) return { ...cache.payload, cached: true };
    }
    // 并发请求共享同一次 git 操作（例如页面刷新与手动“检查”同时发生）。
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const payload = await inspect();
        cache = { at: now(), payload };
        return payload;
      } catch (error) {
        const payload = {
          ok: false,
          supported: false,
          updateAvailable: false,
          canUpdate: false,
          error: error?.message || '检查上游更新失败',
          checkedAt: new Date(now()).toISOString(),
          cached: false,
        };
        cache = { at: now(), payload };
        return payload;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /**
   * 更新完成后把已知结果写回缓存，避免紧接着的状态查询再 fetch 一次。
   */
  function record(payload) {
    cache = { at: now(), payload };
    return payload;
  }

  return { inspect, status, record };
}
