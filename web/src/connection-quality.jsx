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
 * 流式测速是浏览器侧唯一能测量「流式负载下本机网络」的手段：
 * 通过 /admin/api/speedtest 发起一条受控的小流式请求，服务端把网关侧每个数据块
 * 的到达时间随 SSE 帧一起下发；浏览器用自己的本地到达时间对比同一条流的两组
 * 间隔，差值即本机↔网关段的附加延迟（含渲染调度抖动，仅供参考）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, CircleAlert, Gauge, Play, Radio, Wifi } from 'lucide-react';
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

function rttBadgeVariant(p50) {
  if (p50 === null) return 'danger';
  if (p50 < 150) return 'success';
  if (p50 < 400) return 'warning';
  return 'danger';
}

/** 顶栏徽章：本机 ↔ 网关的实时 RTT（空闲探测，辅助指标）。 */
export function RttBadge() {
  const rtt = useRttProbe();
  if (!rtt.sampleCount) return null;
  const title = rtt.p50 === null
    ? '本机 ↔ 网关探测失败（连续超时或断连），每 4 秒自动重试'
    : `本机 ↔ 网关 空闲往返：p50 ${rtt.p50}ms · p95 ${rtt.p95}ms · 抖动 ${rtt.jitter}ms · 失败 ${Math.round((rtt.lossRate || 0) * 100)}%（每 4 秒探测，空闲指标仅供参考）`;
  return (
    <Badge variant={rttBadgeVariant(rtt.p50)} title={title}>
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
const QUALITY_POLL_MS = 5000;
const QUALITY_TREND_MAX = 30;

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

  const allowedModels = useMemo(
    () => models.filter((item) => item && item.id && item.allowed !== false),
    [models],
  );

  useEffect(() => {
    if (!model && allowedModels.length) setModel(allowedModels[0].id);
  }, [allowedModels, model]);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch('/admin/api/stream-quality', { credentials: 'same-origin' });
        if (!response.ok) return; // 401 等由全局登录流程处理
        const data = await response.json();
        if (stopped || !data) return;
        setQuality(data);
        const p95 = data?.upstream?.ttftP95Ms;
        if (p95 !== null && p95 !== undefined) {
          setTtftTrend((current) => [...current, p95].slice(-QUALITY_TREND_MAX));
        }
      } catch {
        // 下一次轮询再试
      }
    };
    void load();
    const timer = window.setInterval(load, QUALITY_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
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
  const gapP95Diff = testResult && testResult.browser.p50 !== null && testResult.upstream.p50 !== null
    ? testResult.browser.p50 - testResult.upstream.p50
    : null;

  return (
    <Card className="quality-card">
      <CardHeader className="quality-header">
        <div className="card-heading-line">
          <div className="card-heading-icon"><Gauge size={18} /></div>
          <div>
            <CardTitle>连接质量</CardTitle>
            <CardDescription>流式链路分段测量：上游到达间隔 / 下行积压 / 本机往返，每 5 秒刷新</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="quality-grid">
          <div className="quality-cell">
            <div className="quality-cell-head">
              <span>本机 → 网关</span>
              <Badge variant={rttBadgeVariant(rtt.p50)} className="quality-badge">
                {rtt.p50 === null ? (rtt.sampleCount ? '异常' : '探测中') : `${Math.round(rtt.p50)}ms`}
              </Badge>
            </div>
            <Sparkline values={rtt.series} stroke="#0d9488" />
            <div className="quality-metrics">
              <span>p50 <strong>{formatMs(rtt.p50)}</strong></span>
              <span>p95 <strong>{formatMs(rtt.p95)}</strong></span>
              <span>抖动 <strong>{formatMs(rtt.jitter)}</strong></span>
              <span>失败 <strong>{rtt.lossRate === null ? '—' : `${Math.round(rtt.lossRate * 100)}%`}</strong></span>
            </div>
            <p className="quality-note">空闲 RTT（每 4 秒），只反映控制台自身链路；流式负载请看下方测速。</p>
          </div>
          <div className="quality-cell">
            <div className="quality-cell-head">
              <span>网关 → 上游</span>
              <Badge variant={(upstream?.stallCount || 0) > 0 ? 'warning' : 'success'} className="quality-badge">
                停顿 {upstream?.stallCount ?? '—'} 次
              </Badge>
            </div>
            <Sparkline values={ttftTrend} stroke="#6366f1" />
            <div className="quality-metrics">
              <span>TTFT p50 <strong>{formatMs(upstream?.ttftP50Ms)}</strong></span>
              <span>p95 <strong>{formatMs(upstream?.ttftP95Ms)}</strong></span>
              <span>速度 p50 <strong>{upstream?.speedP50 == null ? '—' : `${Math.round(upstream.speedP50)} tok/s`}</strong></span>
              <span>错误 <strong>{upstream ? `${upstream.errorCount}/${upstream.sampleSize}` : '—'}</strong></span>
            </div>
            <p className="quality-note">最近 100 条真实请求的聚合；间隔 p95 参考 {formatMs(upstream?.lastGapP95Ms)}。TTFT 含模型思考时间。</p>
          </div>
          <div className="quality-cell">
            <div className="quality-cell-head">
              <span>客户端 → 网关下行</span>
              <Badge variant={(downstreamSummary?.streamsWithBackpressure || 0) > 0 ? 'warning' : 'success'} className="quality-badge">
                在途 {activeCount}
              </Badge>
            </div>
            <div className="quality-metrics quality-metrics-stack">
              <span>积压流 <strong>{downstreamSummary ? `${downstreamSummary.streamsWithBackpressure}/${downstreamSummary.sampleSize}` : '—'}</strong></span>
              <span>积压事件 <strong>{downstreamSummary?.backpressureEvents ?? '—'}</strong></span>
              <span>最长等待 <strong>{formatMs(downstreamSummary?.maxDrainWaitMs)}</strong></span>
              <span>累计等待 <strong>{formatMs(downstreamSummary?.totalDrainWaitMs)}</strong></span>
            </div>
            <p className="quality-note">写缓冲堆积说明客户端消费跟不上（近 60 条流式连接）；上游正常而这里频繁积压，问题在客户端网络。</p>
          </div>
        </div>

        <div className="speedtest-panel">
          <div className="speedtest-head">
            <div>
              <strong>流式测速</strong>
              <span>发起一条受控的小流式请求，对比同一条流在「网关侧」与「本机浏览器侧」的到达间隔，两组曲线的差值即本机↔网关段的附加延迟。</span>
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
                  停止 · {testProgress.chunks} 帧 / {(testProgress.elapsedMs / 1000).toFixed(1)}s
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
                  <span className="qc-label">网关侧到达间隔（网关 → 上游）</span>
                  <Sparkline values={testResult.upstreamSeries} stroke="#6366f1" />
                  <div className="quality-metrics">
                    <span>p50 <strong>{formatMs(testResult.upstream.p50)}</strong></span>
                    <span>p95 <strong>{formatMs(testResult.upstream.p95)}</strong></span>
                    <span>max <strong>{formatMs(testResult.upstream.max)}</strong></span>
                  </div>
                </div>
                <div className="speedtest-col">
                  <span className="qc-label">本机浏览器到达间隔（含本机 ↔ 网关段）</span>
                  <Sparkline values={testResult.browserSeries} stroke="#0d9488" />
                  <div className="quality-metrics">
                    <span>p50 <strong>{formatMs(testResult.browser.p50)}</strong></span>
                    <span>p95 <strong>{formatMs(testResult.browser.p95)}</strong></span>
                    <span>max <strong>{formatMs(testResult.browser.max)}</strong></span>
                  </div>
                </div>
              </div>
              <div className="speedtest-verdict">
                模型 <strong>{testResult.model || '—'}</strong> · 首字 <strong>{formatMs(testResult.ttftMs)}</strong> · 总时长 <strong>{formatMs(testResult.durationMs)}</strong> ·{' '}
                本机段附加延迟 p50 ≈ <strong>{gapP95Diff === null ? '—' : `${Math.round(gapP95Diff)}ms`}</strong>
                （浏览器 p50 − 网关 p50，含渲染调度抖动，仅供参考；<ArrowDownUp size={12} className="qc-inline-icon" /> 两条曲线形状越接近，链路越透明）
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
