/**
 * 连接质量监控（本分支新增）
 *
 * 三个网段分开测量，互相对照：
 * - 本机 ↔ 网关：浏览器每 4 秒探测一次 /admin/api/ping（空闲 RTT，辅助指标，
 *   只反映打开控制台这台机器的链路，不代表真实 API 客户端的路径）；
 * - 网关 ↔ 上游：服务端在每条真实流上统计的相邻到达间隔 / 停顿次数，
 *   经 /admin/api/stream-quality 聚合；
 * - 客户端 ↔ 网关下行：服务端的写积压（背压）统计，同样来自 stream-quality。
 *
 * 轮询节奏按场景自适应：有在途流式请求时 1 秒一次，便于观察「进行中 / 排队」的
 * 实时变化；空闲时 5 秒一次，避免控制台长期开着时空耗请求。页面隐藏时进一步降频。
 *
 * 流式测速是浏览器侧唯一能测量「流式负载下本机网络」的手段：
 * 通过 /admin/api/speedtest 发起一条受控的小流式请求，服务端把网关侧每个数据块
 * 的到达时间随 SSE 帧一起下发；浏览器用自己的本地到达时间对比同一条流的两组
 * 间隔，差值即本机↔网关段的附加延迟（含渲染调度抖动，仅供参考）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, CircleAlert, Gauge, Play, Wifi } from 'lucide-react';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { cn } from './lib/utils';

function percentileOf(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index]);
}

function formatMs(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const milliseconds = Number(value);
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

function formatSpeed(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `每秒 ${Math.round(Number(value)).toLocaleString('zh-CN')} 个 token`;
}

function formatPercent(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return '—';
  return `${Math.round(Number(ratio) * 100)}%`;
}

function formatCount(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toLocaleString('zh-CN')} ${unit}`;
}

// 悬浮说明只放「术语解释」，界面上的主标签尽量使用日常说法。
const METRIC_TIPS = {
  rttTypical: 'p50（中位数）：把最近的探测结果从小到大排列，取中间的值，代表典型水平。',
  rttP95: 'p95：95% 的探测结果快于这个值，用来观察偶尔出现的慢响应。',
  rttJitter: '波动：相邻两次探测结果差值的平均值，数值越小说明网络越稳定。',
  rttLoss: '探测失败：最近的探测里没有成功返回的比例。',
  ttft: '首字等待（TTFT）：从发出请求到收到模型第一个字的时间，包含模型思考时间，不等于纯网络延迟。',
  ttftP95: '95% 的请求首字等待快于这个值，用来观察慢请求能慢到什么程度。',
  speed: '输出速度：模型每秒生成的 token 数；token 是模型处理文本的基本单位。',
  upstreamError: '失败：最近 100 次真实请求中没有正常完成的次数。',
  slowStreams: '接收跟不上的流：网关往客户端发送数据时，发送缓冲区曾被填满的历史流数量。',
  queueTimes: '排队次数：发送缓冲区满、必须等客户端先读走数据的次数。',
  drainMax: '单次最长等待：所有排队中，最长的一次等了多久。',
  drainTotal: '累计等待：所有排队等待时间加起来的总和。',
  gapTypical: '本次测速里，相邻两段数据到达间隔的典型值（中位数）。',
  gapP95: '数据块间隔：相邻两段流式数据到达的时间差；p95 表示 95% 的间隔都小于这个值。',
  gapMax: '本次测速里最长的一段数据间隔。',
};

function Metric({ label, value, tip }) {
  return (
    <span className="quality-metric" title={tip}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

// ── RTT 探针单例 ─────────────────────────────────────────
// 徽章与质量卡共享同一组样本，避免多处挂载导致重复探测。
const RTT_INTERVAL_MS = 4000;
const RTT_TIMEOUT_MS = 5000;
const RTT_MAX_SAMPLES = 45;

const rttStore = {
  samples: [], // { rtt: number|null, ok: boolean, at: number }，最新在末尾
  listeners: new Set(),
  timer: null,
};

async function pingOnce() {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), RTT_TIMEOUT_MS);
  let sample;
  try {
    const response = await fetch('/admin/api/ping', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(String(response.status));
    sample = { rtt: performance.now() - startedAt, ok: true, at: Date.now() };
  } catch {
    sample = { rtt: null, ok: false, at: Date.now() };
  } finally {
    window.clearTimeout(timer);
  }
  rttStore.samples.push(sample);
  if (rttStore.samples.length > RTT_MAX_SAMPLES) rttStore.samples.shift();
  for (const listener of rttStore.listeners) listener();
}

function startRttProbe() {
  if (rttStore.timer) return;
  rttStore.timer = window.setInterval(() => {
    // 后台标签页的定时器会被浏览器节流，测出来的延迟失真，直接跳过。
    if (!document.hidden) void pingOnce();
  }, RTT_INTERVAL_MS);
}

function summarizeRtt(samples) {
  const ok = samples.filter((item) => item.ok && Number.isFinite(item.rtt)).map((item) => item.rtt);
  let jitter = null;
  for (let index = 1; index < ok.length; index += 1) {
    const delta = Math.abs(ok[index] - ok[index - 1]);
    jitter = jitter === null ? delta : jitter + (delta - jitter) / index;
  }
  return {
    p50: percentileOf(ok, 0.5),
    p95: percentileOf(ok, 0.95),
    jitter: jitter === null ? null : Math.round(jitter),
    lossRate: samples.length ? (samples.length - ok.length) / samples.length : null,
    sampleCount: samples.length,
    series: ok.slice(-30),
  };
}

export function useRttProbe() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    startRttProbe();
    const notify = () => setVersion((version) => version + 1);
    rttStore.listeners.add(notify);
    return () => {
      rttStore.listeners.delete(notify);
    };
  }, []);
  return summarizeRtt(rttStore.samples);
}

function rttStatus(p50) {
  if (p50 === null) return { variant: 'danger', label: '连接异常' };
  if (p50 < 150) return { variant: 'success', label: '良好' };
  if (p50 < 400) return { variant: 'warning', label: '一般' };
  return { variant: 'danger', label: '较差' };
}

/** 顶栏徽章：本机 ↔ 网关的实时 RTT（空闲探测，辅助指标）。 */
export function RttBadge() {
  const rtt = useRttProbe();
  if (!rtt.sampleCount) return null;
  const status = rttStatus(rtt.p50);
  const title = rtt.p50 === null
    ? '本机 ↔ 网关探测失败（连续超时或断连），每 4 秒自动重试'
    : `本机 ↔ 网关 空闲往返（每 4 秒采样）：典型 ${rtt.p50}ms · 95% 快于 ${rtt.p95}ms · 波动 ${rtt.jitter}ms · 探测失败 ${formatPercent(rtt.lossRate)}；只代表控制台所在设备`;
  return (
    <Badge variant={status.variant} title={title}>
      <Wifi size={12} />
      {rtt.p50 === null ? '连接异常' : `本机 ${Math.round(rtt.p50)}ms`}
    </Badge>
  );
}

