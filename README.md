# cmdgo2api

> [中文文档](README_zh.md)

A reverse proxy that converts Command Code API to OpenAI / Anthropic compatible endpoints, with a bundled Web console for managing multiple accounts. The proxy core remains a single file; the Web console is provided as a separate management layer.

> **Derivative work notice.** `cmdgo2api` is an independent continuation of [`MAXeaglet/commandcode-proxy`](https://github.com/MAXeaglet/commandcode-proxy) (MIT License). The reverse-proxy core, the Command Code protocol implementation, and the original documentation come from that upstream project and remain under `Copyright (c) 2026 MAXeaglet`. The Web console, multi-account token storage and switching, quota display, and the remote authorization-helper bridge are additions made in this repository. See [License and Credits](#license-and-credits).

Built by analyzing official CLI network traffic to accurately replicate the Command Code API request protocol, including device-fingerprint and lifecycle pre-requests.

**Features**: OpenAI Chat Completions + Anthropic Messages API | Streaming & non-streaming | Tool calling (tool_use) | Multimodal image input | Reasoning effort | Dynamic upstream model catalog | Console model allowlist | Multiple gateway keys | Multi-account token storage and one-click switching | Per-account five-hour, weekly, and total remaining quotas | Cookie-protected Web console | Command Code browser authorization | Minute-level background usage refresh | Update and restart | Cache hit metrics | Device fingerprint disguise (per-key, auto-refresh) | `x-api-key` auth (Anthropic SDK) | Client disconnect detection with upstream abort | Zero-output → 429 auto-retry | Consecutive timeout → 429 auto-retry | Privacy-aware logging

**Community**: [Linux.do](https://linux.do) — a friendly Chinese tech community.

## Quick Start

```bash
npm run build    # Install and build the web console
npm start        # Start (the repo ships with config.json listening on http://0.0.0.0:3050)
```

Open `http://127.0.0.1:3050/console`. On first access without a gateway key, the console asks you to set the first key. It becomes both the public console password and the first proxy access key. After signing in, select **Browser login** and complete the official Command Code authorization.

When gateway keys are configured, API clients send a gateway key using the `Authorization: Bearer` header (or `x-api-key` for Anthropic SDKs). Without gateway keys, the original `user_` upstream-key compatibility remains available:

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## Quick Deployment

### From Source

Node.js 18 or newer is required. Install frontend dependencies and build once, then start the proxy:

```bash
git clone https://github.com/1deaaa/cmdgo2api.git
cd cmdgo2api
npm run build    # Install and build the web console
npm start
```

Open `http://127.0.0.1:3050/console`, set the gateway key, and select **Add account**. Local access uses the official Command Code browser authorization. Public HTTPS access generates a one-time local authorization-helper command; run it on a trusted local computer to complete the official callback and add the account without copying or pasting the upstream token.

### Docker Compose

```bash
docker compose up -d --build
docker compose logs -f proxy
```

The default host port is `3050`. Override it with `PROXY_PORT=13050 docker compose up -d --build`. Compose mounts both runtime and account directories, so saved accounts survive container restarts.

## File Structure

```
cmdgo2api/
├── config.json           # Port / log path etc.
├── LICENSE               # MIT License (upstream + this fork)
├── package.json          # npm start / npm run build / npm run dev
├── proxy.mjs             # Single-file proxy core (~1900 lines)
├── web/                  # Web console, admin API, and frontend build project
├── tools/                # Remote authorization helper
├── Dockerfile            # Container build (node:22-alpine)
├── docker-compose.yml    # Container orchestration
├── .dockerignore         # Build context exclusions
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # GHCR multi-arch publish on v* tags
├── captured-requests/    # Captured CLI traffic (protocol analysis reference; local only, git-ignored, not distributed)
├── README.md             # This document (English)
└── README_zh.md          # Chinese documentation
```

## Configuration

### config.json

| Field | Default | Description |
|------|--------|-------------|
| `port` | `3000` | Listen port (repo config.json ships with `3050`) |
| `host` | `0.0.0.0` | Listen address |
| `publicUrl` | `""` | Legacy public-callback setting; retained for compatibility and cannot bypass the loopback-only upstream auth rule |
| `apiBase` | `https://api.commandcode.ai` | CC API base URL |
| `projectSlug` | `cc-proxy` | `x-project-slug` header |
| `apiKey` | `""` | Optional fallback API key (requests can also send it via header) |
| `gatewayApiKey` | `""` | Legacy single gateway key; manage multiple keys in the Web console |
| `gatewayApiKeys` | `[]` | Optional gateway-key array; the first key is also the console password |
| `allowedModelIds` | `null` | Optional model allowlist; `null` allows all models and console settings are stored in the runtime directory |
| `logFile` | `""` | Log file path (empty = console only) |
| `logLevel` | `info` | Log level |
| `useProviderModels` | `true` | Dynamically fetch model list from Provider API |
| `modelRefreshIntervalMs` | `300000` | Model list cache refresh interval (5 min) |
| `zdr` | `false` | Request ZDR-only routing from Command Code |

### Environment Variables

| Variable | Overrides |
|----------|-----------|
| `PORT` | `port` |
| `HOST` | `host` |
| `CC_PUBLIC_URL` | `publicUrl`; legacy compatibility setting, not used for remote account authorization |
| `CONSOLE_PUBLIC_URL` | `publicUrl`; compatibility alias for `CC_PUBLIC_URL` |
| `CC_API_BASE` | `apiBase` |
| `PROJECT_SLUG` | `projectSlug` |
| `GATEWAY_API_KEY` | `gatewayApiKey` |
| `GATEWAY_API_KEYS_JSON` | `gatewayApiKeys` (advanced) |
| `CC_API_KEY` | Command Code upstream API key |
| `LOG_FILE` | `logFile` |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` |
| `CC_STREAM_IDLE_MS` | Streaming upstream read idle timeout (default `30000`) |
| `CC_NONSTREAM_IDLE_MS` | Non-streaming upstream read idle timeout (default `90000`) |
| `CC_MAX_INFLIGHT` | In-process concurrent request cap (default `0` = unlimited) |
| `CMD_ZDR` | `zdr` (`1` to enable) |

When enabled, the proxy sends `x-cmd-zdr: 1` on Command Code generation requests
and the fingerprint/lifecycle initialization requests. It does not add the header
to the npm version check or the proxy's `/provider/v1/models` catalog request.
This requests Command Code's ZDR-only routing; the upstream service remains the
authority for actual retention and provider availability.

**Request body limit**: independent of `config.json` — requests larger than **100 MB** are rejected with `HTTP 413` (the connection is kept alive and drained, not reset). Override with `CC_MAX_BODY_MB` (positive integer, unit: MB).

> ⚠️ **Memory amplification**: a request body exists in several copies before it reaches upstream; measured peak ≈ body size × **5.1–7.4** (7 MB → +52 MB, 20 MB → +116 MB, while a request rejected with `413` costs only ×1.05). The default `CC_MAX_BODY_MB=100` therefore implies up to ~550 MB for a **single** request, and that limit is per-request, not global. See [Memory & Deployment](#memory--deployment).

With gateway keys configured, clients authenticate to this proxy with any gateway key while the proxy uses `CC_API_KEY` for Command Code. Without gateway keys, clients may still provide a `user_...` upstream key directly.

### Web Console

The console is available at `/console`; its management API is under `/admin/api`. The public endpoints are limited to first-time setup, login, and service status. After setup, keys, usage, model permissions, restart, and update operations require the console session cookie.

- The first gateway key is the public console password. Deleting it promotes the next key; deleting the last key returns to first-time setup.
- Add or delete gateway keys without restarting the process. The first key can also be replaced, which invalidates console sessions.
- Use **Browser login** to store multiple Command Code account tokens locally. The account list supports one-click switching, deletion, and refreshing all accounts; each row shows only the remaining five-hour, weekly, and total quotas. Switching updates the proxy's active upstream token immediately without a restart.
- When any of the active account's five-hour, weekly, or monthly quotas reaches 100%, the console automatically selects the next account in list order whose three quota values are known and not full; it wraps to the beginning, and skips accounts with unknown or failed usage data.
- The model manager reads the full catalog from the upstream Provider API. All models are allowed by default; saved restrictions hide models from `/v1/models` and return `HTTP 403` for direct calls.
- Usage refreshes in the background every 60 seconds while the console is open.
- Update and restart runs only when the Git worktree is clean, using `git pull --ff-only`, frontend dependency installation, and a production build. Local changes are refused rather than overwritten.
- Local consoles (`127.0.0.1`, `localhost`, or `::1`) use the official browser authorization and loopback callback. Remote consoles do not fake a public callback because Command Code only accepts loopback callbacks. Instead, **Add account** generates a one-time command that runs the local authorization helper on a trusted computer. The helper receives the official loopback callback locally and forwards the result over HTTPS; the console never displays or asks you to paste the upstream token. The ticket is stored only as a hash on the server, expires in about 10 minutes, and is invalidated after one use. SSH port forwarding is also supported when you want to keep the full browser flow.
- Each **Add account** attempt requests a fresh official login instead of silently reusing the browser's current account. If the authorization page still shows the old account, sign out of Command Code first or reopen the authorization URL in a private browser window.

Runtime credentials are stored in `~/.config/commandcode-proxy/credentials.env`, model settings in `~/.config/commandcode-proxy/settings.json`, and multiple account tokens plus cached quotas in `~/.config/commandcode-proxy/accounts.json`. The active account is also mirrored to `~/.commandcode/auth.json` for compatibility. Files are created with restrictive permissions; an older single-account `auth.json` is migrated automatically and must not be committed or copied to a public directory.

## API Endpoints

### `POST /v1/chat/completions`

OpenAI Chat Completions compatible. Supports streaming, non-streaming, tool calling, multimodal image input, and reasoning effort.

**Request parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `model` | Yes | Model ID (see model list) |
| `messages` | Yes | Conversation messages, supports `system/user/assistant/tool` roles |
| `max_tokens` | No | Max tokens to generate (default 64000) |
| `stream` | No | SSE streaming (default false) |
| `temperature` | No | Sampling temperature (0-2) |
| `reasoning_effort` | No | Reasoning intensity: `low`/`medium`/`high`/`max` |
| `tools` | No | Tool definitions (OpenAI function calling format) |
| `tool_choice` | No | Tool selection strategy |
| `parallel_tool_calls` | No | Allow parallel tool calls |

**Simple request:**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

**Multimodal image input (vision model required):**
```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**Tool calling:**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [...],
  "tools": [{
    "type": "function",
    "function": { "name": "get_weather", "description": "...", "parameters": {...} }
  }],
  "tool_choice": "auto"
}
```

**Streaming response (SSE):**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking..."}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":8}}}

data: [DONE]
```

**Non-streaming response (with cache hits):**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek/deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello!",
      "reasoning_content": "The user said hello, I should respond."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 7558,
    "completion_tokens": 42,
    "total_tokens": 7600,
    "prompt_tokens_details": { "cached_tokens": 7552 }
  }
}
```

### `POST /v1/messages`

Anthropic Messages API compatible endpoint. Supports streaming, non-streaming, and tool calling.

**Request body:**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "You are a helpful assistant.",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

**Anthropic protocol conversion (automatic):**

| Concept | Anthropic Format | Conversion |
|---------|-----------------|------------|
| System prompt | Top-level `system` field | Auto-converted to OpenAI `system` message |
| Message content | `content` array (text/tool_use/tool_result) | Auto-mapped to corresponding roles |
| Tool results | `tool_result` blocks in `user` messages | Auto-converted to `role: "tool"` |
| Tool definitions | `input_schema` | Auto-mapped to `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`, `tool`→function object |
| Reasoning | `thinking.budget_tokens` | Auto-mapped to `reasoning_effort` (≥10000→high, ≥5000→medium, ≥2000→low) |
| Stop reason | `end_turn`/`max_tokens`/`tool_use` | Auto-mapped to `stop`/`length`/`tool_calls` |
| Token usage | `input_tokens`/`output_tokens` + cache | Passed through, cache fields mapped to Anthropic format |

**Streaming response (SSE, Anthropic format):**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"...","usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10,"cache_read_input_tokens":0,"input_tokens":100}}

event: message_stop
data: {"type":"message_stop"}
```

