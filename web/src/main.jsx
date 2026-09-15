import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowUpRight,
  Check,
  CheckCheck,
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
  UserRound,
  X,
} from 'lucide-react';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Input } from './components/ui/input';
import { Progress } from './components/ui/progress';
import { Separator } from './components/ui/separator';
import { cn, formatDate, formatFetchedAt, formatMoney } from './lib/utils';
import './styles.css';

const API_ROOT = '/admin/api';

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    throw new RequestError(`无法连接本地代理：${error.message || error}`, 0);
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload.ok === false) {
    throw new RequestError(payload.error || `请求失败（${response.status}）`, response.status);
  }
  return payload;
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function Brand({ compact = false }) {
  return (
    <div className={cn('brand', compact && 'brand-compact')}>
      <div className="brand-mark"><span>CC</span></div>
      {!compact && (
        <div>
          <div className="brand-name">Command Code</div>
          <div className="brand-subtitle">代理控制台</div>
        </div>
      )}
    </div>
  );
}

function SecretInput({ id, name, value, onChange, shown, onToggle, placeholder, autoFocus = false, autoComplete = 'off' }) {
  return (
    <div className="secret-input-wrap">
      <Input
        id={id}
        name={name}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="secret-toggle"
        onClick={onToggle}
        aria-label={shown ? '隐藏密钥' : '显示密钥'}
        title={shown ? '隐藏密钥' : '显示密钥'}
      >
        {shown ? <EyeOff size={17} /> : <Eye size={17} />}
      </Button>
    </div>
  );
}

function AuthLayout({ eyebrow, title, description, children, footer }) {
  return (
    <main className="auth-page">
      <div className="auth-shell">
        <div className="auth-brand-block">
          <Brand />
          <div className="auth-brand-copy">
            <div className="auth-kicker">Command Code Console</div>
            <h1>简洁、清晰的代理控制中心</h1>
            <p>管理访问密钥、模型权限与账号用量。</p>
          </div>
          <div className="auth-brand-stamp"><LockKeyhole size={16} /> 私密运行环境</div>
        </div>
        <section className="auth-card">
          <div className="auth-card-heading">
            <div className="auth-eyebrow">{eyebrow}</div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          {children}
          {footer && <div className="auth-footer">{footer}</div>}
        </section>
      </div>
    </main>
  );
}

function SetupPage({ value, setValue, shown, setShown, onSubmit, saving, error }) {
  return (
    <AuthLayout
      eyebrow="首次设置"
      title="设置第一个网关密钥"
      description="它会同时作为公网控制台登录密码和第一个代理访问密钥。"
      footer={<span><ShieldCheck size={14} /> 密钥仅保存在当前运行环境</span>}
    >
      <form className="auth-form" onSubmit={onSubmit}>
        <label htmlFor="bootstrap-key">网关 API Key</label>
        <SecretInput
          id="bootstrap-key"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          shown={shown}
          onToggle={() => setShown((current) => !current)}
          placeholder="至少 8 个字符"
          autoFocus
        />
        {error && <div className="auth-error"><CircleAlert size={16} /><span>{error}</span></div>}
        <Button type="submit" size="lg" className="auth-submit" disabled={saving || value.trim().length < 8}>
          {saving ? <LoaderCircle size={17} className="spin" /> : <KeyRound size={17} />}
          保存并进入控制台
        </Button>
      </form>
    </AuthLayout>
  );
}

function LoginPage({ value, setValue, shown, setShown, onSubmit, saving, error }) {
  return (
    <AuthLayout
      eyebrow="安全登录"
      title="进入代理控制台"
      description="请输入第一个网关密钥。它是当前公网控制台的登录密码。"
      footer={<span><LockKeyhole size={14} /> 会话有效期 12 小时</span>}
    >
      <form className="auth-form" onSubmit={onSubmit}>
        <label htmlFor="console-password">控制台密码</label>
        <SecretInput
          id="console-password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          shown={shown}
          onToggle={() => setShown((current) => !current)}
          placeholder="输入第一个网关密钥"
          autoFocus
        />
        {error && <div className="auth-error"><CircleAlert size={16} /><span>{error}</span></div>}
        <Button type="submit" size="lg" className="auth-submit" disabled={saving || !value.trim()}>
          {saving ? <LoaderCircle size={17} className="spin" /> : <LogIn size={17} />}
          登录控制台
        </Button>
      </form>
    </AuthLayout>
  );
}

function LoadingPage() {
  return (
    <main className="auth-page loading-page">
      <div className="loading-mark"><LoaderCircle size={22} className="spin" /></div>
      <span>正在连接代理控制台</span>
    </main>
  );
}

function WindowCard({ title, caption, data, tone = 'mint' }) {
  const used = Number(data?.used || 0);
  const cap = Number(data?.cap || 0);
  const ratio = Number(data?.ratio || 0);
  const remaining = Number(data?.remaining || 0);
  const calls = data?.totalCount;
  const tokens = Number(data?.totalTokens || 0);
  const tokenLabel = `${(tokens / 1_000_000).toFixed(2)}M tokens`;
  return (
    <Card className="window-card">
      <CardHeader className="window-header">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{caption}</CardDescription>
        </div>
        <span className={cn('window-percent', ratio >= 0.8 && 'window-percent-warn')}>{Math.round(ratio * 100)}%</span>
      </CardHeader>
      <CardContent>
        <Progress value={ratio} indicatorClassName={tone === 'orange' ? 'progress-orange' : 'progress-mint'} />
        <div className="window-numbers">
          <span><strong>{formatMoney(used)}</strong> 已用</span>
          <span>{formatMoney(cap)} 上限</span>
        </div>
        <div className="window-footer">
          <span className="window-remaining">剩余 {formatMoney(remaining)}</span>
          <span className="reset-time"><Clock3 size={14} /> {formatDate(data?.resetAt)} 重置</span>
        </div>
        {calls !== undefined && <div className="window-calls"><span>本月调用次数 {Number(calls || 0).toLocaleString('zh-CN')} 次</span>{data?.totalTokens !== undefined && <span>总 Token {tokenLabel}</span>}</div>}
      </CardContent>
    </Card>
  );
}

