/**
 * 本地 Web 控制台的管理 API 和静态资源处理器。
 *
 * 该模块与代理核心保持独立，只通过传入的配置对象和重启回调与主进程交互。
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { extname, join, relative, resolve } from 'path';

const DEFAULT_API_BASE = 'https://api.commandcode.ai';
const CALLBACK_BASE = 'https://commandcode.ai';
const BROWSER_SESSION_TTL_MS = 10 * 60 * 1000;
const BRIDGE_SESSION_TTL_MS = 10 * 60 * 1000;
const CONSOLE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CONSOLE_COOKIE_NAME = 'cc_console_session';
const MAX_GATEWAY_KEYS = 32;
const MAX_ACCOUNTS = 32;
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_RUNTIME_DIR = join(homedir(), '.config', 'commandcode-proxy');
const DEFAULT_AUTH_FILE = join(homedir(), '.commandcode', 'auth.json');

class AdminError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function unquoteEnvValue(value) {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("'\\''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value;
}

function parseEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  let lines;
  try {
    lines = readFileSync(path, 'utf8').split(/\r?\n/);
  } catch {
    return values;
  }
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    const value = unquoteEnvValue(line.slice(separator + 1).trim());
    if (key) values[key] = value;
  }
  return values;
}

function readRuntimeCredentials(runtimeDir) {
  return parseEnvFile(join(runtimeDir, 'credentials.env'));
}

function stableKeyId(value) {
  return `key-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function hashBridgeTicket(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function normalizeGatewayKeys(source, legacy = '') {
  const list = Array.isArray(source) ? [...source] : source ? [source] : [];
  if (list.length === 0 && legacy) list.push(legacy);
  const result = [];
  for (const entry of list) {
    const value = text(isObject(entry) ? (entry.value ?? entry.key ?? entry.apiKey) : entry);
    if (!value || result.some((item) => item.value === value)) continue;
    const id = text(isObject(entry) ? entry.id : '') || stableKeyId(value);
    const createdAt = text(isObject(entry) ? entry.createdAt : '') || null;
    result.push({ id, value, createdAt });
  }
  return result.slice(0, MAX_GATEWAY_KEYS);
}

function parseGatewayKeysJson(raw, encoding = 'utf8') {
  try {
    const value = encoding === 'base64url'
      ? Buffer.from(raw, 'base64url').toString('utf8')
      : raw;
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function gatewayKeysFromCredentials(credentials) {
  if (hasOwn(credentials, 'GATEWAY_API_KEYS_JSON_B64')) {
    const parsed = parseGatewayKeysJson(credentials.GATEWAY_API_KEYS_JSON_B64, 'base64url');
    if (parsed) return normalizeGatewayKeys(parsed);
  }
  if (hasOwn(credentials, 'GATEWAY_API_KEYS_JSON')) {
    const parsed = parseGatewayKeysJson(credentials.GATEWAY_API_KEYS_JSON);
    if (parsed) return normalizeGatewayKeys(parsed);
  }
  return normalizeGatewayKeys([], credentials.GATEWAY_API_KEY);
}

function validateGatewayKey(value) {
  const key = text(value);
  if (key.length < 8 || key.length > 256 || /[\r\n=]/.test(key)) {
    throw new AdminError('网关密钥需要 8 至 256 个字符，且不能包含换行或等号');
  }
  return key;
}

function validateUpstreamToken(value) {
  const token = text(value);
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) {
    throw new AdminError('Command Code API Key 不能为空，且不能包含换行');
  }
  return token;
}

function writeRuntimeCredentials(runtimeDir, { ccApiKey, gatewayKeys }) {
  const upstream = text(ccApiKey);
  if (/\r|\n/.test(upstream)) throw new AdminError('密钥不能包含换行符');
  const keys = normalizeGatewayKeys(gatewayKeys);
  keys.forEach((item) => validateGatewayKey(item.value));
  const serializedKeys = JSON.stringify(keys);

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  const target = join(runtimeDir, 'credentials.env');
  const temporary = join(runtimeDir, `.credentials.env.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const content = [
    `CC_API_KEY=${shellQuote(upstream)}`,
    `GATEWAY_API_KEYS_JSON_B64=${shellQuote(Buffer.from(serializedKeys, 'utf8').toString('base64url'))}`,
    `GATEWAY_API_KEY=${shellQuote(keys[0]?.value || '')}`,
    '',
  ].join('\n');
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}

function saveAuthToken(authFile, payload) {
  const authDir = resolve(authFile, '..');
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  chmodSync(authDir, 0o700);
  const token = {
    apiKey: text(payload.apiKey),
    userId: text(payload.userId),
    userName: text(payload.userName),
    email: text(payload.email),
    keyName: text(payload.keyName),
    authenticatedAt: new Date().toISOString(),
  };
  if (!token.apiKey) throw new AdminError('登录回调没有返回 API token');
  const temporary = join(authDir, `.auth.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(token, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, authFile);
  chmodSync(authFile, 0o600);
  return token;
}

function readAuthToken(authFile) {
  try {
    const value = JSON.parse(readFileSync(authFile, 'utf8'));
    if (!isObject(value) || !text(value.apiKey)) return null;
    return {
      apiKey: text(value.apiKey),
      userId: text(value.userId),
      userName: text(value.userName),
      email: text(value.email),
      keyName: text(value.keyName),
      authenticatedAt: text(value.authenticatedAt),
    };
  } catch {
    return null;
  }
}

function clearAuthToken(authFile) {
  try {
    if (existsSync(authFile)) unlinkSync(authFile);
  } catch {
    // 旧版兼容文件清理失败不应阻止账号切换。
  }
}

function stableAccountId(value) {
  return `account-${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

function accountIdForToken(token) {
  return stableAccountId(text(token.userId) || text(token.apiKey));
}

function normalizeStoredAccount(source) {
  if (!isObject(source)) return null;
  const apiKey = text(source.apiKey);
  if (!apiKey) return null;
  return {
    id: text(source.id) || accountIdForToken(source),
    apiKey,
    userId: text(source.userId),
    userName: text(source.userName),
    email: text(source.email),
    keyName: text(source.keyName),
    authenticatedAt: text(source.authenticatedAt) || new Date().toISOString(),
    usage: isObject(source.usage) ? source.usage : null,
    usageError: text(source.usageError),
  };
}

function readAccountStore(accountsFile, authFile, fallbackToken = null) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(accountsFile, 'utf8'));
  } catch {
    parsed = null;
  }

  const sourceAccounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  const accounts = [];
  for (const source of sourceAccounts) {
    const account = normalizeStoredAccount(source);
    if (!account || accounts.some((item) => item.id === account.id || item.apiKey === account.apiKey)) continue;
    accounts.push(account);
    if (accounts.length >= MAX_ACCOUNTS) break;
  }

  let migrated = false;
  if (accounts.length === 0) {
    const legacy = readAuthToken(authFile);
    const fallback = legacy || normalizeStoredAccount(fallbackToken);
    if (fallback) {
      accounts.push(normalizeStoredAccount(fallback));
      migrated = true;
    }
  }

  const requestedActiveId = text(parsed?.activeAccountId);
  const activeAccountId = accounts.some((account) => account.id === requestedActiveId)
    ? requestedActiveId
    : accounts[0]?.id || null;
  if (activeAccountId !== requestedActiveId) migrated = true;
  return { version: 1, activeAccountId, accounts, migrated };
}

function writeAccountStore(accountsFile, store) {
  const accounts = (Array.isArray(store?.accounts) ? store.accounts : [])
    .map(normalizeStoredAccount)
    .filter(Boolean)
    .slice(0, MAX_ACCOUNTS);
  const activeAccountId = accounts.some((account) => account.id === store?.activeAccountId)
    ? store.activeAccountId
    : accounts[0]?.id || null;
  const accountDir = resolve(accountsFile, '..');
  mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  chmodSync(accountDir, 0o700);
  const temporary = join(accountDir, `.accounts.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ version: 1, activeAccountId, accounts }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, accountsFile);
  chmodSync(accountsFile, 0o600);
  return { version: 1, activeAccountId, accounts };
}

function publicAccount(account, activeAccountId) {
  if (!account) return null;
  return {
    id: account.id,
    userId: account.userId,
    userName: account.userName,
    email: account.email,
    keyName: account.keyName,
    authenticatedAt: account.authenticatedAt,
    active: account.id === activeAccountId,
    usage: account.usage || null,
    usageError: account.usageError || null,
  };
}

function publicAccounts(store) {
  return store.accounts.map((account) => publicAccount(account, store.activeAccountId));
}

function readAuthMetadata(authFile) {
  const token = readAuthToken(authFile);
  return token ? {
    userId: token.userId,
    userName: token.userName,
    email: token.email,
    keyName: token.keyName,
    authenticatedAt: token.authenticatedAt,
    hasToken: true,
  } : null;
}

function windowSnapshot(value) {
  const source = isObject(value) ? value : {};
  const usedValue = finiteNumber(source.used);
  const capValue = finiteNumber(source.cap);
  const used = usedValue ?? 0;
  const cap = capValue ?? 0;
  const known = (usedValue !== null && capValue !== null && capValue > 0) || Boolean(source.exceeded);
  const ratio = cap > 0 ? Math.min(1, Math.max(0, used / cap)) : 0;
  return {
    used,
    cap,
    remaining: Math.max(0, cap - used),
    ratio,
    remainingRatio: cap > 0 ? 1 - ratio : 0,
    resetAt: source.resetAt ?? null,
    exceeded: Boolean(source.exceeded),
    known,
  };
}

function nextMonth(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString();
}

function planName(subscription) {
  const planId = text(subscription?.planId).toLowerCase();
  return {
    'individual-go': 'Go',
    'individual-goat': 'GOAT',
    'individual-pro': 'Pro',
    'individual-provider': 'Provider',
    'individual-max': 'Max',
  }[planId] || text(subscription?.planId) || '未知套餐';
}

function normalizeUsage({ whoami, credits, subscription, summary }) {
  const user = isObject(whoami?.user) ? whoami.user : {};
  const creditData = isObject(credits?.credits) ? credits.credits : {};
  const limits = isObject(credits?.windowLimits) ? credits.windowLimits : {};
  const monthlyCredits = finiteNumber(creditData.monthlyCredits);
  const monthlyUsed = number(summary?.totalCost);
  const monthlyRemaining = monthlyCredits ?? 0;
  const monthlyGranted = finiteNumber(creditData.monthlyCreditsGranted);
  const monthlyCap = monthlyGranted > 0 ? monthlyGranted : monthlyUsed + monthlyRemaining;
  const monthlyRatio = monthlyCap > 0 ? Math.min(1, Math.max(0, monthlyUsed / monthlyCap)) : 0;
  return {
    account: {
      id: text(user.id || user.userId),
      userName: text(user.userName || user.name),
      email: text(user.email),
    },
    plan: planName(subscription),
    monthly: {
      used: monthlyUsed,
      cap: monthlyCap,
      remaining: monthlyRemaining,
      ratio: monthlyRatio,
      remainingRatio: monthlyCap > 0 ? 1 - monthlyRatio : 0,
      resetAt: subscription?.currentPeriodEnd ?? subscription?.periodEnd ?? nextMonth(subscription?.currentPeriodStart),
      totalCount: number(summary?.totalCount),
      totalTokens: number(summary?.totalTokens ?? summary?.totalTokensIn + summary?.totalTokensOut),
      known: monthlyCredits !== null,
    },
    fiveHour: windowSnapshot(limits.fiveHour),
    weekly: windowSnapshot(limits.weekly),
    periodStart: subscription?.currentPeriodStart ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

const USAGE_QUOTA_KEYS = ['fiveHour', 'weekly', 'monthly'];

function quotaKnown(quota, key) {
  if (!isObject(quota)) return false;
  if (hasOwn(quota, 'known')) return quota.known === true;
  if (key === 'monthly') return finiteNumber(quota.remaining) !== null;
  const cap = finiteNumber(quota.cap);
  return (cap !== null && cap > 0) || Boolean(quota.exceeded);
}

function quotaIsFull(quota, key) {
  if (!quotaKnown(quota, key)) return false;
  if (quota.exceeded === true) return true;
  const remaining = finiteNumber(quota.remaining);
  if (remaining !== null && remaining <= 0) return true;
  const ratio = finiteNumber(quota.ratio);
  return ratio !== null && ratio >= 1;
}

function usageHasExhaustedQuota(usage) {
  return isObject(usage) && USAGE_QUOTA_KEYS.some((key) => quotaIsFull(usage[key], key));
}

function usageHasAvailableQuotas(usage) {
  return isObject(usage)
    && USAGE_QUOTA_KEYS.every((key) => quotaKnown(usage[key], key) && !quotaIsFull(usage[key], key));
}

// 上游限额错误的文案匹配。官方 CLI 会优先读取结构化的 rateLimit.window；
// 拿不到结构化字段时，用这些关键词兜底判断（与官方 CLI 的匹配逻辑保持一致）。
const QUOTA_LIMIT_MESSAGE_PATTERNS = [
  /usage limit for your plan/i,
  /(?:reached|hit|exceeded)[^.]{0,40}(?:5[ -]?hour|five[ -]?hour|weekly|daily|monthly|month)[^.]{0,30}limit/i,
  /(?:5[ -]?hour|five[ -]?hour|weekly|daily|monthly|month)[^.]{0,30}(?:usage )?limit (?:reached|exceeded)/i,
  /insufficient credits/i,
  /premium credits?[^.]{0,20}(?:exhausted|used up)/i,
  /spend(?:ing)? limit (?:reached|exceeded)/i,
];

function quotaWindowKey(value) {
  const window = text(value).toLowerCase().replaceAll('_', '-');
  if (['fivehour', 'five-hour', '5-hour', '5hour', 'daily', 'day'].includes(window)) return 'fiveHour';
  if (['weekly', 'week'].includes(window)) return 'weekly';
  if (['monthly', 'month'].includes(window)) return 'monthly';
  return null;
}

function quotaWindowFromMessage(message) {
  if (/weekly/i.test(message)) return 'weekly';
  if (/month(?:ly)?/i.test(message)) return 'monthly';
  if (/credits?|spend/i.test(message)) return 'monthly';
  // 官方 CLI 的兜底规则：只命中 “usage limit for your plan” 时按 5 小时窗口处理。
  return 'fiveHour';
}

function quotaResetAtMs({ rateLimit, message }) {
  if (finiteNumber(rateLimit?.reset) !== null) return Number(rateLimit.reset) * 1000;
  const match = text(message).match(/resets? at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i);
  if (!match) return null;
  const parsed = Date.parse(match[1]);
  return Number.isNaN(parsed) ? null : parsed;
}

// 解析上游错误，判断是否为“额度窗口耗尽”类错误。
// 返回 null 表示普通错误（例如临时 429 限流），不应触发切号。
export function parseUpstreamQuotaLimit({ status, code, message, rateLimit } = {}) {
  const rawMessage = text(message);
  const structuredWindow = quotaWindowKey(rateLimit?.window);
  const messageMatched = QUOTA_LIMIT_MESSAGE_PATTERNS.some((pattern) => pattern.test(rawMessage));
  if (!structuredWindow && !messageMatched) return null;
  return {
    window: structuredWindow || quotaWindowFromMessage(rawMessage),
    model: text(rateLimit?.model) || null,
    resetAtMs: quotaResetAtMs({ rateLimit, message: rawMessage }),
  };
}

async function fetchJson(url, apiKey) {
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'commandcode-proxy-console/1.0',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new AdminError(`无法连接 Command Code：${error.message || error}`, 502);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    throw new AdminError(`Command Code 返回 HTTP ${response.status}`, 502);
  }
  if (!response.ok) {
    const detail = text(payload?.error?.message || payload?.error || payload?.message);
    throw new AdminError(detail ? `Command Code：${detail.slice(0, 240)}` : `Command Code 返回 HTTP ${response.status}`, response.status === 401 ? 401 : 502);
  }
  if (!isObject(payload)) throw new AdminError('Command Code 返回格式无效', 502);
  return payload;
}

async function readUsage(config, apiKey) {
  const base = text(config.apiBase) || DEFAULT_API_BASE;
  const whoami = await fetchJson(`${base}/alpha/whoami?limits=1`, apiKey);
  const org = isObject(whoami.org) ? whoami.org : {};
  const orgId = org.id;
  const creditsUrl = new URL('/alpha/billing/credits', base);
  const subscriptionsUrl = new URL('/alpha/billing/subscriptions', base);
  if (orgId) {
    creditsUrl.searchParams.set('orgId', orgId);
    subscriptionsUrl.searchParams.set('orgId', orgId);
  }
  const credits = await fetchJson(creditsUrl, apiKey);
  const subscriptionWrapper = await fetchJson(subscriptionsUrl, apiKey);
  const subscription = isObject(subscriptionWrapper.data) ? subscriptionWrapper.data : {};
  const summaryUrl = new URL('/alpha/usage/summary', base);
  if (orgId) summaryUrl.searchParams.set('orgId', orgId);
  if (subscription.currentPeriodStart) summaryUrl.searchParams.set('since', subscription.currentPeriodStart);
  const summary = await fetchJson(summaryUrl, apiKey);
  return normalizeUsage({ whoami, credits, subscription, summary });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AdminError('请求数据过大', 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const contentType = text(request.headers['content-type']).split(';', 1)[0].toLowerCase();
  if (contentType === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    const value = JSON.parse(raw);
    if (!isObject(value)) throw new AdminError('请求 JSON 必须是对象');
    return value;
  } catch (error) {
    if (error instanceof AdminError) throw error;
    throw new AdminError('请求 JSON 格式无效');
  }
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
}

function sendText(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendError(response, error) {
  const hasSafeStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600;
  const status = error instanceof AdminError ? error.status : (hasSafeStatus ? error.status : 500);
  const message = error instanceof AdminError || hasSafeStatus ? error.message : '管理请求失败';
  if (!(error instanceof AdminError) && !hasSafeStatus) console.error('[console] Admin request failed:', error);
  sendJson(response, status, { ok: false, error: message });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(request) {
  const cookies = {};
  const raw = text(request.headers.cookie);
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

function isSecureRequest(request) {
  const forwardedProto = text(request.headers['x-forwarded-proto']).split(',')[0].trim().toLowerCase();
  return forwardedProto === 'https' || Boolean(request.socket?.encrypted);
}

function firstForwardedValue(value) {
  return text(value).split(',')[0].trim();
}

function publicOrigin(value) {
  let parsed;
  try {
    parsed = new URL(text(value));
  } catch {
    throw new AdminError('公网地址必须是有效的 HTTP 或 HTTPS URL', 500);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new AdminError('公网地址只能包含 HTTP/HTTPS 协议和域名，例如 https://console.example.com', 500);
  }
  return parsed;
}

function isLoopbackHost(value) {
  let hostname;
  try {
    hostname = new URL(`http://${text(value)}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function browserCallbackUrl(request, url, config) {
  const directHost = firstForwardedValue(request.headers?.host) || url.host;
  const host = isLoopbackHost(directHost) ? directHost : requestHost(request, url, config);
  if (!isLoopbackHost(host)) throw new AdminError('只有本机控制台可以使用浏览器回调', 400);
  const origin = publicOrigin(`http://${host}`);
  origin.pathname = '/callback';
  return origin.toString();
}

function requestOrigin(request, url, config) {
  const forwardedProto = firstForwardedValue(request.headers?.['x-forwarded-proto']);
  const protocol = forwardedProto || (request.socket?.encrypted ? 'https' : 'http');
  return publicOrigin(`${protocol}://${requestHost(request, url, config)}`);
}

function bridgeCommands(origin, state, ticket) {
  const helperUrl = new URL('/admin/api/auth/bridge/helper', origin).toString();
  const args = [
    '--server', origin.toString(),
    '--state', state,
    '--ticket', ticket,
  ];
  const shellArgs = args.map(shellQuote).join(' ');
  const powershellArgs = args.map(powershellQuote).join(' ');
  return {
    helperUrl,
    command: `helper_path="$(mktemp -t cmdc-remote-login.XXXXXX)" && trap 'rm -f "$helper_path"' EXIT && curl -fsSL ${shellQuote(helperUrl)} -o "$helper_path" && node "$helper_path" ${shellArgs}`,
    powershellCommand: `$helperPath = Join-Path ([System.IO.Path]::GetTempPath()) ('cmdc-remote-login-' + [guid]::NewGuid().ToString('N') + '.mjs'); try { Invoke-WebRequest -UseBasicParsing -Uri ${powershellQuote(helperUrl)} -OutFile $helperPath; & node $helperPath ${powershellArgs} } finally { Remove-Item -LiteralPath $helperPath -Force -ErrorAction SilentlyContinue }`,
  };
}

function requestHost(request, url, config) {
  return firstForwardedValue(request.headers?.['x-forwarded-host'])
    || firstForwardedValue(request.headers?.host)
    || url.host
    || `127.0.0.1:${Number(config.port)}`;
}

function isLocalConsoleRequest(request, url, config) {
  const directHost = firstForwardedValue(request.headers?.host) || url.host;
  return isLoopbackHost(directHost) || isLoopbackHost(requestHost(request, url, config));
}

function sessionCookie(request, value, maxAge) {
  const attributes = [
    `${CONSOLE_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(request)) attributes.push('Secure');
  return attributes.join('; ');
}

function maskedKey(value) {
  if (value.length <= 10) return '*'.repeat(value.length);
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function safeFilePath(root, requestPath) {
  const relativePath = requestPath.replace(/^\/console\/?/, '') || 'index.html';
  const candidate = resolve(root, relativePath);
  const relativeCandidate = relative(root, candidate);
  if (relativeCandidate.startsWith('..') || relativeCandidate.includes(`..${'/'}`)) return null;
  return candidate;
}

function contentType(path) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }[extname(path).toLowerCase()] || 'application/octet-stream';
}

function successPage(userName) {
  const safeName = String(userName || '账号').replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录成功</title><style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:40px}h1{font-size:24px}p{color:#64748b}</style><main><h1>Command Code 登录成功</h1><p>${safeName}，可以关闭此页面并返回控制台。</p><script>setTimeout(()=>window.close(),800)</script></main>`;
}

function errorPage(message) {
  const safeMessage = String(message || '登录失败').replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录失败</title><style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:40px}h1{font-size:24px}p{color:#64748b}</style><main><h1>Command Code 登录失败</h1><p>${safeMessage}</p></main>`;
}

function normalizeAllowedModelIds(value) {
  if (!Array.isArray(value)) return null;
  const result = [];
  for (const item of value) {
    const modelId = text(item);
    if (modelId && modelId.length <= 256 && !result.includes(modelId)) result.push(modelId);
  }
  return result;
}

function readRuntimeSettings(runtimeDir = DEFAULT_RUNTIME_DIR) {
  const path = join(runtimeDir, 'settings.json');
  if (!existsSync(path)) return { hasAllowlist: false, allowedModelIds: null };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(value) || !hasOwn(value, 'allowedModelIds')) {
      return { hasAllowlist: false, allowedModelIds: null };
    }
    return { hasAllowlist: true, allowedModelIds: normalizeAllowedModelIds(value.allowedModelIds) };
  } catch {
    return { hasAllowlist: false, allowedModelIds: null };
  }
}

function writeRuntimeSettings(runtimeDir, allowedModelIds) {
  const normalized = normalizeAllowedModelIds(allowedModelIds);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  const target = join(runtimeDir, 'settings.json');
  const temporary = join(runtimeDir, `.settings.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ allowedModelIds: normalized }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}

export function createAdminController({
  config,
  projectDir,
  server,
  restart,
  update,
  relaunch,
  runtimeDir = DEFAULT_RUNTIME_DIR,
  authFile = DEFAULT_AUTH_FILE,
  accountsFile = join(runtimeDir, 'accounts.json'),
  distDir = resolve(projectDir, 'web', 'dist'),
}) {
  const browserSessions = new Map();
  const consoleSessions = new Map();
  const loginFailures = new Map();
  const startedAt = new Date().toISOString();
  let modelCache = null;
  let accountStore = readAccountStore(accountsFile, authFile, {
    apiKey: text(readRuntimeCredentials(runtimeDir).CC_API_KEY) || text(config.ccApiKey) || text(config.apiKey),
  });

  function pruneSessions() {
    const now = Date.now();
    for (const [state, session] of browserSessions) {
      if (now - session.createdAt > BROWSER_SESSION_TTL_MS) browserSessions.delete(state);
    }
    for (const [token, session] of consoleSessions) {
      if (now - session.createdAt > CONSOLE_SESSION_TTL_MS) consoleSessions.delete(token);
    }
    for (const [address, attempt] of loginFailures) {
      if (now - attempt.windowStartedAt > 60_000 && now > attempt.blockedUntil) loginFailures.delete(address);
    }
  }

  function invalidateConsoleSessions() {
    consoleSessions.clear();
  }

  function reloadRuntimeConfig() {
    const credentials = readRuntimeCredentials(runtimeDir);
    if (hasOwn(credentials, 'CC_API_KEY')) config.ccApiKey = text(credentials.CC_API_KEY);
    if (hasOwn(credentials, 'GATEWAY_API_KEYS_JSON_B64') || hasOwn(credentials, 'GATEWAY_API_KEYS_JSON') || hasOwn(credentials, 'GATEWAY_API_KEY')) {
      const keys = gatewayKeysFromCredentials(credentials);
      config.gatewayApiKeys = keys.map((item) => item.value);
      config.gatewayApiKey = config.gatewayApiKeys[0] || '';
    }
    const settings = readRuntimeSettings(runtimeDir);
    if (settings.hasAllowlist) config.allowedModelIds = settings.allowedModelIds;
    return credentials;
  }

  function persistAccounts(nextStore) {
    accountStore = writeAccountStore(accountsFile, nextStore);
    return accountStore;
  }

  function activeAccount() {
    return accountStore.accounts.find((account) => account.id === accountStore.activeAccountId) || null;
  }

  function accountPayload() {
    return {
      accounts: publicAccounts(accountStore),
      activeAccountId: accountStore.activeAccountId,
    };
  }

  function findAccount(accountId) {
    return accountStore.accounts.find((account) => account.id === accountId) || null;
  }

  function accountMatches(left, right) {
    if (!left || !right) return false;
    if (left.apiKey === right.apiKey) return true;
    if (left.userId && right.userId && left.userId === right.userId) return true;
    return Boolean(left.email && right.email && left.email === right.email);
  }

  function replaceAccount(nextAccount) {
    const index = accountStore.accounts.findIndex((account) => accountMatches(account, nextAccount));
    if (index < 0) {
      if (accountStore.accounts.length >= MAX_ACCOUNTS) throw new AdminError(`最多支持 ${MAX_ACCOUNTS} 个账号`, 400);
      accountStore.accounts.push(nextAccount);
      return nextAccount;
    }
    const previous = accountStore.accounts[index];
    accountStore.accounts[index] = {
      ...previous,
      ...nextAccount,
      id: previous.id,
      usage: nextAccount.usage ?? previous.usage,
      usageError: nextAccount.usageError ?? previous.usageError,
    };
    return accountStore.accounts[index];
  }

  function storeAccountToken(payload) {
    const token = saveAuthToken(authFile, payload);
    const current = currentCredentials();
    const account = normalizeStoredAccount({
      ...token,
      id: accountIdForToken(token),
    });
    const previousActiveId = accountStore.activeAccountId;
    replaceAccount(account);
    const matched = accountStore.accounts.find((item) => accountMatches(item, account));
    accountStore = persistAccounts({ ...accountStore, activeAccountId: matched?.id || account.id });
    if (previousActiveId !== accountStore.activeAccountId || current.ccApiKey !== account.apiKey) {
      writeActiveAccountRuntime();
    } else {
      saveAuthToken(authFile, matched || account);
    }
    return { token, account: matched || account };
  }

  async function verifyAndStoreToken(apiKey, keyName) {
    let whoami;
    try {
      const base = text(config.apiBase) || DEFAULT_API_BASE;
      whoami = await fetchJson(`${base}/alpha/whoami?limits=1`, apiKey);
    } catch (error) {
      if (error instanceof AdminError && error.status === 401) {
        throw new AdminError('Command Code API Key 无效，请重新授权后再试', 400);
      }
      throw error;
    }
    const user = isObject(whoami?.user) ? whoami.user : {};
    return storeAccountToken({
      apiKey,
      userId: text(user.id || user.userId || 'commandcode-account'),
      userName: text(user.userName || user.name || 'Command Code 账号'),
      email: text(user.email),
      keyName,
    });
  }

  function writeActiveAccountRuntime() {
    const current = currentCredentials();
    const account = activeAccount();
    if (account) {
      saveAuthToken(authFile, account);
      writeRuntimeCredentials(runtimeDir, { ccApiKey: account.apiKey, gatewayKeys: current.gatewayKeys });
    } else {
      clearAuthToken(authFile);
      writeRuntimeCredentials(runtimeDir, { ccApiKey: '', gatewayKeys: current.gatewayKeys });
    }
    reloadRuntimeConfig();
  }

  function activateStoredAccount(accountId) {
    const account = findAccount(accountId);
    if (!account) throw new AdminError('账号不存在', 404);
    if (accountStore.activeAccountId !== account.id) {
      accountStore = persistAccounts({ ...accountStore, activeAccountId: account.id });
      writeActiveAccountRuntime();
    }
    return account;
  }

  function updateAccount(accountId, updater) {
    const account = findAccount(accountId);
    if (!account) return null;
    const index = accountStore.accounts.findIndex((item) => item.id === accountId);
    accountStore.accounts[index] = updater(account);
    persistAccounts(accountStore);
    return accountStore.accounts[index];
  }

  function mergeAccountUsage(account, usage) {
    return {
      ...account,
      userId: usage.account.id || account.userId,
      userName: usage.account.userName || account.userName,
      email: usage.account.email || account.email,
      usage,
      usageError: '',
    };
  }

  function hasAvailableQuotas(account) {
    return Boolean(account && !account.usageError && usageHasAvailableQuotas(account.usage));
  }

  function nextAvailableAccount(accountId) {
    const currentIndex = accountStore.accounts.findIndex((account) => account.id === accountId);
    if (currentIndex < 0) return null;
    for (let offset = 1; offset < accountStore.accounts.length; offset += 1) {
      const account = accountStore.accounts[(currentIndex + offset) % accountStore.accounts.length];
      if (hasAvailableQuotas(account)) return account;
    }
    return null;
  }

  function autoSwitchExhaustedAccount(accountId) {
    const current = findAccount(accountId);
    if (!current || accountStore.activeAccountId !== accountId || !usageHasExhaustedQuota(current.usage)) {
      return { switched: false, account: activeAccount() };
    }
    const next = nextAvailableAccount(accountId);
    if (!next) return { switched: false, account: current };
    activateStoredAccount(next.id);
    return {
      switched: true,
      previousAccountId: accountId,
      account: activeAccount(),
    };
  }

  // 上游请求过程中命中额度窗口限制时，立即把当前账号标记为耗尽并切换，
  // 不再等待控制台 60 秒一次的用量轮询。
  function handleUpstreamQuotaLimit(info) {
    const limit = parseUpstreamQuotaLimit(info || {});
    if (!limit) return { detected: false, switched: false };
    const current = activeAccount();
    if (!current) return { detected: true, switched: false, window: limit.window, resetAt: limit.resetAtMs };
    // 同一次失败请求可能产生多个错误事件；切号后迟到的旧账号事件不能误伤新账号。
    if (info?.apiKey && current.apiKey !== info.apiKey) {
      return { detected: true, switched: false, stale: true, window: limit.window, resetAt: limit.resetAtMs };
    }
    markQuotaExhausted(current.id, limit.window);
    const switchResult = autoSwitchExhaustedAccount(current.id);
    return { detected: true, window: limit.window, resetAt: limit.resetAtMs, ...switchResult };
  }

  function markQuotaExhausted(accountId, quotaKey) {
    if (!quotaKey) return;
    updateAccount(accountId, (account) => {
      const usage = isObject(account.usage) ? account.usage : {};
      const quota = isObject(usage[quotaKey]) ? usage[quotaKey] : {};
      return {
        ...account,
        usage: { ...usage, [quotaKey]: { ...quota, known: true, exceeded: true } },
        usageError: '',
      };
    });
  }

  function initializeAccountStore() {
    if (accountStore.migrated || !existsSync(accountsFile)) {
      accountStore = writeAccountStore(accountsFile, accountStore);
    }
    const account = activeAccount();
    const runtimeCredentials = readRuntimeCredentials(runtimeDir);
    if (account && text(runtimeCredentials.CC_API_KEY) !== account.apiKey) {
      writeActiveAccountRuntime();
    } else if (account) {
      config.ccApiKey = account.apiKey;
      if (readAuthToken(authFile)?.apiKey !== account.apiKey) saveAuthToken(authFile, account);
    }
  }

  function currentCredentials() {
    const credentials = readRuntimeCredentials(runtimeDir);
    const hasRuntimeKeys = hasOwn(credentials, 'GATEWAY_API_KEYS_JSON_B64')
      || hasOwn(credentials, 'GATEWAY_API_KEYS_JSON')
      || hasOwn(credentials, 'GATEWAY_API_KEY');
    const gatewayKeys = hasRuntimeKeys
      ? gatewayKeysFromCredentials(credentials)
      : normalizeGatewayKeys(config.gatewayApiKeys, config.gatewayApiKey);
    const storedActive = activeAccount();
    return {
      ccApiKey: storedActive?.apiKey || (hasOwn(credentials, 'CC_API_KEY')
        ? text(credentials.CC_API_KEY)
        : text(config.ccApiKey) || text(config.apiKey)),
      gatewayKeys,
    };
  }

  initializeAccountStore();

  function visibleKeys(keys) {
    return keys.map((item, index) => ({
      id: item.id,
      label: `密钥 ${index + 1}`,
      masked: maskedKey(item.value),
      isFirst: index === 0,
      createdAt: item.createdAt,
    }));
  }

  function createConsoleSession() {
    const token = randomBytes(32).toString('base64url');
    consoleSessions.set(token, { createdAt: Date.now() });
    return token;
  }

  function getConsoleSession(request) {
    const token = parseCookies(request)[CONSOLE_COOKIE_NAME];
    if (!token) return null;
    const session = consoleSessions.get(token);
    if (!session) return null;
    if (Date.now() - session.createdAt > CONSOLE_SESSION_TTL_MS) {
      consoleSessions.delete(token);
      return null;
    }
    return { token, session };
  }

  function requireConsoleSession(request, response) {
    const credentials = currentCredentials();
    if (credentials.gatewayKeys.length === 0) {
      sendJson(response, 409, { ok: false, error: '还没有设置网关密钥，请先设置第一个密钥' });
      return null;
    }
    const current = getConsoleSession(request);
    if (!current) {
      sendJson(response, 401, { ok: false, error: '控制台登录已失效，请重新登录' });
      return null;
    }
    return current;
  }

  function loginAddress(request) {
    return request.socket?.remoteAddress || 'unknown';
  }

  function checkLoginThrottle(address) {
    const attempt = loginFailures.get(address);
    if (attempt?.blockedUntil > Date.now()) {
      throw new AdminError('登录尝试过于频繁，请稍后再试', 429);
    }
  }

  function recordLoginFailure(address) {
    const now = Date.now();
    const current = loginFailures.get(address);
    const attempt = current && now - current.windowStartedAt <= 60_000
      ? current
      : { count: 0, windowStartedAt: now, blockedUntil: 0 };
    attempt.count += 1;
    if (attempt.count >= 5) attempt.blockedUntil = now + 30_000;
    loginFailures.set(address, attempt);
  }

  async function readAvailableModels(configValue, apiKey, forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && modelCache && now - modelCache.fetchedAt < 5 * 60 * 1000) return modelCache.models;
    const base = text(configValue.apiBase) || DEFAULT_API_BASE;
    const payload = await fetchJson(`${base}/provider/v1/models`, apiKey);
    const rawModels = Array.isArray(payload.data) ? payload.data : [];
    const models = rawModels
      .map((item) => ({
        id: text(item?.id),
        name: text(item?.name || item?.id),
        ownedBy: text(item?.owned_by || item?.ownedBy || 'provider'),
      }))
      .filter((item, index, list) => item.id && list.findIndex((candidate) => candidate.id === item.id) === index);
    if (models.length === 0) throw new AdminError('Command Code 没有返回可用模型', 502);
    modelCache = { fetchedAt: now, models };
    return models;
  }

  function modelPayload(models) {
    const configured = Array.isArray(config.allowedModelIds) ? new Set(config.allowedModelIds) : null;
    const selectedModelIds = models.filter((model) => !configured || configured.has(model.id)).map((model) => model.id);
    return {
      models: models.map((model) => ({ ...model, allowed: !configured || configured.has(model.id) })),
      selectedModelIds,
      allSelected: !configured,
      fetchedAt: modelCache?.fetchedAt ? new Date(modelCache.fetchedAt).toISOString() : null,
    };
  }

  async function handleApi(request, response, url) {
    pruneSessions();

    if (url.pathname === '/admin/api/status' && request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        healthy: Boolean(server?.listening),
        pid: process.pid,
        host: config.host,
        port: Number(config.port),
        startedAt,
      });
      return true;
    }

    if (url.pathname === '/admin/api/auth/state' && request.method === 'GET') {
      const credentials = currentCredentials();
      const current = getConsoleSession(request);
      sendJson(response, 200, {
        ok: true,
        configured: credentials.gatewayKeys.length > 0,
        authenticated: Boolean(current && credentials.gatewayKeys.length > 0),
        account: current ? publicAccount(activeAccount(), accountStore.activeAccountId) : null,
      });
      return true;
    }

    if (url.pathname === '/admin/api/auth/login' && request.method === 'POST') {
      try {
        const body = await readBody(request);
        const password = text(body.password || body.gatewayApiKey);
        const credentials = currentCredentials();
        if (credentials.gatewayKeys.length === 0) throw new AdminError('还没有设置网关密钥，请先设置第一个密钥', 409);
        const address = loginAddress(request);
        checkLoginThrottle(address);
        if (!safeEqual(password, credentials.gatewayKeys[0].value)) {
          recordLoginFailure(address);
          throw new AdminError('网关密钥错误', 401);
        }
        loginFailures.delete(address);
        const sessionToken = createConsoleSession();
        sendJson(response, 200, { ok: true, authenticated: true }, {
          'Set-Cookie': sessionCookie(request, sessionToken, CONSOLE_SESSION_TTL_MS / 1000),
        });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/bootstrap' && request.method === 'POST') {
      try {
        const credentials = currentCredentials();
        if (credentials.gatewayKeys.length > 0) throw new AdminError('网关密钥已经设置，请使用第一个密钥登录', 409);
        const body = await readBody(request);
        const gatewayApiKey = validateGatewayKey(body.gatewayApiKey || body.password);
        const gatewayKeys = [{ id: `key-${randomBytes(10).toString('hex')}`, value: gatewayApiKey, createdAt: new Date().toISOString() }];
        writeRuntimeCredentials(runtimeDir, { ccApiKey: credentials.ccApiKey, gatewayKeys });
        reloadRuntimeConfig();
        const sessionToken = createConsoleSession();
        sendJson(response, 200, { ok: true, configured: true, authenticated: true, gatewayKeys: visibleKeys(gatewayKeys) }, {
          'Set-Cookie': sessionCookie(request, sessionToken, CONSOLE_SESSION_TTL_MS / 1000),
        });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/auth/logout' && request.method === 'POST') {
      const current = getConsoleSession(request);
      if (current) consoleSessions.delete(current.token);
      sendJson(response, 200, { ok: true, authenticated: false }, {
        'Set-Cookie': sessionCookie(request, '', 0),
      });
      return true;
    }

    if (url.pathname === '/admin/api/auth/bridge/helper' && request.method === 'GET') {
      const helperPath = join(projectDir, 'tools', 'remote-login.mjs');
      if (!existsSync(helperPath)) {
        sendText(response, 404, '授权助手不存在');
        return true;
      }
      try {
        sendText(response, 200, readFileSync(helperPath, 'utf8'), 'text/javascript; charset=utf-8');
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/auth/bridge/complete' && request.method === 'POST') {
      try {
        if (!isSecureRequest(request)) throw new AdminError('远程授权助手必须通过 HTTPS 提交', 400);
        const body = await readBody(request);
        const state = text(body.state);
        const ticket = text(body.ticket);
        const session = browserSessions.get(state);
        if (!session || session.mode !== 'bridge' || !ticket || !session.ticketHash || !safeEqual(hashBridgeTicket(ticket), session.ticketHash)) {
          throw new AdminError('授权助手票据无效或已过期', 400);
        }
        if (session.status !== 'pending') throw new AdminError('远程授权会话已经使用，请重新点击“添加账号”', 400);

        session.ticketHash = '';
        if (body.error) {
          session.status = 'error';
          session.error = text(body.errorDescription || body.error).slice(0, 240) || '官方授权失败';
          sendJson(response, 200, { ok: true, status: session.status });
          return true;
        }

        try {
          const apiKey = validateUpstreamToken(body.apiKey);
          const stored = await verifyAndStoreToken(apiKey, 'web-bridge-helper');
          session.status = 'success';
          session.account = publicAccount(stored.account, accountStore.activeAccountId);
          sendJson(response, 200, {
            ok: true,
            status: session.status,
            account: session.account,
          });
        } catch (error) {
          session.status = 'error';
          session.error = error instanceof AdminError ? error.message : '远程授权处理失败';
          throw error;
        }
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    const currentSession = requireConsoleSession(request, response);
    if (!currentSession) return true;

    if (url.pathname === '/admin/api/config' && request.method === 'GET') {
      const credentials = currentCredentials();
      sendJson(response, 200, {
        ok: true,
        gatewayKeys: visibleKeys(credentials.gatewayKeys),
        gatewayApiKeyCount: credentials.gatewayKeys.length,
        hasUpstreamToken: Boolean(activeAccount()?.apiKey || credentials.ccApiKey),
        account: publicAccount(activeAccount(), accountStore.activeAccountId) || readAuthMetadata(authFile),
        ...accountPayload(),
      });
      return true;
    }

    if (url.pathname === '/admin/api/accounts' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, ...accountPayload() });
      return true;
    }

    if (url.pathname.startsWith('/admin/api/accounts/') && url.pathname.endsWith('/activate') && request.method === 'POST') {
      try {
        const accountId = decodeURIComponent(url.pathname.slice('/admin/api/accounts/'.length, -'/activate'.length));
        const account = activateStoredAccount(accountId);
        sendJson(response, 200, {
          ok: true,
          account: publicAccount(account, accountStore.activeAccountId),
          ...accountPayload(),
        });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname.startsWith('/admin/api/accounts/') && request.method === 'DELETE') {
      try {
        const accountId = decodeURIComponent(url.pathname.slice('/admin/api/accounts/'.length));
        const account = findAccount(accountId);
        if (!account) throw new AdminError('账号不存在', 404);
        const wasActive = accountStore.activeAccountId === accountId;
        const remaining = accountStore.accounts.filter((item) => item.id !== accountId);
        const nextActiveId = wasActive ? (remaining[0]?.id || null) : accountStore.activeAccountId;
        accountStore = persistAccounts({ ...accountStore, activeAccountId: nextActiveId, accounts: remaining });
        if (wasActive) writeActiveAccountRuntime();
        sendJson(response, 200, { ok: true, ...accountPayload() });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/accounts/refresh' && request.method === 'POST') {
      try {
        if (accountStore.accounts.length === 0) throw new AdminError('还没有保存的 Command Code 账号', 400);
        const activeAccountId = accountStore.activeAccountId;
        const results = await Promise.all(accountStore.accounts.map(async (account) => {
          try {
            const usage = await readUsage(config, account.apiKey);
            return {
              account: mergeAccountUsage(account, usage),
              refreshed: true,
            };
          } catch (error) {
            return {
              account: { ...account, usageError: error instanceof AdminError ? error.message : '用量同步失败' },
              refreshed: false,
            };
          }
        }));
        accountStore = persistAccounts({ ...accountStore, accounts: results.map((result) => result.account) });
        const activeWasRefreshed = results.some((result) => result.refreshed && result.account.id === activeAccountId);
        const switchResult = activeWasRefreshed
          ? autoSwitchExhaustedAccount(activeAccountId)
          : { switched: false, account: activeAccount() };
        sendJson(response, 200, {
          ok: true,
          autoSwitched: switchResult.switched,
          ...accountPayload(),
        });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/config' && request.method === 'POST') {
      try {
        const body = await readBody(request);
        const gatewayApiKey = validateGatewayKey(body.gatewayApiKey);
        const current = currentCredentials();
        const gatewayKeys = current.gatewayKeys.length > 0
          ? [{ ...current.gatewayKeys[0], value: gatewayApiKey }, ...current.gatewayKeys.slice(1)]
          : [{ id: `key-${randomBytes(10).toString('hex')}`, value: gatewayApiKey, createdAt: new Date().toISOString() }];
        writeRuntimeCredentials(runtimeDir, { ccApiKey: current.ccApiKey, gatewayKeys });
        reloadRuntimeConfig();
        invalidateConsoleSessions();
        sendJson(response, 200, { ok: true, gatewayKeys: visibleKeys(gatewayKeys), reauthenticate: true }, {
          'Set-Cookie': sessionCookie(request, '', 0),
        });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/keys' && request.method === 'POST') {
      try {
        const body = await readBody(request);
        const gatewayApiKey = validateGatewayKey(body.gatewayApiKey);
        const current = currentCredentials();
        if (current.gatewayKeys.length >= MAX_GATEWAY_KEYS) throw new AdminError(`最多支持 ${MAX_GATEWAY_KEYS} 个网关密钥`, 400);
        if (current.gatewayKeys.some((item) => safeEqual(item.value, gatewayApiKey))) throw new AdminError('这个网关密钥已经存在', 409);
        const gatewayKeys = [...current.gatewayKeys, {
          id: `key-${randomBytes(10).toString('hex')}`,
          value: gatewayApiKey,
          createdAt: new Date().toISOString(),
        }];
        writeRuntimeCredentials(runtimeDir, { ccApiKey: current.ccApiKey, gatewayKeys });
        reloadRuntimeConfig();
        sendJson(response, 200, { ok: true, gatewayKeys: visibleKeys(gatewayKeys) });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname.startsWith('/admin/api/keys/') && request.method === 'DELETE') {
      try {
        const id = decodeURIComponent(url.pathname.slice('/admin/api/keys/'.length));
        const current = currentCredentials();
        const index = current.gatewayKeys.findIndex((item) => item.id === id);
        if (index < 0) throw new AdminError('网关密钥不存在', 404);
        const gatewayKeys = current.gatewayKeys.filter((_, itemIndex) => itemIndex !== index);
        writeRuntimeCredentials(runtimeDir, { ccApiKey: current.ccApiKey, gatewayKeys });
        reloadRuntimeConfig();
        const shouldReauthenticate = index === 0 || gatewayKeys.length === 0;
        if (shouldReauthenticate) invalidateConsoleSessions();
        sendJson(response, 200, {
          ok: true,
          configured: gatewayKeys.length > 0,
          gatewayKeys: visibleKeys(gatewayKeys),
          reauthenticate: shouldReauthenticate,
        }, shouldReauthenticate ? { 'Set-Cookie': sessionCookie(request, '', 0) } : {});
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/usage' && request.method === 'GET') {
      let requestedAccountId = '';
      try {
        const account = activeAccount();
        if (!account?.apiKey) throw new AdminError('请先完成 Command Code 浏览器登录');
        requestedAccountId = account.id;
        const usage = await readUsage(config, account.apiKey);
        updateAccount(requestedAccountId, (current) => mergeAccountUsage(current, usage));
        const switchResult = autoSwitchExhaustedAccount(requestedAccountId);
        const selected = switchResult.account || activeAccount();
        sendJson(response, 200, {
          ok: true,
          usage: selected?.usage || usage,
          autoSwitched: switchResult.switched,
          ...accountPayload(),
        });
      } catch (error) {
        const account = findAccount(requestedAccountId) || activeAccount();
        if (account) updateAccount(account.id, (current) => ({ ...current, usageError: error instanceof AdminError ? error.message : '用量同步失败' }));
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/models' && request.method === 'GET') {
      try {
        const account = activeAccount();
        if (!account?.apiKey) throw new AdminError('请先完成 Command Code 浏览器登录');
        const models = await readAvailableModels(config, account.apiKey, url.searchParams.get('refresh') === '1');
        sendJson(response, 200, { ok: true, ...modelPayload(models) });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/models' && request.method === 'POST') {
      try {
        const body = await readBody(request);
        if (!Array.isArray(body.modelIds)) throw new AdminError('modelIds 必须是数组');
        const account = activeAccount();
        if (!account?.apiKey) throw new AdminError('请先完成 Command Code 浏览器登录');
        const models = await readAvailableModels(config, account.apiKey, true);
        const availableIds = new Set(models.map((model) => model.id));
        const selected = normalizeAllowedModelIds(body.modelIds);
        const unknown = selected.filter((modelId) => !availableIds.has(modelId));
        if (unknown.length > 0) throw new AdminError(`存在不可用模型：${unknown.slice(0, 3).join('、')}`);
        const nextAllowlist = selected.length === models.length ? null : selected;
        writeRuntimeSettings(runtimeDir, nextAllowlist);
        config.allowedModelIds = nextAllowlist;
        sendJson(response, 200, { ok: true, ...modelPayload(models) });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/auth/start' && request.method === 'POST') {
      try {
        const state = randomBytes(24).toString('base64url');
        const local = isLocalConsoleRequest(request, url, config);
        let origin = null;
        if (!local) {
          if (!isSecureRequest(request)) throw new AdminError('远程添加账号必须通过 HTTPS 控制台进行', 400);
          origin = requestOrigin(request, url, config);
          if (origin.protocol !== 'https:') throw new AdminError('远程添加账号必须使用 HTTPS 地址', 400);
        }
        const session = { createdAt: Date.now(), status: 'pending', mode: local ? 'browser' : 'bridge' };
        browserSessions.set(state, session);
        if (!local) {
          const ticket = randomBytes(32).toString('base64url');
          session.ticketHash = hashBridgeTicket(ticket);
          session.expiresAt = Date.now() + BRIDGE_SESSION_TTL_MS;
          const commands = bridgeCommands(origin, state, ticket);
          sendJson(response, 200, {
            ok: true,
            state,
            mode: 'bridge',
            ...commands,
            expiresIn: BRIDGE_SESSION_TTL_MS / 1000,
          });
          return true;
        }
        const callback = browserCallbackUrl(request, url, config);
        const loginUrl = new URL('/studio/auth/cli', CALLBACK_BASE);
        loginUrl.searchParams.set('callback', callback);
        loginUrl.searchParams.set('state', state);
        loginUrl.searchParams.set('mode', 'redirect');
        loginUrl.searchParams.set('client', 'commandcode-proxy-web');
        loginUrl.searchParams.set('prompt', 'login');
        sendJson(response, 200, {
          ok: true,
          state,
          mode: 'browser',
          loginUrl: loginUrl.toString(),
          expiresIn: BROWSER_SESSION_TTL_MS / 1000,
        });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/auth/token' && request.method === 'POST') {
      try {
        const body = await readBody(request);
        const state = text(body.state);
        const session = browserSessions.get(state);
        if (!session || session.mode !== 'manual') throw new AdminError('远程添加账号会话不存在或已过期', 400);
        if (session.status !== 'pending') throw new AdminError('远程添加账号会话已经使用，请重新点击“添加账号”', 400);
        if (!isSecureRequest(request)) throw new AdminError('远程添加账号必须通过 HTTPS 控制台提交', 400);
        const apiKey = validateUpstreamToken(body.apiKey || body.token);
        const stored = await verifyAndStoreToken(apiKey, 'web-manual-entry');
        session.status = 'success';
        session.account = publicAccount(stored.account, accountStore.activeAccountId);
        sendJson(response, 200, {
          ok: true,
          account: session.account,
          ...accountPayload(),
        });
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    if (url.pathname === '/admin/api/auth/status' && request.method === 'GET') {
      const state = text(url.searchParams.get('state'));
      const session = browserSessions.get(state);
      if (!session) {
        sendJson(response, 404, { ok: false, error: '登录会话不存在或已过期' });
        return true;
      }
      sendJson(response, 200, {
        ok: true,
        status: session.status,
        account: session.account || null,
        error: session.error || null,
      });
      return true;
    }

    if (url.pathname === '/admin/api/restart' && request.method === 'POST') {
      sendJson(response, 202, { ok: true, restarting: true });
      setTimeout(() => {
        Promise.resolve(restart?.()).catch((error) => {
          console.error('[console] Proxy restart failed:', error);
        });
      }, 60);
      return true;
    }

    if (url.pathname === '/admin/api/update' && request.method === 'POST') {
      try {
        if (typeof update !== 'function') throw new AdminError('当前运行方式不支持自动更新', 503);
        const result = await update();
        sendJson(response, 202, { ok: true, updating: true, ...result });
        setTimeout(() => {
          Promise.resolve((relaunch || restart)?.()).catch((error) => {
            console.error('[console] Proxy relaunch failed:', error);
          });
        }, 120);
      } catch (error) {
        sendError(response, error);
      }
      return true;
    }

    sendJson(response, 404, { ok: false, error: '管理接口不存在' });
    return true;
  }

  async function handleCallback(request, response, url) {
    let state = '';
    try {
      const payload = request.method === 'GET'
        ? Object.fromEntries(url.searchParams.entries())
        : await readBody(request);
      state = text(payload.state);
      const session = browserSessions.get(state);
      if (!session) throw new AdminError('登录状态无效或已过期', 400);
      if (session.mode !== 'browser') throw new AdminError('远程添加账号请使用手动 API Key 流程', 400);
      if (!isLocalConsoleRequest(request, url, config)) throw new AdminError('浏览器回调只允许来自本机控制台', 400);
      if (payload.error) throw new AdminError(text(payload.error_description) || text(payload.error));
      if (!text(payload.apiKey)) throw new AdminError('登录回调缺少 apiKey');
      const stored = storeAccountToken(payload);
      session.status = 'success';
      session.account = publicAccount(stored.account, accountStore.activeAccountId);
      sendText(response, 200, successPage(stored.token.userName), 'text/html; charset=utf-8');
    } catch (error) {
      const session = browserSessions.get(state || text(url.searchParams.get('state')));
      if (session?.mode === 'browser') {
        session.status = 'error';
        session.error = error instanceof AdminError ? error.message : '登录回调处理失败';
      }
      sendText(response, error instanceof AdminError ? error.status : 500, errorPage(error.message), 'text/html; charset=utf-8');
    }
    return true;
  }

  function handleStatic(request, response, url) {
    const path = safeFilePath(distDir, url.pathname);
    if (!path || !existsSync(path)) {
      sendText(response, 404, '控制台资源不存在');
      return true;
    }
    try {
      const body = readFileSync(path);
      response.writeHead(200, {
        'Content-Type': contentType(path),
        'Cache-Control': path.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      });
      response.end(body);
    } catch (error) {
      sendError(response, error);
    }
    return true;
  }

  return {
    async handle(request, response, url) {
      const isConsole = url.pathname === '/console' || url.pathname.startsWith('/console/');
      const isAdmin = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
      const isCallback = url.pathname === '/callback';
      if (!isConsole && !isAdmin && !isCallback) return false;
      if (isCallback || url.pathname === '/admin/auth/callback') {
        if (!['GET', 'POST'].includes(request.method)) {
          sendText(response, 405, '仅支持 GET 或 POST');
          return true;
        }
        return handleCallback(request, response, url);
      }
      if (url.pathname.startsWith('/admin/api/')) return handleApi(request, response, url);
      if (url.pathname === '/console' || url.pathname === '/console/') {
        return handleStatic(request, response, new URL('/console/index.html', url));
      }
      if (url.pathname.startsWith('/console/assets/') || url.pathname === '/console/favicon.svg') {
        return handleStatic(request, response, url);
      }
      sendText(response, 404, '控制台页面不存在');
      return true;
    },
    handleUpstreamQuotaLimit,
  };
}

export {
  accountIdForToken,
  gatewayKeysFromCredentials,
  normalizeUsage,
  normalizeStoredAccount,
  readAccountStore,
  readRuntimeCredentials,
  readRuntimeSettings,
  usageHasAvailableQuotas,
  usageHasExhaustedQuota,
  writeAccountStore,
  windowSnapshot,
};