// ── 迷你趋势图（自绘 SVG，不引入图表库） ──────────────────
function Sparkline({ values, stroke = '#0d9488', className }) {
  const points = useMemo(() => {
    if (!values || values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    return values
      .map((value, index) => {
        const x = (index / (values.length - 1)) * 100;
        const y = 28 - ((value - min) / span) * 24 - 2;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [values]);
  return (
    <svg className={cn('qc-sparkline', className)} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      {points
        ? <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        : <line x1="0" y1="15" x2="100" y2="15" stroke="#e4e4e7" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

// ── 连接质量卡（用量概览页） ─────────────────────────────
// 有在途流式请求时 1 秒刷新，便于观察「进行中 / 排队」的实时变化；
// 空闲时 5 秒刷新，避免控制台长期开着时空耗请求。页面隐藏时再降频。
const QUALITY_ACTIVE_POLL_MS = 1000;
const QUALITY_IDLE_POLL_MS = 5000;
const QUALITY_HIDDEN_POLL_MS = 15000;
const QUALITY_TREND_MAX = 30;
// TTFT 趋势按固定 5 秒采样，避免活跃期每秒轮询把 2.5 分钟的趋势窗压缩成 30 秒。
const QUALITY_TREND_INTERVAL_MS = 5000;

function summarizeGaps(values) {
  return {
    count: values.length,
    p50: percentileOf(values, 0.5),
    p95: percentileOf(values, 0.95),
    max: values.length ? Math.round(Math.max(...values)) : null,
  };
}

export function ConnectionQualityCard({ models = [] }) {
  const [quality, setQuality] = useState(null);
  const [ttftTrend, setTtftTrend] = useState([]);
  const rtt = useRttProbe();

  const [testState, setTestState] = useState('idle'); // idle | running | done | error
  const [testError, setTestError] = useState('');
  const [testProgress, setTestProgress] = useState({ chunks: 0, elapsedMs: 0 });
  const [testResult, setTestResult] = useState(null);
  const [model, setModel] = useState('');
  const abortRef = useRef(null);
  const lastTrendAtRef = useRef(0);

  const allowedModels = useMemo(
    () => models.filter((item) => item && item.id && item.allowed !== false),
    [models],
  );

  useEffect(() => {
    if (!model && allowedModels.length) setModel(allowedModels[0].id);
  }, [allowedModels, model]);

  useEffect(() => {
    let stopped = false;
    let timer = null;
    let hasActiveStream = false;

    function schedule(delay) {
      if (stopped) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(load, Math.max(250, delay));
    }

    async function load() {
      const startedAt = performance.now();
      if (document.hidden) {
        schedule(QUALITY_HIDDEN_POLL_MS);
        return;
      }
      try {
        const response = await fetch('/admin/api/stream-quality', { credentials: 'same-origin' });
        if (response.ok) {
          const data = await response.json();
          if (!stopped && data) {
            setQuality(data);
            hasActiveStream = Array.isArray(data?.downstream?.active) && data.downstream.active.length > 0;
            const p95 = data?.upstream?.ttftP95Ms;
            const now = Date.now();
            if (p95 !== null && p95 !== undefined && now - lastTrendAtRef.current >= QUALITY_TREND_INTERVAL_MS) {
              lastTrendAtRef.current = now;
              setTtftTrend((current) => [...current, p95].slice(-QUALITY_TREND_MAX));
            }
          }
        }
      } catch {
        // 下一次轮询再试；不改变当前的活跃/空闲节奏
      }
      if (stopped) return;
      const delay = hasActiveStream ? QUALITY_ACTIVE_POLL_MS : QUALITY_IDLE_POLL_MS;
      schedule(delay - (performance.now() - startedAt));
    }

    const onVisibilityChange = () => {
      if (document.hidden) return;
      window.clearTimeout(timer);
      void load();
    };

    void load();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const runSpeedtest = async () => {
    if (testState === 'running') return;
    setTestState('running');
    setTestError('');
    setTestResult(null);
    setTestProgress({ chunks: 0, elapsedMs: 0 });
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = performance.now();
    const browserGaps = [];
    const upstreamGaps = [];
    let prevArrival = null;
    let prevUpstreamAt = null;
    let chunks = 0;
    try {
      const response = await fetch('/admin/api/speedtest', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        let message = `测速请求失败（HTTP ${response.status}）`;
        try {
          const payload = await response.json();
          if (payload?.error) message = String(payload.error);
        } catch {
          // 响应不是 JSON 时保留默认信息
        }
        throw new Error(message);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let summary = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const arrival = performance.now();
        if (prevArrival !== null) browserGaps.push(arrival - prevArrival);
        prevArrival = arrival;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (event.type === 'chunk') {
            if (prevUpstreamAt !== null) upstreamGaps.push(event.at - prevUpstreamAt);
            prevUpstreamAt = event.at;
            chunks += 1;
            setTestProgress({ chunks, elapsedMs: Math.round(arrival - startedAt) });
          } else if (event.type === 'done') {
            summary = event;
          } else if (event.type === 'error') {
            throw new Error(event.message || '测速失败');
          }
        }
      }
      if (!summary && !upstreamGaps.length) throw new Error('测速没有返回任何数据');
      setTestResult({
        model,
        ttftMs: summary?.ttftMs ?? null,
        durationMs: summary?.durationMs ?? Math.round(performance.now() - startedAt),
        upstream: summarizeGaps(upstreamGaps),
        browser: summarizeGaps(browserGaps),
        upstreamSeries: upstreamGaps,
        browserSeries: browserGaps,
      });
      setTestState('done');
    } catch (error) {
      if (error?.name === 'AbortError') {
        setTestState('idle');
        return;
      }
      setTestError(String(error?.message || '测速失败'));
      setTestState('error');
    } finally {
      abortRef.current = null;
    }
  };

  const upstream = quality?.upstream;
  const downstream = quality?.downstream;
  const downstreamSummary = downstream?.summary;
  const activeCount = Array.isArray(downstream?.active) ? downstream.active.length : 0;
  const gapTypicalMs = testResult && testResult.browser.p50 !== null && testResult.upstream.p50 !== null
    ? testResult.browser.p50 - testResult.upstream.p50
    : null;
  const rttState = rttStatus(rtt.p50);
  const stallCount = upstream?.stallCount || 0;
  const hasDownstreamBackpressure = (downstreamSummary?.streamsWithBackpressure || 0) > 0;

  return (
    <Card className="quality-card">
      <CardHeader className="quality-header">
        <div className="card-heading-line">
          <div className="card-heading-icon"><Gauge size={18} /></div>
          <div>
            <CardTitle>连接质量</CardTitle>
            <CardDescription>分三段看链路：本机到网关、网关到上游、网关到客户端。有请求进行中时每秒刷新，空闲时每 5 秒刷新；本机延迟每 4 秒采样。</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="quality-grid">
          <div className="quality-cell">
            <div className="quality-cell-head">
              <span className="quality-cell-title" title="打开控制台的这台设备，到代理网关的响应速度">本机 → 网关</span>
              <Badge variant={rttState.variant} className="quality-badge">
                {rtt.p50 === null ? (rtt.sampleCount ? '连接异常' : '检测中') : `${formatMs(rtt.p50)} · ${rttState.label}`}
              </Badge>
            </div>
            <Sparkline values={rtt.series} stroke="#0d9488" />
            <div className="quality-metrics">
              <Metric label="典型" value={formatMs(rtt.p50)} tip={METRIC_TIPS.rttTypical} />
              <Metric label="95% 快于" value={formatMs(rtt.p95)} tip={METRIC_TIPS.rttP95} />
              <Metric label="波动" value={formatMs(rtt.jitter)} tip={METRIC_TIPS.rttJitter} />
              <Metric label="探测失败" value={formatPercent(rtt.lossRate)} tip={METRIC_TIPS.rttLoss} />
            </div>
            <p className="quality-note">每 4 秒探测一次，只代表打开控制台的这台设备；真实 API 客户端的流式表现请看下方测速。</p>
          </div>
          <div className="quality-cell">
            <div className="quality-cell-head">
              <span className="quality-cell-title" title="代理网关到 Command Code 上游模型的请求质量">网关 → 上游</span>
              <Badge variant={stallCount > 0 ? 'warning' : 'success'} className="quality-badge">
                {upstream ? (stallCount > 0 ? `卡顿 ${stallCount} 次` : '无卡顿') : '统计中'}
              </Badge>
            </div>
            <Sparkline values={ttftTrend} stroke="#6366f1" />
            <div className="quality-metrics">
              <Metric label="首字等待" value={formatMs(upstream?.ttftP50Ms)} tip={METRIC_TIPS.ttft} />
              <Metric label="95% 快于" value={formatMs(upstream?.ttftP95Ms)} tip={METRIC_TIPS.ttftP95} />
              <Metric label="输出速度" value={formatSpeed(upstream?.speedP50)} tip={METRIC_TIPS.speed} />
              <Metric label="失败" value={upstream ? `${upstream.errorCount} / ${upstream.sampleSize} 次` : '—'} tip={METRIC_TIPS.upstreamError} />
            </div>
            <p className="quality-note" title={METRIC_TIPS.gapP95}>
              最近 100 次真实请求的统计，首字等待含模型思考时间。
              {upstream?.lastGapP95Ms !== null && upstream?.lastGapP95Ms !== undefined && (
                <>数据块间隔（95%）≤ {formatMs(upstream.lastGapP95Ms)}。</>
              )}
            </p>
          </div>
          <div className="quality-cell">
            <div className="quality-cell-head">
              <span className="quality-cell-title" title="代理网关把流式结果发给 API 客户端的过程">客户端 → 网关下行</span>
              <Badge
                variant={hasDownstreamBackpressure ? 'warning' : 'neutral'}
                className="quality-badge"
                title={hasDownstreamBackpressure ? '最近的流式连接里出现过客户端接收跟不上的情况，详见下方指标' : undefined}
              >
                {downstream ? (activeCount > 0 ? `进行中 ${activeCount} 条` : '当前空闲') : '统计中'}
              </Badge>
            </div>
            <div className="quality-metrics quality-metrics-stack">
              <Metric
                label="接收跟不上的流"
                value={downstreamSummary ? `${downstreamSummary.streamsWithBackpressure} / ${downstreamSummary.sampleSize} 条` : '—'}
                tip={METRIC_TIPS.slowStreams}
              />
              <Metric label="排队次数" value={formatCount(downstreamSummary?.backpressureEvents, '次')} tip={METRIC_TIPS.queueTimes} />
              <Metric label="单次最长等待" value={formatMs(downstreamSummary?.maxDrainWaitMs)} tip={METRIC_TIPS.drainMax} />
              <Metric label="累计等待" value={formatMs(downstreamSummary?.totalDrainWaitMs)} tip={METRIC_TIPS.drainTotal} />
            </div>
            <p className="quality-note">客户端收得慢时，网关的发送队列会排队；这里频繁出现排队，通常是客户端网络或设备性能问题。</p>
          </div>
        </div>

        <div className="speedtest-panel">
          <div className="speedtest-head">
            <div>
              <strong>流式测速</strong>
              <span>发一条很小的流式请求，同时记录网关与浏览器收到每个数据块的时间；两者之差就是这台设备到网关的额外延迟。</span>
            </div>
            <div className="speedtest-controls">
              {allowedModels.length ? (
                <select
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={testState === 'running'}
                  aria-label="选择测速模型"
                >
                  {allowedModels.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
                </select>
              ) : (
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="模型 ID，如 glm-4.6"
                  disabled={testState === 'running'}
                  aria-label="输入测速模型 ID"
                />
              )}
              {testState === 'running' ? (
                <Button type="button" size="sm" variant="secondary" onClick={() => abortRef.current?.abort()}>
                  停止 · 已收 {testProgress.chunks} 块 / {(testProgress.elapsedMs / 1000).toFixed(1)}s
                </Button>
              ) : (
                <Button type="button" size="sm" onClick={runSpeedtest} disabled={!model.trim()}>
                  <Play size={14} /> 开始测速
                </Button>
              )}
            </div>
          </div>
          {testError && <div className="speedtest-error"><CircleAlert size={15} /><span>{testError}</span></div>}
          {testResult && (
            <div className="speedtest-results">
              <div className="speedtest-columns">
                <div className="speedtest-col">
                  <span className="qc-label">网关收到数据的间隔（上游 → 网关）</span>
                  <Sparkline values={testResult.upstreamSeries} stroke="#6366f1" />
                  <div className="quality-metrics">
                    <Metric label="典型" value={formatMs(testResult.upstream.p50)} tip={METRIC_TIPS.gapTypical} />
                    <Metric label="95% 小于" value={formatMs(testResult.upstream.p95)} tip={METRIC_TIPS.gapP95} />
                    <Metric label="最长" value={formatMs(testResult.upstream.max)} tip={METRIC_TIPS.gapMax} />
                  </div>
                </div>
                <div className="speedtest-col">
                  <span className="qc-label">浏览器收到数据的间隔（上游 → 本机）</span>
                  <Sparkline values={testResult.browserSeries} stroke="#0d9488" />
                  <div className="quality-metrics">
                    <Metric label="典型" value={formatMs(testResult.browser.p50)} tip={METRIC_TIPS.gapTypical} />
                    <Metric label="95% 小于" value={formatMs(testResult.browser.p95)} tip={METRIC_TIPS.gapP95} />
                    <Metric label="最长" value={formatMs(testResult.browser.max)} tip={METRIC_TIPS.gapMax} />
                  </div>
                </div>
              </div>
              <div className="speedtest-verdict">
                模型 <strong>{testResult.model || '—'}</strong> · 首字 <strong>{formatMs(testResult.ttftMs)}</strong> · 总时长 <strong>{formatMs(testResult.durationMs)}</strong> ·{' '}
                本机网络额外延迟（典型）≈ <strong>{gapTypicalMs === null ? '—' : `${Math.round(gapTypicalMs)}ms`}</strong>
                <br />
                算法：浏览器典型值 − 网关典型值，含浏览器渲染抖动，仅供参考；<ArrowDownUp size={12} className="qc-inline-icon" /> 两条曲线越接近，说明本机网络对流式传输的影响越小。
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