**Non-streaming response:**
```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "deepseek/deepseek-v4-flash",
  "content": [{ "type": "text", "text": "Hello!" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 7558,
    "output_tokens": 42,
    "cache_read_input_tokens": 7552,
    "cache_creation_input_tokens": null
  }
}
```

### `GET /v1/models`

Returns available model list. Fetched dynamically from Provider API (5 min cache), falls back to hardcoded list on failure.

### `GET /health`

Health check. Returns `OK`.

## Error Codes

| HTTP Status | Description |
|-------------|-------------|
| 400 | Invalid request format |
| 401 | API Key missing / invalid format / rejected (Key must start with `user_`; sent via `Authorization: Bearer` or `x-api-key`) |
| 429 | Zero output tokens, or idle timeout (30s streaming / 90s non-streaming) — SDK auto-retry with `Retry-After`; after 3 consecutive timeouts a "reduce context" hint is returned |
| 502 | CC upstream error |

## Model List

The proxy returns a live model list via `GET /v1/models`. Below are common models for reference; the actual list depends on the live API response — see [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits) for plan details.

### Common Models

| Model ID | Provider |
|----------|----------|
| `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-opus-4-7` / `claude-haiku-4-5-20251001` | Anthropic |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` | OpenAI |
| `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash` | DeepSeek |
| `moonshotai/Kimi-K2.6` / `moonshotai/Kimi-K2.5` | Kimi |
| `zai-org/GLM-5.1` / `zai-org/GLM-5` | GLM |
| `MiniMaxAI/MiniMax-M3` / `MiniMaxAI/MiniMax-M2.7` / `MiniMaxAI/MiniMax-M2.5` | MiniMax |
| `Qwen/Qwen3.7-Max` / `Qwen/Qwen3.6-Max-Preview` / `Qwen/Qwen3.6-Plus` | Qwen |
| `stepfun/Step-3.7-Flash` / `stepfun/Step-3.5-Flash` | Step |
| `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5` | Xiaomi (**image input supported**) |
| `google/gemini-3.5-flash` / `google/gemini-3.1-flash-lite` | Gemini |

> ⚠️ Some models (e.g. `deepseek-v4-flash`, `claude-sonnet-4-6`) do not support image input. Use `xiaomi/mimo-v2.5`, `Kimi-K2.5`, or other vision models for multimodal.

## Integration Examples

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050/v1",
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### cURL
```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