function SectionHeading({ eyebrow, title, description, action }) {
  return (
    <div className="section-heading">
      <div>
        <div className="section-eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}

function Notice({ type = 'error', children }) {
  const Icon = type === 'success' ? Check : CircleAlert;
  return <div className={`${type}-banner`}><Icon size={17} /><span>{children}</span></div>;
}

function EmptyUsage() {
  return (
    <Card className="empty-state">
      <CardContent>
        <div className="empty-icon"><KeyRound size={21} /></div>
        <div>
          <h3>还没有连接 Command Code 账号</h3>
          <p>完成官方授权后，用量数据会自动同步到这里。</p>
        </div>
      </CardContent>
    </Card>
  );
}

function AuthBanner({ session, onOpen, onCancel, onSubmitToken, token, tokenShown, onTokenChange, onToggleToken, tokenSaving }) {
  if (!session) return null;
  if (session.mode === 'bridge') {
    const helperCommand = /Windows/i.test(navigator.userAgent) ? session.powershellCommand : session.command;
    const commandLabel = /Windows/i.test(navigator.userAgent) ? 'Windows PowerShell' : '终端';
    const copyCommand = async () => {
      try {
        await navigator.clipboard.writeText(helperCommand || '');
      } catch {
        // 剪贴板不可用时不影响用户手动复制命令。
      }
    };
    return (
      <div className="auth-banner auth-banner-bridge">
        <div className="auth-banner-icon"><KeyRound size={18} /></div>
        <div className="auth-banner-copy">
          <strong>远程授权助手已准备</strong>
          <span>在你自己的电脑终端运行下面命令，官方授权完成后会自动添加账号，无需获取或粘贴 token。</span>
        </div>
        <div className="auth-helper-command">
          <div className="auth-helper-command-heading"><span>{commandLabel}命令</span><span>有效期约 10 分钟</span></div>
          <div className="auth-helper-command-line">
            <code>{helperCommand || '授权命令生成失败，请重新点击“添加账号”。'}</code>
            <Button type="button" size="icon" variant="ghost" onClick={copyCommand} aria-label="复制授权命令" title="复制授权命令"><Copy size={15} /></Button>
          </div>
        </div>
        <p className="auth-banner-note">请保持此页面打开。授权助手只在本机接收官方回调，并通过 HTTPS 提交到当前远程控制台；完成后会自动关闭本地回调服务。</p>
        <Button type="button" size="icon" variant="ghost" aria-label="取消添加账号" title="取消添加账号" onClick={onCancel}><X size={17} /></Button>
      </div>
    );
  }
  if (session.mode === 'manual') {
    return (
      <div className="auth-banner auth-banner-manual">
        <div className="auth-banner-icon"><KeyRound size={18} /></div>
        <div className="auth-banner-copy">
          <strong>远程添加账号</strong>
          <span>官方授权只接受本机回调，请粘贴已在可信设备完成登录的 API Key。</span>
        </div>
        <form className="auth-token-form" onSubmit={onSubmitToken}>
          <label htmlFor="remote-commandcode-token">Command Code API Key</label>
          <SecretInput
            id="remote-commandcode-token"
            name="commandcode-api-key"
            value={token}
            onChange={onTokenChange}
            shown={tokenShown}
            onToggle={() => onToggleToken(!tokenShown)}
            placeholder="粘贴 API Key，不会显示在地址栏"
            autoComplete="new-password"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={tokenSaving || !token.trim()}>
            {tokenSaving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
            验证并添加
          </Button>
        </form>
        <p className="auth-banner-note">请使用 HTTPS 访问此控制台。若要保留官方浏览器授权，可通过 SSH 端口转发后访问本机地址。</p>
        <Button type="button" size="icon" variant="ghost" aria-label="取消添加账号" title="取消添加账号" onClick={onCancel}><X size={17} /></Button>
      </div>
    );
  }
  return (
    <div className="auth-banner">
      <div className="auth-banner-icon"><LoaderCircle size={18} className="spin" /></div>
      <div className="auth-banner-copy">
        <strong>等待本地浏览器完成授权</strong>
        <span>授权完成后会自动保存账号 token 并刷新用量。</span>
      </div>
      <Button size="sm" variant="secondary" onClick={onOpen}><ExternalLink size={15} /> 打开授权页</Button>
      <Button type="button" size="icon" variant="ghost" aria-label="取消登录" title="取消登录" onClick={onCancel}><X size={17} /></Button>
      <p className="auth-banner-note auth-banner-note-wide">如果官方授权页仍显示旧账号，请先退出当前 Command Code 账号，或用浏览器隐私窗口重新打开授权页。</p>
    </div>
  );
}

function quotaRemaining(account, key) {
  const quota = account?.usage?.[key];
  if (!quota || quota.remaining === undefined || quota.remaining === null) return '--';
  const percent = Number.isFinite(Number(quota.remainingRatio))
    ? Math.round(Number(quota.remainingRatio) * 100)
    : null;
  return `${formatMoney(quota.remaining)}/${percent === null ? '--' : `${percent}%`}`;
}

function AccountList({ accounts, activeAccountId, onActivate, onDelete, onRefreshAll, refreshing, onLogin }) {
  return (
    <section className="accounts-section">
      <SectionHeading
        eyebrow="已保存账号"
        title="账号"
        description="已保存的账号 token 只写入本机运行目录。"
        action={(
          <div className="accounts-toolbar">
            <Button type="button" size="sm" variant="secondary" onClick={onRefreshAll} disabled={refreshing || !accounts.length}>
              <RefreshCw size={15} className={refreshing ? 'spin' : ''} /> 刷新全部
            </Button>
            <Button type="button" size="sm" onClick={onLogin}><LogIn size={15} /> 添加账号</Button>
          </div>
        )}
      />
      {!accounts.length ? (
        <div className="accounts-empty"><Users size={18} /><span>还没有保存的账号，请点击右上角“添加账号”</span></div>
      ) : (
        <div className="account-list">
          {accounts.map((account) => {
            const active = account.id === activeAccountId;
            const displayName = account.userName || account.email || 'Command Code 账号';
            return (
              <div className={cn('account-row', active && 'account-row-active')} key={account.id}>
                <div className="account-row-identity">
                  <div className="account-row-avatar"><UserRound size={17} /></div>
                  <div className="account-row-copy">
                    <div className="account-row-name"><strong>{displayName}</strong>{active && <Badge variant="success">当前使用</Badge>}</div>
                    <span>{account.email || account.userId || '已保存 token'}</span>
                    {account.usageError && <small title={account.usageError}>用量同步失败</small>}
                  </div>
                </div>
                <div className="account-quotas" aria-label={`${displayName}剩余额度`}>
                  <div className="quota-item"><span>5 小时剩余</span><strong>{quotaRemaining(account, 'fiveHour')}</strong></div>
                  <div className="quota-item"><span>一周剩余</span><strong>{quotaRemaining(account, 'weekly')}</strong></div>
                  <div className="quota-item"><span>总额剩余</span><strong>{quotaRemaining(account, 'monthly')}</strong></div>
                </div>
                <div className="account-row-actions">
                  {!active && <Button type="button" size="sm" variant="secondary" onClick={() => onActivate(account.id)} disabled={refreshing}>切换</Button>}
                  <Button type="button" size="icon" variant="ghost" className="danger-icon" onClick={() => onDelete(account)} aria-label={`删除${displayName}`} title={`删除${displayName}`}><Trash2 size={16} /></Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Overview({ config, usage, onLogin, onRefresh, refreshing, authSession, onOpenAuth, onCancelAuth, onSubmitToken, authToken, authTokenShown, onAuthTokenChange, onToggleAuthToken, authTokenSaving, error, actionMessage, onActivateAccount, onDeleteAccount, onRefreshAccounts }) {
  const hasUsage = Boolean(usage);
  const accounts = config?.accounts || [];
  return (
    <div className="page-body">
      <AuthBanner
        session={authSession}
        onOpen={onOpenAuth}
        onCancel={onCancelAuth}
        onSubmitToken={onSubmitToken}
        token={authToken}
        tokenShown={authTokenShown}
        onTokenChange={onAuthTokenChange}
        onToggleToken={onToggleAuthToken}
        tokenSaving={authTokenSaving}
      />
      {error && <Notice>{error}</Notice>}
      {actionMessage && <Notice type="success">{actionMessage}</Notice>}
      <AccountList
        accounts={accounts}
        activeAccountId={config?.activeAccountId}
        onActivate={onActivateAccount}
        onDelete={onDeleteAccount}
        onRefreshAll={onRefreshAccounts}
        refreshing={refreshing}
        onLogin={onLogin}
      />
      {!hasUsage ? (
        <EmptyUsage />
      ) : (
        <>
          <SectionHeading eyebrow="Rate windows" title="限额窗口" description={`${usage.plan || '未知套餐'} · ${formatFetchedAt(usage.fetchedAt)}`} action={<Badge variant="success"><span className="status-dot" /> 自动同步</Badge>} />
          <div className="window-grid">
            <WindowCard title="5 小时窗口" caption="短周期用量" data={usage.fiveHour} tone="orange" />
            <WindowCard title="一周窗口" caption="滚动周额度" data={usage.weekly} tone="mint" />
            <WindowCard title="本月窗口" caption="当前计费周期" data={usage.monthly} tone="mint" />
          </div>
        </>
      )}
    </div>
  );
}

function KeyRow({ item, onDelete, onReplace }) {
  return (
    <div className="key-row">
      <div className="key-number">{item.label.replace('密钥 ', '')}</div>
      <div className="key-details">
        <div className="key-heading">
          <strong>{item.label}</strong>
          {item.isFirst && <Badge variant="brand">控制台登录密码</Badge>}
        </div>
        <code>{item.masked}</code>
        <p>{item.isFirst ? '第一个网关密钥同时作为公网控制台登录密码。' : '可单独用于代理 API 请求。'}</p>
      </div>
      <div className="key-actions">
        {item.isFirst && <Button type="button" size="sm" variant="ghost" onClick={onReplace}><RotateCcw size={14} /> 更换</Button>}
        <Button type="button" size="icon" variant="ghost" className="danger-icon" onClick={onDelete} aria-label={`删除${item.label}`} title={`删除${item.label}`}><Trash2 size={16} /></Button>
      </div>
    </div>
  );
}

function ModelManager({ models, selectedIds, onToggle, onSelectAll, onClear, onSave, onRefresh, loading, saving, dirty, fetchedAt, error }) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(normalizedQuery));
  const selectedCount = models.filter((model) => selectedIds.has(model.id)).length;
  return (
    <Card className="models-card">
      <CardHeader className="models-header">
        <div className="card-heading-line">
          <div className="card-heading-icon purple"><SlidersHorizontal size={18} /></div>
          <div>
            <CardTitle>允许访问的模型</CardTitle>
            <CardDescription>未选中的模型不会出现在模型端点，实际请求会返回 403。</CardDescription>
          </div>
        </div>
        <Button type="button" size="icon" variant="ghost" onClick={onRefresh} disabled={loading} aria-label="刷新模型列表" title="刷新模型列表">
          <RefreshCw size={17} className={loading ? 'spin' : ''} />
        </Button>
      </CardHeader>
      <CardContent>
        {error && <Notice>{error}</Notice>}
        <div className="model-toolbar">
          <div className="model-count"><strong>{selectedCount}</strong><span>/ {models.length} 个模型已允许</span></div>
          <div className="model-batch-actions">
            <Button type="button" size="sm" variant="outline" onClick={onSelectAll} disabled={!models.length}><CheckCheck size={14} /> 全部允许</Button>
            <Button type="button" size="sm" variant="ghost" onClick={onClear} disabled={!models.length}><X size={14} /> 全部取消</Button>
          </div>
        </div>
        <div className="model-search"><Search size={15} /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型名称或 ID" aria-label="搜索模型" /></div>
        {loading && !models.length ? (
          <div className="model-loading"><LoaderCircle size={18} className="spin" /> 正在从上游读取模型</div>
        ) : (
          <div className="model-list" role="list">
            {visibleModels.map((model) => (
              <label className="model-row" key={model.id}>
                <input type="checkbox" checked={selectedIds.has(model.id)} onChange={() => onToggle(model.id)} />
                <span className="model-row-copy"><strong>{model.name || model.id}</strong><code>{model.id}</code></span>
                <span className="model-owner">{model.ownedBy || 'provider'}</span>
              </label>
            ))}
            {!visibleModels.length && <div className="model-empty">没有匹配的模型</div>}
          </div>
        )}
        <div className="model-footer">
          <span>{fetchedAt ? formatFetchedAt(fetchedAt) : '尚未读取上游模型'}</span>
          <Button type="button" onClick={onSave} disabled={saving || loading || !dirty}>
            {saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} 保存模型权限
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Settings({
  config,
  models,
  selectedModelIds,
  onToggleModel,
  onSelectAllModels,
  onClearModels,
  onSaveModels,
  onRefreshModels,
  modelsLoading,
  modelsSaving,
  modelsDirty,
  modelsFetchedAt,
  modelsError,
  onAddKey,
  onDeleteKey,
  onReplaceFirst,
  onRestart,
  onUpdate,
  addingKey,
  replacingKey,
  restarting,
  updating,
  actionMessage,
  error,
}) {
  const [newKey, setNewKey] = useState('');
  const [newKeyShown, setNewKeyShown] = useState(false);
  const [replaceKey, setReplaceKey] = useState(null);
  const [replaceShown, setReplaceShown] = useState(false);
  const keys = config?.gatewayKeys || [];
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const endpoint = `${origin || `http://127.0.0.1:${config?.port || 3050}`}/v1`;

  const submitAdd = async (event) => {
    event.preventDefault();
    const success = await onAddKey(newKey.trim());
    if (success) {
      setNewKey('');
      setNewKeyShown(false);
    }
  };

  const submitReplace = async (event) => {
    event.preventDefault();
    const success = await onReplaceFirst(replaceKey.trim());
    if (success) {
      setReplaceKey(null);
      setReplaceShown(false);
    }
  };

  return (
    <div className="page-body settings-body">
      <SectionHeading eyebrow="Configuration" title="代理设置" description="访问控制、模型权限与运行维护" />
      {error && <Notice>{error}</Notice>}
      {actionMessage && <Notice type="success">{actionMessage}</Notice>}
      <div className="settings-grid">
        <Card className="keys-card">
          <CardHeader>
            <div className="card-heading-line">
              <div className="card-heading-icon"><ShieldCheck size={18} /></div>
              <div>
                <CardTitle>网关密钥</CardTitle>
                <CardDescription>共 {keys.length} 个密钥，任意一个都可以访问代理 API。</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="key-list">
              {keys.map((item) => (
                <KeyRow
                  item={item}
                  key={item.id}
                  onDelete={() => onDeleteKey(item)}
                  onReplace={() => setReplaceKey((current) => current === null ? '' : current)}
                />
              ))}
            </div>
            {replaceKey !== null && keys[0] && (
              <form className="key-form replace-key-form" onSubmit={submitReplace}>
                <div className="form-subheading"><strong>更换第一个密钥</strong><Button type="button" size="icon" variant="ghost" onClick={() => setReplaceKey(null)} aria-label="取消更换" title="取消更换"><X size={15} /></Button></div>
                <SecretInput id="replace-key" value={replaceKey} onChange={(event) => setReplaceKey(event.target.value)} shown={replaceShown} onToggle={() => setReplaceShown((current) => !current)} placeholder="输入新的第一个密钥" />
                <Button type="submit" size="sm" disabled={replacingKey || replaceKey.trim().length < 8}>{replacingKey ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />} 确认更换</Button>
              </form>
            )}
            <form className="key-form" onSubmit={submitAdd}>
              <div className="form-subheading"><strong>新增网关密钥</strong><span>不会改变当前登录密码</span></div>
              <div className="key-form-row">
                <SecretInput id="new-gateway-key" value={newKey} onChange={(event) => setNewKey(event.target.value)} shown={newKeyShown} onToggle={() => setNewKeyShown((current) => !current)} placeholder="至少 8 个字符" />
                <Button type="submit" disabled={addingKey || newKey.trim().length < 8}>{addingKey ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />} 添加密钥</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="endpoint-card">
          <CardHeader>
            <div className="card-heading-line">
              <div className="card-heading-icon slate"><Server size={18} /></div>
              <div><CardTitle>运行端点</CardTitle><CardDescription>当前控制台访问到的代理地址</CardDescription></div>
            </div>
          </CardHeader>
          <CardContent className="endpoint-content">
            <InfoRow label="OpenAI 兼容端点" value={endpoint} copy />
            <InfoRow label="管理控制台" value={`${origin || endpoint.replace(/\/v1$/, '')}/console`} copy />
            <InfoRow label="上游账号 token" value={config?.hasUpstreamToken ? '已加载' : '未加载'} valueTone={config?.hasUpstreamToken ? 'positive' : 'muted'} />
            <Separator className="endpoint-separator" />
            <Button variant="secondary" onClick={onRestart} disabled={restarting} className="restart-button">
              {restarting ? <LoaderCircle size={16} className="spin" /> : <RotateCcw size={16} />} 重启代理服务
            </Button>
            <Separator className="endpoint-separator" />
            <div className="maintenance-inline">
              <div className="maintenance-inline-copy"><strong>软件维护</strong><span>检查更新并重新构建控制台</span></div>
              <Button onClick={onUpdate} disabled={updating} size="sm" className="update-button">
                {updating ? <LoaderCircle size={15} className="spin" /> : <ArrowUpRight size={15} />} 更新并重启
              </Button>
            </div>
          </CardContent>
        </Card>

      </div>
      <ModelManager
        models={models}
        selectedIds={selectedModelIds}
        onToggle={onToggleModel}
        onSelectAll={onSelectAllModels}
        onClear={onClearModels}
        onSave={onSaveModels}
        onRefresh={onRefreshModels}
        loading={modelsLoading}
        saving={modelsSaving}
        dirty={modelsDirty}
        fetchedAt={modelsFetchedAt}
        error={modelsError}
      />
    </div>
  );
}

function InfoRow({ label, value, copy, valueTone }) {
  const [copied, setCopied] = useState(false);
  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong className={valueTone ? `value-${valueTone}` : ''}>{value}</strong>
      {copy && <Button type="button" size="icon" variant="ghost" onClick={copyValue} aria-label="复制地址" title="复制地址">{copied ? <Check size={15} /> : <Copy size={15} />}</Button>}
    </div>
  );
}

function Dashboard({
  activeView,
  setActiveView,
  config,
  status,
  usage,
  models,
  selectedModelIds,
  onToggleModel,
  onSelectAllModels,
  onClearModels,
  onSaveModels,
  onRefreshModels,
  modelsLoading,
  modelsSaving,
  modelsDirty,
  modelsFetchedAt,
  modelsError,
  onLogin,
  onRefreshUsage,
  onActivateAccount,
  onDeleteAccount,
  onRefreshAccounts,
  refreshing,
  authSession,
  onOpenAuth,
  onCancelAuth,
  onSubmitToken,
  authToken,
  authTokenShown,
  onAuthTokenChange,
  onToggleAuthToken,
  authTokenSaving,
  error,
  onAddKey,
  onDeleteKey,
  onReplaceFirst,
  onRestart,
  onUpdate,
  addingKey,
  replacingKey,
  restarting,
  updating,
  actionMessage,
  settingsError,
  onLogout,
}) {
  const pageTitle = activeView === 'overview' ? '用量概览' : '代理设置';
  const pageKicker = activeView === 'overview' ? 'Overview' : 'Configuration';
  return (
    <div className="app-shell">
      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-switcher" role="navigation" aria-label="页面切换">
            <button type="button" className={cn(activeView === 'overview' && 'topbar-switch-active')} onClick={() => setActiveView('overview')}>用量概览</button>
            <button type="button" className={cn(activeView === 'settings' && 'topbar-switch-active')} onClick={() => setActiveView('settings')}>代理设置</button>
          </div>
          <div className="topbar-actions">
            <Badge variant={status?.healthy ? 'success' : 'danger'}><span className="status-dot" /> {status?.healthy ? '代理在线' : '代理离线'}</Badge>
            <a href="https://commandcode.ai/docs" target="_blank" rel="noreferrer" aria-label="打开文档" title="打开文档"><ArrowUpRight size={17} /></a>
            <Button type="button" size="icon" variant="ghost" onClick={onLogout} aria-label="退出登录" title="退出登录"><LogOut size={17} /></Button>
          </div>
        </header>
        <div className="page-heading"><div><div className="page-kicker">{pageKicker}</div><h1>{pageTitle}</h1></div><div className="page-heading-meta"><Activity size={15} /> 每分钟自动刷新用量</div></div>
        {activeView === 'settings' ? (
          <Settings
            config={config}
            models={models}
            selectedModelIds={selectedModelIds}
            onToggleModel={onToggleModel}
            onSelectAllModels={onSelectAllModels}
            onClearModels={onClearModels}
            onSaveModels={onSaveModels}
            onRefreshModels={onRefreshModels}
            modelsLoading={modelsLoading}
            modelsSaving={modelsSaving}
            modelsDirty={modelsDirty}
            modelsFetchedAt={modelsFetchedAt}
            modelsError={modelsError}
            onAddKey={onAddKey}
            onDeleteKey={onDeleteKey}
            onReplaceFirst={onReplaceFirst}
            onRestart={onRestart}
            onUpdate={onUpdate}
            addingKey={addingKey}
            replacingKey={replacingKey}
            restarting={restarting}
            updating={updating}
            actionMessage={actionMessage}
            error={settingsError}
          />
        ) : (
          <Overview
            config={config}
            usage={usage}
            onLogin={onLogin}
            onRefresh={onRefreshUsage}
            onActivateAccount={onActivateAccount}
            onDeleteAccount={onDeleteAccount}
            onRefreshAccounts={onRefreshAccounts}
            refreshing={refreshing}
            authSession={authSession}
            onOpenAuth={onOpenAuth}
            onCancelAuth={onCancelAuth}
            onSubmitToken={onSubmitToken}
            authToken={authToken}
            authTokenShown={authTokenShown}
            onAuthTokenChange={onAuthTokenChange}
            onToggleAuthToken={onToggleAuthToken}
            authTokenSaving={authTokenSaving}
            error={error}
            actionMessage={actionMessage}
          />
        )}
      </main>
    </div>
  );
}

function App() {
  const [phase, setPhase] = useState('loading');
  const [authState, setAuthState] = useState(null);
  const [activeView, setActiveView] = useState('overview');
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [usage, setUsage] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedModelIds, setSelectedModelIds] = useState(new Set());
  const [modelsFetchedAt, setModelsFetchedAt] = useState(null);
  const [modelsDirty, setModelsDirty] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsSaving, setModelsSaving] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [bootstrapKey, setBootstrapKey] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [bootstrapShown, setBootstrapShown] = useState(false);
  const [loginShown, setLoginShown] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authSaving, setAuthSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [addingKey, setAddingKey] = useState(false);
  const [replacingKey, setReplacingKey] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [authSession, setAuthSession] = useState(null);
  const [authToken, setAuthToken] = useState('');
  const [authTokenShown, setAuthTokenShown] = useState(false);
  const [authTokenSaving, setAuthTokenSaving] = useState(false);
  const authPollRef = useRef(null);
  const authPollingBusyRef = useRef(false);
  const usageRefreshingRef = useRef(false);
  const configRef = useRef(null);

  configRef.current = config;

  const stopAuthPolling = useCallback(() => {
    if (authPollRef.current) window.clearInterval(authPollRef.current);
    authPollRef.current = null;
    authPollingBusyRef.current = false;
  }, []);

  const resetDashboard = useCallback(() => {
    setConfig(null);
    setUsage(null);
    setModels([]);
    setSelectedModelIds(new Set());
    setModelsDirty(false);
    setAuthSession(null);
    setAuthToken('');
    setAuthTokenShown(false);
    stopAuthPolling();
  }, [stopAuthPolling]);

  const enterLogin = useCallback(() => {
    resetDashboard();
    setAuthState((current) => ({ ...(current || {}), configured: true, authenticated: false }));
    setPhase('login');
  }, [resetDashboard]);

  const handleAuthError = useCallback((caught) => {
    if (caught?.status === 401) {
      enterLogin();
      return true;
    }
    return false;
  }, [enterLogin]);

  useEffect(() => {
    let cancelled = false;
    request('/auth/state')
      .then((data) => {
        if (cancelled) return;
        setAuthState(data);
        setPhase(data.authenticated ? 'ready' : data.configured ? 'login' : 'setup');
      })
      .catch((caught) => {
        if (!cancelled) {
          setAuthError(caught.message);
          setPhase('login');
        }
      });
    return () => { cancelled = true; };
  }, []);

  const loadConfig = useCallback(async () => {
    const data = await request('/config');
    setConfig(data);
    return data;
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const data = await request('/status');
      setStatus(data);
      return data;
    } catch {
      setStatus({ healthy: false, port: 3050 });
      return null;
    }
  }, []);

  const loadUsage = useCallback(async (hasToken, silent = false) => {
    if (!hasToken) {
      setUsage(null);
      return;
    }
    if (silent && usageRefreshingRef.current) return;
    usageRefreshingRef.current = true;
    if (!silent) setRefreshing(true);
    try {
      const data = await request('/usage');
      setUsage(data.usage);
      if (data.accounts) {
        setConfig((current) => ({ ...(current || {}), accounts: data.accounts, activeAccountId: data.activeAccountId }));
      }
      if (data.autoSwitched) {
        setActionMessage('当前账号额度已用尽，已自动切换到可用账号。');
        window.setTimeout(() => setActionMessage(''), 3500);
      }
      setError('');
    } catch (caught) {
      if (!handleAuthError(caught)) setError(caught.message);
    } finally {
      usageRefreshingRef.current = false;
      if (!silent) setRefreshing(false);
    }
  }, [handleAuthError]);

  const loadModels = useCallback(async (forceRefresh = false) => {
    setModelsLoading(true);
    setModelsError('');
    try {
      const data = await request(`/models${forceRefresh ? '?refresh=1' : ''}`);
      setModels(data.models || []);
      setSelectedModelIds(new Set(data.selectedModelIds || []));
      setModelsFetchedAt(data.fetchedAt || new Date().toISOString());
      setModelsDirty(false);
    } catch (caught) {
      if (!handleAuthError(caught)) setModelsError(caught.message);
    } finally {
      setModelsLoading(false);
    }
  }, [handleAuthError]);

  const hydrateDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const [configData] = await Promise.all([loadConfig(), loadStatus()]);
      await Promise.all([loadUsage(configData.hasUpstreamToken, true), loadModels(false)]);
    } catch (caught) {
      if (!handleAuthError(caught)) setError(caught.message);
    } finally {
      setDashboardLoading(false);
    }
  }, [handleAuthError, loadConfig, loadModels, loadStatus, loadUsage]);

  useEffect(() => {
    if (phase !== 'ready') return undefined;
    hydrateDashboard();
    const timer = window.setInterval(() => {
      loadUsage(Boolean(configRef.current?.hasUpstreamToken), true);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [phase, hydrateDashboard, loadUsage]);

  useEffect(() => () => stopAuthPolling(), [stopAuthPolling]);

  const completeLogin = useCallback((data) => {
    setAuthState({ ...(data || {}), configured: true, authenticated: true });
    setPhase('ready');
    setAuthError('');
  }, []);

  const bootstrap = useCallback(async (event) => {
    event.preventDefault();
    setAuthError('');
    setAuthSaving(true);
    try {
      const data = await request('/bootstrap', { method: 'POST', body: JSON.stringify({ gatewayApiKey: bootstrapKey.trim() }) });
      await completeLogin(data);
      setBootstrapKey('');
    } catch (caught) {
      setAuthError(caught.message);
    } finally {
      setAuthSaving(false);
    }
  }, [bootstrapKey, completeLogin]);

  const login = useCallback(async (event) => {
    event.preventDefault();
    setAuthError('');
    setAuthSaving(true);
    try {
      const data = await request('/auth/login', { method: 'POST', body: JSON.stringify({ password: loginPassword.trim() }) });
      await completeLogin(data);
      setLoginPassword('');
    } catch (caught) {
      setAuthError(caught.message);
    } finally {
      setAuthSaving(false);
    }
  }, [completeLogin, loginPassword]);

  const logout = useCallback(async () => {
    try { await request('/auth/logout', { method: 'POST', body: '{}' }); } catch {}
    resetDashboard();
    setAuthState((current) => ({ ...(current || {}), configured: true, authenticated: false }));
    setPhase('login');
    setLoginPassword('');
  }, [resetDashboard]);

  const openAuthWindow = useCallback((loginUrl) => {
    const popup = window.open('about:blank', '_blank', 'popup,width=520,height=760');
    if (!popup) return false;
    popup.location.href = loginUrl;
    return true;
  }, []);

  const openAuthPage = useCallback(() => {
    if (!authSession?.loginUrl) return;
    if (!openAuthWindow(authSession.loginUrl)) setError('浏览器阻止了新窗口，请点击浏览器地址栏允许打开授权页。');
  }, [authSession, openAuthWindow]);

  const startBrowserLogin = useCallback(async () => {
    setError('');
    const popup = window.open('about:blank', '_blank', 'popup,width=520,height=760');
    try {
      const session = await request('/auth/start', { method: 'POST', body: '{}' });
      setAuthSession(session);
      setAuthToken('');
      setAuthTokenShown(false);
      if (session.mode === 'manual') {
        if (popup) popup.close();
        stopAuthPolling();
        return;
      }
      if (session.mode === 'bridge') {
        if (popup) popup.close();
      } else if (popup) popup.location.href = session.loginUrl;
      else setError('浏览器阻止了新窗口，请点击“打开授权页”。');
      stopAuthPolling();
      authPollRef.current = window.setInterval(async () => {
        if (authPollingBusyRef.current) return;
        authPollingBusyRef.current = true;
        try {
          const result = await request(`/auth/status?state=${encodeURIComponent(session.state)}`);
          if (result.status === 'success') {
            stopAuthPolling();
            setAuthSession(null);
            await completeLogin({ configured: true, authenticated: true, account: result.account });
            await hydrateDashboard();
            setActionMessage('账号 token 已保存，用量已同步。');
            window.setTimeout(() => setActionMessage(''), 3500);
          } else if (result.status === 'error') {
            stopAuthPolling();
            setAuthSession(null);
            setError(result.error || '浏览器登录失败');
          }
        } catch (caught) {
          stopAuthPolling();
          setAuthSession(null);
          if (!handleAuthError(caught)) setError(caught.message);
        } finally {
          authPollingBusyRef.current = false;
        }
      }, 1000);
    } catch (caught) {
      if (popup) popup.close();
      if (!handleAuthError(caught)) setError(caught.message);
    }
  }, [completeLogin, handleAuthError, hydrateDashboard, stopAuthPolling]);

  const submitAuthToken = useCallback(async (event) => {
    event.preventDefault();
    if (!authSession?.state || !authToken.trim()) return;
    setError('');
    setAuthTokenSaving(true);
    try {
      const data = await request('/auth/token', {
        method: 'POST',
        body: JSON.stringify({ state: authSession.state, apiKey: authToken.trim() }),
      });
      setAuthSession(null);
      setAuthToken('');
      setAuthTokenShown(false);
      await completeLogin({ configured: true, authenticated: true, account: data.account });
      await hydrateDashboard();
      setActionMessage('账号 token 已验证并保存，用量已同步。');
      window.setTimeout(() => setActionMessage(''), 3500);
    } catch (caught) {
      if (!handleAuthError(caught)) setError(caught.message);
    } finally {
      setAuthTokenSaving(false);
    }
  }, [authSession, authToken, completeLogin, handleAuthError, hydrateDashboard]);

  const cancelLogin = useCallback(() => {
    stopAuthPolling();
    setAuthSession(null);
    setAuthToken('');
    setAuthTokenShown(false);
  }, [stopAuthPolling]);

  const waitForHealthy = useCallback(async () => {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(300);
      try {
        const nextStatus = await request('/status');
        setStatus(nextStatus);
        if (nextStatus.healthy) return true;
      } catch {
        setStatus({ healthy: false, port: 3050 });
      }
    }
    return false;
  }, []);

  const performRestart = useCallback(async () => {
    setSettingsError('');
    setRestarting(true);
    try {
      await request('/restart', { method: 'POST', body: '{}' });
      if (!await waitForHealthy()) throw new Error('代理重启后健康检查未通过');
      setActionMessage('代理已重启，服务运行正常。');
      window.setTimeout(() => setActionMessage(''), 3500);
    } catch (caught) {
      if (!handleAuthError(caught)) setSettingsError(caught.message);
    } finally {
      setRestarting(false);
    }
  }, [handleAuthError, waitForHealthy]);

  const performUpdate = useCallback(async () => {
    setSettingsError('');
    setUpdating(true);
    try {
      const result = await request('/update', { method: 'POST', body: '{}' });
      setActionMessage(result.message || '项目已更新，正在重启代理服务。');
      const healthy = await waitForHealthy();
      if (!healthy) throw new Error('更新后健康检查未通过，请稍后刷新页面');
      const nextAuth = await request('/auth/state');
      setAuthState(nextAuth);
      resetDashboard();
      setPhase(nextAuth.configured ? 'login' : 'setup');
    } catch (caught) {
      if (!handleAuthError(caught)) setSettingsError(caught.message);
    } finally {
      setUpdating(false);
    }
  }, [handleAuthError, resetDashboard, waitForHealthy]);

  const addKey = useCallback(async (gatewayApiKey) => {
    setSettingsError('');
    setAddingKey(true);
    try {
      const data = await request('/keys', { method: 'POST', body: JSON.stringify({ gatewayApiKey }) });
      setConfig((current) => ({ ...(current || {}), gatewayKeys: data.gatewayKeys, gatewayApiKeyCount: data.gatewayKeys.length }));
      setActionMessage('网关密钥已添加，立即生效。');
      window.setTimeout(() => setActionMessage(''), 3500);
      return true;
    } catch (caught) {
      if (!handleAuthError(caught)) setSettingsError(caught.message);
      return false;
    } finally {
      setAddingKey(false);
    }
  }, [handleAuthError]);

  const deleteKey = useCallback(async (item) => {
    if (!window.confirm(`确定删除${item.label}吗？${item.isFirst ? '删除后下一个密钥会成为新的控制台登录密码。' : ''}`)) return;
    setSettingsError('');
    try {
      const data = await request(`/keys/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (data.reauthenticate) {
        setAuthState((current) => ({ ...(current || {}), configured: data.configured, authenticated: false }));
        resetDashboard();
        setPhase(data.configured ? 'login' : 'setup');
      } else {
        setConfig((current) => ({ ...(current || {}), gatewayKeys: data.gatewayKeys, gatewayApiKeyCount: data.gatewayKeys.length }));
        setActionMessage('网关密钥已删除。');
        window.setTimeout(() => setActionMessage(''), 3500);
      }
    } catch (caught) {
      if (!handleAuthError(caught)) setSettingsError(caught.message);
    }
  }, [handleAuthError, resetDashboard]);

  const replaceFirstKey = useCallback(async (gatewayApiKey) => {
    setSettingsError('');
    setReplacingKey(true);
    try {
      const data = await request('/config', { method: 'POST', body: JSON.stringify({ gatewayApiKey }) });
      setAuthState((current) => ({ ...(current || {}), configured: true, authenticated: false }));
      resetDashboard();
      setPhase('login');
      return Boolean(data.reauthenticate);
    } catch (caught) {
      if (!handleAuthError(caught)) setSettingsError(caught.message);
      return false;
    } finally {
      setReplacingKey(false);
    }
  }, [handleAuthError, resetDashboard]);

  const toggleModel = useCallback((modelId) => {
    setSelectedModelIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      setModelsDirty(true);
      return next;
    });
  }, []);

  const selectAllModels = useCallback(() => {
    setSelectedModelIds(new Set(models.map((model) => model.id)));
    setModelsDirty(true);
  }, [models]);

  const clearModels = useCallback(() => {
    setSelectedModelIds(new Set());
    setModelsDirty(true);
  }, []);

  const saveModels = useCallback(async () => {
    setModelsSaving(true);
    setModelsError('');
    try {
      const data = await request('/models', { method: 'POST', body: JSON.stringify({ modelIds: Array.from(selectedModelIds) }) });
      setModels(data.models || []);
      setSelectedModelIds(new Set(data.selectedModelIds || []));
      setModelsFetchedAt(data.fetchedAt || new Date().toISOString());
      setModelsDirty(false);
      setActionMessage('模型访问权限已保存，立即生效。');
      window.setTimeout(() => setActionMessage(''), 3500);
    } catch (caught) {
      if (!handleAuthError(caught)) setModelsError(caught.message);
    } finally {
      setModelsSaving(false);
    }
  }, [handleAuthError, selectedModelIds]);

  const refreshUsage = useCallback(() => loadUsage(Boolean(configRef.current?.hasUpstreamToken), false), [loadUsage]);

  const applyAccountPayload = useCallback((data) => {
    const nextAccounts = data.accounts || [];
    const nextActive = nextAccounts.find((account) => account.id === data.activeAccountId) || null;
    setConfig((current) => ({
      ...(current || {}),
      accounts: nextAccounts,
      activeAccountId: data.activeAccountId || null,
      account: nextActive,
      hasUpstreamToken: Boolean(nextActive),
    }));
    setUsage(nextActive?.usage || null);
    return nextActive;
  }, []);

  const activateAccount = useCallback(async (accountId) => {
    setError('');
    setRefreshing(true);
    try {
      const data = await request(`/accounts/${encodeURIComponent(accountId)}/activate`, { method: 'POST', body: '{}' });
      applyAccountPayload(data);
      await Promise.all([loadUsage(true, true), loadModels(false)]);
      setActionMessage('账号已切换，用量已同步。');
      window.setTimeout(() => setActionMessage(''), 3500);
    } catch (caught) {
      if (!handleAuthError(caught)) setError(caught.message);
    } finally {
      setRefreshing(false);
    }
  }, [applyAccountPayload, handleAuthError, loadModels, loadUsage]);

  const refreshAccounts = useCallback(async () => {
    setError('');
    setRefreshing(true);
    try {
      const data = await request('/accounts/refresh', { method: 'POST', body: '{}' });
      applyAccountPayload(data);
      const failed = (data.accounts || []).filter((account) => account.usageError).length;
      setActionMessage(data.autoSwitched
        ? '当前账号额度已用尽，已自动切换到可用账号。'
        : (failed ? `${failed} 个账号用量同步失败。` : '所有账号用量已刷新。'));
      window.setTimeout(() => setActionMessage(''), 3500);
    } catch (caught) {
      if (!handleAuthError(caught)) setError(caught.message);
    } finally {
      setRefreshing(false);
    }
  }, [applyAccountPayload, handleAuthError]);

  const deleteAccount = useCallback(async (account) => {
    const displayName = account.userName || account.email || '这个账号';
    if (!window.confirm(`确定删除${displayName}吗？删除后只会移除本机暂存的 token。`)) return;
    setError('');
    setRefreshing(true);
    try {
      const data = await request(`/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
      const nextActive = applyAccountPayload(data);
      if (nextActive) {
        await Promise.all([loadUsage(true, true), loadModels(false)]);
      }
      setActionMessage('账号已从本机移除。');
      window.setTimeout(() => setActionMessage(''), 3500);
    } catch (caught) {
      if (!handleAuthError(caught)) setError(caught.message);
    } finally {
      setRefreshing(false);
    }
  }, [applyAccountPayload, handleAuthError, loadModels, loadUsage]);

  if (phase === 'loading') return <LoadingPage />;
  if (phase === 'setup') return <SetupPage value={bootstrapKey} setValue={setBootstrapKey} shown={bootstrapShown} setShown={setBootstrapShown} onSubmit={bootstrap} saving={authSaving} error={authError} />;
  if (phase === 'login') return <LoginPage value={loginPassword} setValue={setLoginPassword} shown={loginShown} setShown={setLoginShown} onSubmit={login} saving={authSaving} error={authError} />;

  if (dashboardLoading && !config) return <LoadingPage />;
  return (
    <Dashboard
      activeView={activeView}
      setActiveView={setActiveView}
      config={config}
      status={status}
      usage={usage}
      models={models}
      selectedModelIds={selectedModelIds}
      onToggleModel={toggleModel}
      onSelectAllModels={selectAllModels}
      onClearModels={clearModels}
      onSaveModels={saveModels}
      onRefreshModels={() => loadModels(true)}
      modelsLoading={modelsLoading}
      modelsSaving={modelsSaving}
      modelsDirty={modelsDirty}
      modelsFetchedAt={modelsFetchedAt}
      modelsError={modelsError}
      onLogin={startBrowserLogin}
      onRefreshUsage={refreshUsage}
      onActivateAccount={activateAccount}
      onDeleteAccount={deleteAccount}
      onRefreshAccounts={refreshAccounts}
      refreshing={refreshing}
      authSession={authSession}
      onOpenAuth={openAuthPage}
      onCancelAuth={cancelLogin}
      onSubmitToken={submitAuthToken}
      authToken={authToken}
      authTokenShown={authTokenShown}
      onAuthTokenChange={(event) => setAuthToken(event.target.value)}
      onToggleAuthToken={setAuthTokenShown}
      authTokenSaving={authTokenSaving}
      error={error}
      onAddKey={addKey}
      onDeleteKey={deleteKey}
      onReplaceFirst={replaceFirstKey}
      onRestart={performRestart}
      onUpdate={performUpdate}
      addingKey={addingKey}
      replacingKey={replacingKey}
      restarting={restarting}
      updating={updating}
      actionMessage={actionMessage}
      settingsError={settingsError}
      onLogout={logout}
    />
  );
}

createRoot(document.getElementById('root')).render(<App />);