### Cursor
Add a Custom Provider in Cursor settings:
- **API Base URL**: `http://127.0.0.1:3050/v1`
- **API Key**: `user_xxxxxxxxx`
- **Model**: Choose from the model list

### Anthropic (Python SDK)
```python
import anthropic

client = anthropic.Anthropic(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050",
)
message = client.messages.create(
    model="deepseek/deepseek-v4-flash",
    max_tokens=1000,
    system="You are helpful.",
    messages=[{"role": "user", "content": "hello"}],
)
print(message.content[0].text)
```

The Anthropic SDK authenticates via the `x-api-key` header — supported by the proxy natively (no `Authorization` header needed).

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## Anti-Detection

Based on analysis of official CLI traffic (version auto-fetched from npm registry):

| Mechanism | Implementation |
|-----------|---------------|
| **Device Fingerprint** | `POST /alpha/fingerprint/record` before first request per key; random fingerprint pool (15 CPUs, global timezones), SHA-256 hashed, per-key binding, refreshed every 8h + 2h jitter |
| **Lifecycle Events** | `POST /alpha/lifecycle-events` (`cli_session_exists`) sent in parallel with fingerprint on session init |
| **Per-Key Session** | One session per API key, 12h expiry + 1h random jitter |
| **Version** | `x-command-code-version` auto-fetched from npm registry (24h refresh) |
| **CLI Envelope** | config/memory/taste/skills/permissionMode/params |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **Environment** | `x-cli-environment: production`, `x-co-flag: "false"`, `x-taste-learning: "false"` |
| **Project Slug** | `x-project-slug` generated from session ID (CLI-compatible format) |
| **Reasoning Effort** | `reasoning_effort` pass-through (low/medium/high/max) |
| **Key Validation** | Regex `user_[a-zA-Z0-9_-]+` on `Authorization: Bearer` or `x-api-key`, auto-cleans extra paths/prefixes, rejects `sk-xxx` format |
| **Stream Timeout** | 30s streaming / 90s non-streaming → 429 with SDK auto-retry |
| **Consecutive Timeout** | 3 consecutive timeouts before "reduce context" hint |
| **Zero-Output Guard** | outputTokens=0 → 429 `rate_limit_error` (SDK auto-retry, anti false billing) |
| **Upstream Abort** | `AbortController` on client disconnect + all error paths |
| **Privacy Logging** | No API key fragments, no error bodies, no stack traces in logs |

## Protocol Details

### CC API Request Structure

```json
{
  "config": {
    "workingDir": "C:\\project",
    "date": "2026-06-07",
    "environment": "win32-x64, Node.js v24.16.0",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": null,
  "taste": null,
  "skills": "",
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "max_tokens": 64000,
    "stream": true,
    "reasoning_effort": "max"
  }
}
```

Conditional fields: `system` (extracted from `system` messages), `temperature`, `reasoning_effort`, `tools` (mapped to CC `input_schema` format).

### CC API Image Message Format

The CLI sends images in this format:

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "data:image/jpeg;base64,..." },
    { "type": "text", "text": "What does this image say?" }
  ]
}
```

The proxy receives OpenAI `image_url` format and converts it to the above CC format transparently.

## Docker Deployment

### Pull from GHCR

Pre-built multi-arch images (`linux/amd64` + `linux/arm64`) are published to the GitHub Container Registry automatically on every `v*` tag via GitHub Actions:

```bash
docker pull ghcr.io/1deaaa/cmdgo2api:latest
docker run -d --name cmdgo2api -p 3050:3050 \
  -e PORT=3050 \
  -v cc-proxy-runtime:/root/.config/commandcode-proxy \
  -v cc-proxy-auth:/root/.commandcode \
  ghcr.io/1deaaa/cmdgo2api:latest
```

The `latest` tag is updated on each release. The image is public — no login required to pull.

> This repository has no release tag yet, so the image above is created by the first `v*` tag push (the workflow in `.github/workflows/docker-publish.yml` also accepts a `release` branch push or a manual run). Until then, use `docker compose up -d --build` or build the image locally.

> Upstream also publishes `ghcr.io/maxeaglet/commandcode-proxy`. That image is the **unmodified upstream build** and does **not** include the Web console, multi-account switching, or the remote authorization-helper bridge. Use the image above (or build from source) to get this fork's features.

### Quick Start (docker compose)

```bash
docker compose build
docker compose up -d
```

The proxy will listen on `http://0.0.0.0:3050` and provide `/console`. Public-domain access uses the HTTPS authorization-helper flow; local access uses the official browser authorization:

```bash
docker compose up -d --build
```

Set `PROXY_PORT` to customize the host port:

```bash
PROXY_PORT=13050 docker compose up -d
```

### Build from Source

```bash
npm run build
docker build -t commandcode-proxy:latest .
docker run -d -p 3050:3050 -e PORT=3050 commandcode-proxy:latest
```

### Multi-Architecture Build

```bash
npm run docker:build:multi
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3050` | Container listen port |
| `PROXY_PORT` | `3050` | Host port (compose only) |
| `CC_PUBLIC_URL` | empty | Legacy public-callback setting; retained for compatibility but cannot bypass Command Code's loopback-only callback restriction |
| `CC_MAX_BODY_MB` | `100` | Max request body size in MB; oversized requests are rejected with `HTTP 413` |
| `CC_CLIENT_DRAIN_TIMEOUT_MS` | *(unset = disabled)* | Drop the client and abort upstream when downstream backpressure blocks longer than this; see [Stalled clients](#stalled-clients-neither-reading-nor-disconnecting) |
| `CC_STREAM_IDLE_MS` | `30000` | Streaming upstream read idle timeout in ms; see [Upstream idle timeouts](#upstream-idle-timeouts) |
| `CC_NONSTREAM_IDLE_MS` | `90000` | Non-streaming upstream read idle timeout in ms |
| `CC_MAX_INFLIGHT` | `0` (unlimited) | In-process request cap; over-limit returns `503` + `Retry-After`; see [In-flight cap](#in-flight-cap-optional) |

## In-flight Cap (Optional)

**Off by default** (`CC_MAX_INFLIGHT` unset = no concurrency limit), so existing behaviour is unchanged.

This project is a **pure proxy layer**; concurrency control belongs downstream — use your reverse proxy for per-IP / per-key limits (see the `limit_conn` block in [Memory & Deployment](#memory--deployment)). This option is **not** a replacement for that; it only covers running **without** a reverse proxy (which both the Dockerfile and `npm start` invite) with an in-process, **global-only** guard:

```bash
CC_MAX_INFLIGHT=32 npm start    # at most 32 concurrent requests
```

Over the limit it returns `503` + `Retry-After: 5` + `type: server_busy` — a shape the official OpenAI / Anthropic SDKs retry with backoff, instead of the client seeing a connection reset. `/health` and `/` are exempt so liveness probes and orchestrators never receive a 503 because business traffic is busy.

**Why it exists**: memory is `in-flight × (0.13 MB + 5.5 × body_MB)`. `CC_MAX_BODY_MB` bounds only the **per-request** term; nothing bounds the multiplier — at the default 100 MB, N concurrent requests can cost N × 550 MB.

> ⚠️ Enabling this is **not** the same as being memory-safe: 32 × 550 MB still exceeds a small box. For a hard bound, lower `CC_MAX_BODY_MB` **as well**.

## Upstream Idle Timeouts

Two upstream read idle watchdogs; on expiry the proxy returns `429` (with `retry_after`) so the SDK retries automatically:

| Env var | Default | Applies to |
|---|---|---|
| `CC_STREAM_IDLE_MS` | `30000` | Streaming requests |
| `CC_NONSTREAM_IDLE_MS` | `90000` | Non-streaming requests |

**Semantics**: they measure only the time spent waiting inside `reader.read()`, reset on every received chunk — **not the total request duration**. As long as upstream keeps emitting, the watchdog never fires, even for a request that has been running for tens of minutes.

**The defaults differ from the official CLI, and that is a known trade-off** ([#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)): the official CLI has **no** upstream idle timeout at all — deobfuscating `command-code@1.50.0` shows every `createApiClient({ baseUrl })` call site passes no `timeout`, and 700+ second stalls complete successfully. This proxy keeps 30 s to catch genuinely dead connections; the cost is that a reasoning model's long prefill/first-token stall can be killed.

If you see `429 Response timeout` or `zero output tokens` where the log shows `elapsedMs ≈ 30000` and `bytesReceived = 0`, the watchdog killed a healthy stall — raise it:

```bash
CC_STREAM_IDLE_MS=300000 npm start      # 5 minutes
```

> ⚠️ A false kill costs more than one failed request: the abort returns `429 + retry_after`, the SDK retries automatically, and a retry **resends the entire context** — so each false kill re-pays the full prefill on long conversations.

## Memory & Deployment

> Measurements reproduced from [issue #20](https://github.com/MAXeaglet/commandcode-proxy/issues/20) (Node v24, loopback mock upstream).

Rule of thumb for per-request memory:

```
RSS ≈ 70 MB + in-flight × (0.13 MB + 5.5 × body_MB)
```

### Streaming responses apply backpressure

When `res.write()` returns `false` (the socket write buffer passed `highWaterMark`), reading from upstream pauses, so the response no longer accumulates unbounded in memory:

| Scenario (200 MB upstream stream, client stops reading after sending) | Peak RSS delta |
|---|---|
| Before the fix | **+586 MB** (66 → 652 MB) |
| After the fix | **+4 MB** (backpressure propagates upstream, which stalls after ~8 MB) |

This is not only a hostile-client problem — throttled/mobile links, a client blocked on tool execution, or a client that already gave up but whose TCP stack has not sent RST all trigger it.

### Request body is ~5.5× its size

The body exists in several copies before being forwarded: `chunks[]` / `Buffer.concat` / utf8 string / `JSON.parse` object tree / `buildCcRequest` second object tree / `JSON.stringify` serialized body.

| body | cap | peak delta | status |
|---|---|---|---|
| 7 MB | 100 MB | +52 MB (7.4×) | 200 |
| 20 MB | 100 MB | +116 MB (5.8×) | 200 |
| 20 MB | 8 MB | +21 MB (1.05×) | **413** |

At startup a `warn` is logged when the implied worst case is ≥ 500 MB. The limit is **per request** and the proxy does no in-flight limiting of its own — a public deployment must add both at the reverse proxy.

### Suggested nginx front

Rejecting in nginx means the body is never materialized in the Node process at all:

```nginx
map $http_authorization $cc_key { default $http_authorization; "" $http_x_api_key; }
map "" $cc_global_key { default "global"; }

limit_conn_zone $binary_remote_addr zone=cc_ip:10m;
limit_conn_zone $cc_key             zone=cc_key:10m;
limit_conn_zone $cc_global_key      zone=cc_global:10m;

location /v1/ {
    client_max_body_size 4m;   # must be <= CC_MAX_BODY_MB
    limit_conn cc_ip     8;
    limit_conn cc_key    4;
    limit_conn cc_global 32;   # this *is* the memory ceiling
    limit_conn_status 429;
    proxy_pass http://127.0.0.1:3050;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 300s;   # must exceed the 30s stream idle timeout
}
```

### Stalled clients (neither reading nor disconnecting)

Once backpressure is in effect, a client that **neither reads nor disconnects** keeps its request and upstream connection alive indefinitely. Measured residual cost:

| Stalled connections | RSS delta | Upstream connections held |
|---|---|---|
| 1 | +5 MB | 1 |
| 10 | +45 MB | 10 |
| 50 | +248 MB | 50 (**held forever**) |

The cost is **bounded, does not leak, and is reclaimed as soon as the client disconnects** (the RSS curve stays flat) — but the **number of connections itself is unbounded**.

This is left unhandled by default, because a stalled client is indistinguishable at the protocol level from a *legitimate* client blocked on tool execution, and the official CLI has no upstream idle timeout at all (see [#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)) — adding an aggressive timeout would repeat the mistake of killing healthy requests.

To cap it, opt in:

```bash
# only drop a client that has been blocked downstream for over 60s;
# a client that keeps making drain progress never triggers this
CC_CLIENT_DRAIN_TIMEOUT_MS=60000 npm start
```

Measured with the timeout enabled (50 stalled connections): upstream connections held goes from **50 (forever) → 0**, with **no** post-drop draining of upstream.

A more robust cap still belongs at the reverse proxy (`limit_conn`), since only it knows how much concurrency a given deployment can afford.

### Other notes

- **`logFile` uses `appendFileSync`** — synchronous writes on the event loop. Under public load they serialize the loop; prefer leaving it empty and collecting stdout.
- **systemd guard rails**: set `MemoryMax=` and `NODE_OPTIONS=--max-old-space-size=` so an overshoot kills the proxy, not `sshd`/`nginx`.
- **Multi-account + multiple instances**: `sessionStore` / `keyStateStore` are per-process `Map`s, so the same API key served by two instances gets two different sessions and **two different device fingerprints** — upstream sees one account on multiple machines. Scale with consistent hashing on the API key (`hash $cc_key consistent`), not round-robin.

For container deployments, mount `/root/.config/commandcode-proxy` and `/root/.commandcode` so gateway keys, model settings, multiple account tokens, and cached quotas survive container recreation.

## License and Credits

Released under the **MIT License**. See [`LICENSE`](LICENSE).

This repository is a derivative work. The copyright notice lists both holders, original first:

```
Copyright (c) 2026 MAXeaglet
Copyright (c) 2026 1deaaa
```

- **Original project** — [`MAXeaglet/commandcode-proxy`](https://github.com/MAXeaglet/commandcode-proxy) by [@MAXeaglet](https://github.com/MAXeaglet). The reverse-proxy core, the Command Code request-protocol implementation (including device-fingerprint and lifecycle pre-requests), and the original documentation are that author's work, and this repository retains the upstream Git history.
- **This fork** — [`1deaaa/cmdgo2api`](https://github.com/1deaaa/cmdgo2api) by [@1deaaa](https://github.com/1deaaa). Contributions here: the Web console and admin API, multi-account token storage with one-click switching, per-account five-hour / weekly / total quota display, runtime update-and-restart management, the remote authorization-helper bridge, and the related deployment adaptations and documentation.

If you redistribute this project or a modified version of it, keep the `LICENSE` file intact with **both** copyright lines. Removing the upstream notice would breach the MIT terms, which require the original copyright and permission notice to be included in all copies or substantial portions of the Software. Adding your own copyright line on top of the existing one — as done here — is the normal convention for a derivative work and does not weaken anyone's rights.

Command Code and its services belong to their respective rights holders; this is not official Command Code software.

## Disclaimer

This project is for **educational and research purposes** only.

- **Unofficial**: This project is not affiliated with Command Code in any way; the Web console is an original management interface added by this repository.
- **Personal Use**: Users assume all responsibility. Please comply with the [Command Code Terms of Service](https://commandcode.ai/tos).
- **API Key**: This project does not collect, upload, or leak your credentials. Gateway keys are used only for local proxy authentication; the upstream account token is sent only to the configured Command Code API address. Protect runtime files yourself; full keys are not written to logs.
- **Compliance**: The protocol is based on passive observation of local CLI network traffic. No unauthorized access, cracking, or tampering of the server has been performed.
- **Account Risk**: Keep usage frequency consistent with normal CLI usage. Extremely high concurrent calls may trigger risk controls.

---

## Development

```bash
npm run web:dev   # Frontend dev server
npm run dev       # Proxy (node --watch auto-restart)
```
