# cmdgo2api

> [English Docs](README.md)

将 Command Code API 转换为 OpenAI / Anthropic 兼容接口的反代代理，并附带用于管理多账号的 Web 控制台。核心代理保持单文件结构；Web 控制台作为独立的管理层提供。

> **衍生作品声明**：`cmdgo2api` 是 [`MAXeaglet/commandcode-proxy`](https://github.com/MAXeaglet/commandcode-proxy)（MIT License）的独立延续分支。详见[许可与致谢](#许可与致谢)。

基于对官方 CLI 网络流量的分析，精确还原了 Command Code API 的请求协议（含设备指纹与生命周期预请求），并实现了多层兼容适配。

**完整功能**：OpenAI Chat Completions + Anthropic Messages API | 流式/非流式输出 | 工具调用 (tool_use) | 多模态图片输入 | 推理强度 (reasoning_effort) | 上游动态模型目录 | 控制台模型白名单 | 多网关密钥 | 多账号 token 暂存与一键切换 | 每个账号显示 5 小时/一周/总额度剩余 | 公网控制台 Cookie 登录 | Command Code 浏览器授权 | 用量每分钟异步刷新 | 项目自动更新并重启 | 缓存命中指标 | 设备指纹伪装（per-key 绑定、自动刷新）| `x-api-key` 鉴权（Anthropic SDK）| 客户端断连检测（上游中止） | 零输出 → 429 自动重试 | 连续超时 → 429 自动重试 | 隐私保护日志

**社区**: [Linux.do](https://linux.do) — 一个友好的中文技术社区。

## 快速开始

```bash
npm run build    # 安装并构建前端控制台
npm start        # 启动，监听 http://0.0.0.0:3050
```

打开 `http://127.0.0.1:3050/console`。首次没有网关密钥时，控制台会要求设置第一个密钥；设置完成后它既是公网控制台登录密码，也是第一个代理访问密钥。通过本机地址访问时，点击“添加账号”会使用 Command Code 官方浏览器授权；通过公网 HTTPS 域名访问时，控制台会生成一次性授权助手命令，在可信本地电脑运行后自动完成回调和账号添加，不需要获取或粘贴 `usertoken`。

配置了网关密钥后，API 请求通过 `Authorization: Bearer <网关密钥>` 传入（Anthropic SDK 可用 `x-api-key`）。没有配置网关密钥时，仍兼容直接传入 `user_` 开头的上游 API Key：

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer <网关密钥>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## 快速部署

### 源码部署

需要 Node.js 18 或更高版本。首次部署执行一次前端依赖安装和构建，之后直接启动代理：

```bash
git clone https://github.com/1deaaa/cmdgo2api.git
cd cmdgo2api
npm run build    # 安装并构建前端控制台
npm start
```

启动后访问 `http://127.0.0.1:3050/console`，设置网关密钥，再点击“添加账号”。本地访问可直接完成官方浏览器授权；远程访问请使用 HTTPS，控制台会显示适用于当前系统的授权助手命令。复制并在自己的电脑运行该命令，助手会在本机打开官方授权页、接收 `127.0.0.1` 回调，再通过 HTTPS 将授权结果提交到远程代理。账号 token、网关密钥和额度快照会保存在运行环境中，升级或重建容器时应保留对应数据目录。

### Docker Compose

```bash
docker compose up -d --build
docker compose logs -f proxy
```

默认访问端口为 `3050`，可通过 `PROXY_PORT=13050 docker compose up -d --build` 修改主机端口。Compose 已挂载运行时目录和账号目录，停止容器后重新启动不会丢失已保存账号。

## 文件结构

```
cmdgo2api/
├── config.json           # 端口 / 日志路径等
├── LICENSE               # MIT License（上游 + 本分支）
├── package.json          # npm start / npm run build / npm run dev
├── proxy.mjs             # 单文件核心代理（~1900 行）
├── web/                  # Web 控制台、管理 API 和前端构建工程
├── tools/                # 远程授权助手
├── Dockerfile            # 容器构建文件（node:22-alpine）
├── docker-compose.yml    # 容器编排
├── .dockerignore         # 构建上下文排除规则
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # 打 v* tag 时自动发布 GHCR 多架构镜像
├── captured-requests/    # CLI 抓包数据（协议逆向参考；仅本地保留，已被 git 忽略，不随仓库分发）
├── README.md             # 英文文档
└── README_zh.md          # 本文档（中文）
```

## 配置

### config.json

| 字段                       | 默认值                         | 说明                                                                |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `port`                   | `3000`                       | 监听端口（仓库自带 config.json 为 3050）                            |
| `host`                   | `0.0.0.0`                    | 监听地址                                                            |
| `publicUrl`              | `""`                         | 旧版公网回调配置；仅保留兼容，不能绕过上游只允许本机回调的限制      |
| `apiBase`                | `https://api.commandcode.ai` | CC API 地址                                                         |
| `projectSlug`            | `cc-proxy`                   | `x-project-slug` header                                           |
| `apiKey`                 | `""`                         | 可选兜底 API Key（请求也可通过 header 传入）                        |
| `gatewayApiKey`          | `""`                         | 兼容旧配置的单个网关密钥；推荐通过 Web 控制台管理多个密钥           |
| `gatewayApiKeys`         | `[]`                         | 可选网关密钥数组；第一个密钥也是控制台密码                          |
| `allowedModelIds`        | `null`                       | 可选模型白名单；`null` 表示允许全部模型，控制台设置会写入运行目录 |
| `logFile`                | `""`                         | 日志文件路径（空=仅控制台）                                         |
| `logLevel`               | `info`                       | 日志级别                                                            |
| `useProviderModels`      | `true`                       | 从 Provider API 动态拉取模型列表                                    |
| `modelRefreshIntervalMs` | `300000`                     | 模型列表缓存刷新间隔（5min）                                        |
| `zdr`                    | `false`                      | 请求 Command Code 使用 ZDR-only 路由                                |

### 环境变量

| 变量                       | 对应 config 字段                                |
| -------------------------- | ----------------------------------------------- |
| `PORT`                   | `port`                                        |
| `HOST`                   | `host`                                        |
| `CC_PUBLIC_URL`          | `publicUrl`；旧版兼容配置，不用于远程账号授权 |
| `CONSOLE_PUBLIC_URL`     | `publicUrl`；`CC_PUBLIC_URL` 的兼容别名     |
| `CC_API_BASE`            | `apiBase`                                     |
| `PROJECT_SLUG`           | `projectSlug`                                 |
| `GATEWAY_API_KEY`        | `gatewayApiKey`                               |
| `GATEWAY_API_KEYS_JSON`  | `gatewayApiKeys`（高级用法）                  |
| `CC_API_KEY`             | Command Code 上游 API Key                       |
| `LOG_FILE`               | `logFile`                                     |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels`                           |
| `CC_STREAM_IDLE_MS`      | 流式上游读空闲超时（默认 `30000`）           |
| `CC_NONSTREAM_IDLE_MS`   | 非流式上游读空闲超时（默认 `90000`）         |
| `CC_MAX_INFLIGHT`        | 进程内在途请求上限（默认 `0` = 不限）        |
| `CMD_ZDR`                | `zdr`（`1` 开启）                           |

开启后，代理会在 Command Code 生成请求以及 fingerprint/lifecycle 初始化请求中附加
`x-cmd-zdr: 1`。npm 版本检查和代理自己的 `/provider/v1/models` 模型目录请求不会附加该
header。该开关只是请求 Command Code 使用 ZDR-only 路由，实际数据留存和上游可用性仍由上游服务决定。

**请求体上限**：独立于 `config.json` —— 超过 **100MB** 的请求会被拒绝并返回 `HTTP 413`（连接保持可排空，不会直接 reset）。可用 `CC_MAX_BODY_MB`（正整数，单位 MB）覆盖。

> ⚠️ **内存放大**：请求体在转发到上游前会存在多份副本，实测峰值 ≈ body 大小 × **5.1~7.4**（7MB→+52MB、20MB→+116MB；被 `413` 拒绝的请求只要 ×1.05）。因此默认 `CC_MAX_BODY_MB=100` 意味着**单个请求**最坏可吃 ~550MB，且该上限是每请求的、不是全局的。详见[内存与部署](#内存与部署)。

配置网关密钥后，客户端使用任意一个网关密钥访问本代理，代理使用 `CC_API_KEY` 访问 Command Code；两者是不同的密钥。未配置网关密钥时，仍兼容客户端直接传入 `user_...` 上游密钥。

### Web 控制台

控制台地址为 `/console`，管理接口位于 `/admin/api`。控制台默认只开放首次设置、登录和服务状态接口；完成首次设置后，密钥、用量、模型权限、重启和更新操作都需要登录 Cookie。

- 第一个网关密钥用于公网控制台登录；删除第一个密钥后，下一个密钥会提升为新的登录密码。
- 可以添加多个网关密钥，也可以删除任意密钥；删除最后一个密钥后会回到首次设置页面。
- 可通过“浏览器登录”暂存多个 Command Code 账号 token，账号列表支持一键切换、删除和刷新全部账号用量；每个账号右侧只显示 5 小时、一周、总额度的剩余值。切换账号会立即更新代理使用的上游 token，不需要重启。
- 当前账号的 5 小时、一周或本月额度任一达到 100% 时，如果列表中存在三类额度都未满且数据完整的账号，会按列表顺序自动切换到后续可用账号；到达列表末尾后会从头循环查找，额度未知或同步失败的账号不会被选中。
- 模型设置会从上游 Provider API 拉取完整目录。默认全部允许；取消选择并保存后，`/v1/models` 会隐藏对应模型，实际请求返回 `HTTP 403`。
- 用量在控制台存活期间每 60 秒后台异步刷新一次。
- “更新项目并重启”只在 Git 工作树干净时执行 `git pull --ff-only`、前端安装和构建；检测到本地改动会停止，不会覆盖文件。
- 本地控制台（`127.0.0.1`、`localhost` 或 `::1`）使用官方浏览器授权和本地回调。远程控制台不会伪造公网回调，因为 Command Code 官方明确只接受本机回调；点击“添加账号”后会生成有效期约 10 分钟的一次性授权助手命令。命令在可信本地电脑运行，助手临时监听本机回环地址接收官方回调，并通过 HTTPS 将结果交给远程控制台，页面不会显示或要求粘贴上游 token。一次性票据只以哈希形式保存在服务端，完成后立即失效。也可以通过 SSH 端口转发访问本机控制台，以保留完整浏览器授权流程。
- 每次点击“添加账号”都会请求官方重新登录，避免静默复用浏览器中已登录的账号。如果授权页仍显示旧账号，请先退出 Command Code，或用浏览器隐私窗口重新打开授权页。

运行时敏感文件位于 `~/.config/commandcode-proxy/credentials.env`，模型设置位于同目录的 `settings.json`，多账号 token 与额度快照位于同目录的 `accounts.json`，当前账号兼容写入 `~/.commandcode/auth.json`。程序会以当前用户权限保存这些文件，升级时会自动迁移旧版单账号 `auth.json`，建议不要将它们加入 Git 或复制到公开目录。

## API 接口

### `POST /v1/chat/completions`

OpenAI Chat Completions 兼容。支持流式和非流式、工具调用、多模态图片输入、推理强度。

**请求体参数：**

| 参数                    | 必填 | 说明                                              |
| ----------------------- | ---- | ------------------------------------------------- |
| `model`               | 是   | 模型 ID（见模型列表）                             |
| `messages`            | 是   | 对话消息，支持`system/user/assistant/tool` 角色 |
| `max_tokens`          | 否   | 最大生成 token（默认 64000）                      |
| `stream`              | 否   | 是否 SSE 流式（默认 false）                       |
| `temperature`         | 否   | 采样温度（0-2）                                   |
| `reasoning_effort`    | 否   | 推理强度`low`/`medium`/`high`/`max`       |
| `tools`               | 否   | 工具定义（OpenAI function calling 格式）          |
| `tool_choice`         | 否   | 工具选择策略                                      |
| `parallel_tool_calls` | 否   | 是否允许并行工具调用                              |

**简单请求：**

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

**多模态图片输入（需 vision 模型）：**

```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "描述这张图片" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**工具调用：**

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

**流式响应（SSE）：**

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"思考过程"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":8}}}

data: [DONE]
```

**非流式响应（含缓存命中）：**

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

Anthropic Messages API 兼容端点。支持流式和非流式、工具调用。

**请求体：**

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "你是一个有用的助手。",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

**Anthropic 协议差异（自动转换）：**

| 概念            | Anthropic 原始格式                            | 转换说明                                                                     |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| System prompt   | 顶层`system` 字段                           | 自动转为 OpenAI`system` message                                            |
| 消息内容        | `content` 数组（text/tool_use/tool_result） | 自动映射为对应角色                                                           |
| 工具结果        | `user` 消息中的 `tool_result` 块          | 自动转为`role: "tool"`                                                     |
| 工具定义        | `input_schema`                              | 自动映射为`parameters`                                                     |
| `tool_choice` | `{type:"auto"/"any"/"tool"}`                | `any`→`required`，`tool`→function 对象                               |
| 推理强度        | `thinking.budget_tokens`                    | 自动映射为`reasoning_effort`（≥10000→high, ≥5000→medium, ≥2000→low） |
| 停止原因        | `end_turn`/`max_tokens`/`tool_use`      | 自动映射为`stop`/`length`/`tool_calls`                                 |
| Token 用量      | `input_tokens`/`output_tokens` + 缓存     | 透传，缓存字段映射为 Anthropic 格式                                          |

**流式响应（SSE，Anthropic 格式）：**

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

**非流式响应：**

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

返回可用模型列表。优先从 Provider API 动态拉取（5min 缓存），失败回退硬编码列表。

### `GET /health`

健康检查。返回 `OK`。

## 错误码

| HTTP 状态 | 说明                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| 400       | 请求格式错误                                                                                                              |
| 401       | API Key 缺失/格式不对/无效（Key 必须以`user_` 开头；通过 `Authorization: Bearer` 或 `x-api-key` 传入）              |
| 429       | 零输出 token，或流空闲超时（30s 流式 / 90s 非流式）——带`Retry-After`，SDK 自动重试；连续 3 次超时返回"压缩上下文"提示 |
| 502       | CC 上游错误                                                                                                               |

## 模型列表

代理访问 `GET /v1/models` 会返回实时模型列表。以下为常见模型参考，完整列表以实际接口返回为准——各模型套餐可参考 [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits)。

### 常用模型

| 模型 ID                                                                                           | 提供商                           |
| ------------------------------------------------------------------------------------------------- | -------------------------------- |
| `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-opus-4-7` / `claude-haiku-4-5-20251001` | Anthropic                        |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex`                                  | OpenAI                           |
| `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash`                                     | DeepSeek                         |
| `moonshotai/Kimi-K2.6` / `moonshotai/Kimi-K2.5`                                               | Kimi                             |
| `zai-org/GLM-5.1` / `zai-org/GLM-5`                                                           | GLM                              |
| `MiniMaxAI/MiniMax-M3` / `MiniMaxAI/MiniMax-M2.7` / `MiniMaxAI/MiniMax-M2.5`                | MiniMax                          |
| `Qwen/Qwen3.7-Max` / `Qwen/Qwen3.6-Max-Preview` / `Qwen/Qwen3.6-Plus`                       | Qwen                             |
| `stepfun/Step-3.7-Flash` / `stepfun/Step-3.5-Flash`                                           | Step                             |
| `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5`                                                   | Xiaomi（**支持图片输入**） |
| `google/gemini-3.5-flash` / `google/gemini-3.1-flash-lite`                                    | Gemini                           |

> ⚠️ 部分模型（如 `deepseek-v4-flash`、`claude-sonnet-4-6`）不支持图片输入。如需多模态请用 `xiaomi/mimo-v2.5`、`Kimi-K2.5` 等 vision 模型。

## 接入示例

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
  -H "Authorization: Bearer <网关密钥>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

### Cursor

在 Cursor 设置中添加 Custom Provider：

- **API Base URL**: `http://127.0.0.1:3050/v1`
- **API Key**: `<网关密钥>`
- **Model**: 从模型列表中选择

### Anthropic (Python SDK)

```python
import anthropic

client = anthropic.Anthropic(
    api_key="<网关密钥>",
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

Anthropic SDK 通过 `x-api-key` 头鉴权——代理已原生支持（无需 `Authorization` 头）。

### OpenCode

```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "<网关密钥>"
}
```

## 反检测

基于对官方 CLI 网络流量的分析（版本号从 npm registry 动态拉取），实现了以下兼容适配：

| 机制                        | 实现                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **设备指纹**          | 每个 Key 首次请求前发送`POST /alpha/fingerprint/record`；随机指纹池（15 种 CPU、全球时区）、SHA-256 哈希、per-key 绑定，每 8h+2h 抖动刷新 |
| **生命周期声明**      | 会话初始化时与指纹并行发送`POST /alpha/lifecycle-events`（`cli_session_exists`）                                                        |
| **按 Key 分 Session** | 每个 API Key 独立 session，12h 过期 + 1h 随机抖动                                                                                           |
| **动态版本号**        | `x-command-code-version` 从 npm registry 自动拉取（24h 刷新）                                                                             |
| **CLI 信封格式**      | config/memory/taste/skills/permissionMode/params                                                                                            |
| **OpenTelemetry**     | `traceparent` (W3C Trace Context)                                                                                                         |
| **环境标识**          | `x-cli-environment: production`、`x-co-flag: "false"`、`x-taste-learning: "false"`                                                    |
| **Project Slug**      | 从 sessionId 生成的`x-project-slug`（与真实 CLI 格式一致）                                                                                |
| **思考强度**          | `reasoning_effort` 透传 (low/medium/high/max)                                                                                             |
| **API Key 格式验证**  | 对`Authorization: Bearer` 或 `x-api-key` 用正则 `user_[a-zA-Z0-9_-]+` 提取，自动清理多余路径/前缀，`sk-xxx` 等非 `user_` 格式拒   |
| **流式超时保护**      | 流式 30s、非流式 90s → 429 + SDK 自动重试                                                                                                  |
| **连续超时阈值**      | 连续 3 次超时后才提示压缩上下文                                                                                                             |
| **零输出防护**        | outputTokens=0 → 429`rate_limit_error`（SDK 自动重试，反异常计费）                                                                       |
| **上游中止**          | 客户端断连 + 全部错误路径`AbortController` 打断 CC                                                                                        |
| **隐私保护日志**      | 日志不含 API Key 片段、错误 body、stack trace                                                                                               |

## 协议细节

### CC API 请求体结构

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

条件字段：`system`（从 system 消息提取）、`temperature`、`reasoning_effort`、`tools`（映射为 CC `input_schema` 格式）。

### CC API 图片消息格式

CLI 发送图片的格式：

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "data:image/jpeg;base64,..." },
    { "type": "text", "text": "图里写了什么" }
  ]
}
```

代理收到 OpenAI `image_url` 格式后自动转为上述 CC 格式透传。

## Docker 部署

### 从 GHCR 拉取

每次打 `v*` tag 时 GitHub Actions 会自动构建并推送多架构镜像（`linux/amd64` + `linux/arm64`）到 GitHub Container Registry：

```bash
docker pull ghcr.io/1deaaa/cmdgo2api:latest
docker run -d --name cmdgo2api -p 3050:3050 \
  -e PORT=3050 \
  -v cc-proxy-runtime:/root/.config/commandcode-proxy \
  -v cc-proxy-auth:/root/.commandcode \
  ghcr.io/1deaaa/cmdgo2api:latest
```

每次发版都会更新 `latest` 标签。镜像为公共可见，拉取无需登录。

> 本仓库目前还没有 release tag，上面的镜像会在第一次推送 `v*` tag 时生成（`.github/workflows/docker-publish.yml` 也支持推送 `release` 分支或手动触发）。在此之前请使用 `docker compose up -d --build` 或本地构建镜像。

> 上游另外发布了 `ghcr.io/maxeaglet/commandcode-proxy`。那个镜像是**未经修改的上游构建**，不包含 Web 控制台、多账号切换和远程授权助手等功能。要使用本分支的功能，请拉取上面的镜像或自行从源码构建。

### 快速启动 (docker compose)

```bash
docker compose build
docker compose up -d
```

代理将在 `http://0.0.0.0:3050` 监听并提供 `/console`。首次启动后访问控制台设置网关密钥。通过公网域名访问时，点击“添加账号”使用 HTTPS 授权助手流程；通过本机地址访问时使用官方浏览器授权。

```bash
docker compose up -d --build
```

通过 `PROXY_PORT` 自定义主机端口：

```bash
PROXY_PORT=13050 docker compose up -d
```

### 从源码构建

```bash
npm run build
docker build -t commandcode-proxy:latest .
docker run -d -p 3050:3050 -e PORT=3050 commandcode-proxy:latest
```

### 多架构构建

```bash
npm run docker:build:multi
```

### 环境变量

| 变量                         | 默认值     | 说明                                                                     |
| ---------------------------- | ---------- | ------------------------------------------------------------------------ |
| `PORT`                     | `3050`   | 容器内监听端口                                                           |
| `PROXY_PORT`               | `3050`   | 主机映射端口（仅 compose）                                               |
| `CC_PUBLIC_URL`            | 空         | 旧版公网回调配置，仅保留兼容；不能绕过 Command Code 只允许本机回调的限制 |
| `CC_MAX_BODY_MB`           | `100`    | 请求体大小上限（MB），超限请求返回 `HTTP 413`                            |
| `CC_CLIENT_DRAIN_TIMEOUT_MS` | 空（禁用） | 下游背压阻塞超过该毫秒数则断开该客户端并中止上游请求，见[僵死连接](#僵死连接既不读也不断开) |
| `CC_STREAM_IDLE_MS`        | `30000`  | 流式上游读空闲超时（毫秒），见[上游空闲超时](#上游空闲超时)              |
| `CC_NONSTREAM_IDLE_MS`     | `90000`  | 非流式上游读空闲超时（毫秒）                                             |
| `CC_MAX_INFLIGHT`          | `0`（不限）| 进程内在途请求上限，超限返回 `503` + `Retry-After`，见[在途上限](#在途请求上限可选) |

容器部署建议挂载 `/root/.config/commandcode-proxy` 和 `/root/.commandcode`，否则容器删除后会丢失网关密钥、模型权限、多账号 token 和额度快照。

## 在途请求上限（可选）

**默认关闭**（`CC_MAX_INFLIGHT` 未设置 = 不限制并发），既有行为不变。

本项目定位是**纯反代层**，并发控制属于下游 —— 按 IP / 按 key 的限流请用反向代理（见[内存与部署](#内存与部署)里的 `limit_conn`）。
本项**不是**那套方案的替代品，只为「不挂反代裸跑」（Dockerfile 与 `npm start` 都支持这种用法）提供一个**进程内、仅全局**的兜底：

```bash
CC_MAX_INFLIGHT=32 npm start    # 最多同时处理 32 个请求
```

超限时快速返回 `503` + `Retry-After: 5` + `type: server_busy` —— OpenAI / Anthropic 官方 SDK 认得这个组合会自动退避重试，而不是拿到连接被重置。`/health` 与 `/` 不计入、也不受限制，避免探活与编排器因业务繁忙收到 503。

**为什么需要它**：内存 = `在途数 × (0.13MB + 5.5 × body_MB)`。`CC_MAX_BODY_MB` 只管住**单请求**量级，乘数无人管 —— 默认 100MB 时 N 个并发最坏可达 N × 550MB。

> ⚠️ 开启本项**不等于**内存安全：32 × 550MB 仍远超小机器容量。要拿到硬性上界，需**同时**下调 `CC_MAX_BODY_MB`。

## 上游空闲超时

两个上游读空闲看门狗，超时后返回 `429`（带 `retry_after`）让 SDK 自动重试：

| 环境变量 | 默认 | 作用于 |
|---|---|---|
| `CC_STREAM_IDLE_MS` | `30000` | 流式请求 |
| `CC_NONSTREAM_IDLE_MS` | `90000` | 非流式请求 |

**语义**：只计「`reader.read()` 的等待时间」，每收到一个 chunk 就重置 —— **不是整个请求的总时长**。
只要上游在持续吐流就不会触发，哪怕单个请求已经跑了几十分钟。

**默认值与官方 CLI 不一致，这是已知取舍**（[#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)）：
官方 CLI 对上游**没有任何** idle timeout —— 反编译 `command-code@1.50.0` 可见所有 `createApiClient({ baseUrl })` 调用点都未传 `timeout`，实测 700+ 秒的停顿可正常完成。
本代理保留 30s 是为了兜住真正死掉的连接；代价是**推理模型的长思考停顿可能被误杀**。

若遇到「`429 Response timeout`」「`zero output tokens`」且日志里 `elapsedMs ≈ 30000`、`bytesReceived = 0`，
说明是看门狗误杀了 prefill / 首 token 阶段的正常停顿 —— 调大即可：

```bash
CC_STREAM_IDLE_MS=300000 npm start      # 5 分钟
```

> ⚠️ 误杀的成本不止一次失败：被 abort 后返回 `429 + retry_after`，SDK 会自动重试，
> 而重试等于**完整重发整个上下文**，长会话下每次误杀都要重付一次全量 prefill。

## 内存与部署

> 数据来自 [issue #20](https://github.com/MAXeaglet/commandcode-proxy/issues/20) 的实测复现（Node v24，loopback mock 上游）。

单请求内存开销的经验公式：

```
RSS ≈ 70 MB + 在途请求数 × (0.13 MB + 5.5 × body_MB)
```

### 流式响应已做背压

`res.write()` 返回 `false`（socket 写缓冲超过 `highWaterMark`）时会暂停读取上游，响应不再在内存中无界堆积：

| 场景（200MB 上游流，客户端发完请求即停止读取） | 峰值 RSS 增量 |
|---|---|
| 修复前 | **+586 MB**（66 → 652 MB）|
| 修复后 | **+4 MB**（背压一路传回上游，上游只吐出 ~8MB 即停住）|

这不只是恶意客户端问题 —— 弱网/移动端、客户端卡在工具执行、客户端已放弃但 TCP 还没发 RST，都会触发。

### 请求体放大 ~5.5×

body 在转发到上游前同时存在多份副本：`chunks[]` / `Buffer.concat` / utf8 字符串 / `JSON.parse` 对象树 / `buildCcRequest` 重建对象树 / `JSON.stringify` 序列化体。

| body | 上限 | 峰值增量 | 结果 |
|---|---|---|---|
| 7 MB | 100 MB | +52 MB（7.4×）| 200 |
| 20 MB | 100 MB | +116 MB（5.8×）| 200 |
| 20 MB | 8 MB | +21 MB（1.05×）| **413** |

启动时若隐含最坏峰值 ≥ 500MB，日志会输出 `warn` 提示。上限是**按请求**的，proxy 自身没有在途限流 —— 公网部署必须在反向代理层补上。

### nginx 反代建议

`client_max_body_size` 在 nginx 拒绝时，body 根本不会进入 Node 进程：

```nginx
map $http_authorization $cc_key { default $http_authorization; "" $http_x_api_key; }
map "" $cc_global_key { default "global"; }

limit_conn_zone $binary_remote_addr zone=cc_ip:10m;
limit_conn_zone $cc_key             zone=cc_key:10m;
limit_conn_zone $cc_global_key      zone=cc_global:10m;

location /v1/ {
    client_max_body_size 4m;   # 需 <= CC_MAX_BODY_MB
    limit_conn cc_ip     8;
    limit_conn cc_key    4;
    limit_conn cc_global 32;   # 这一项就是内存天花板
    limit_conn_status 429;
    proxy_pass http://127.0.0.1:3050;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 300s;   # 需大于 30s 的流空闲超时
}
```

### 僵死连接（既不读也不断开）

背压生效后，客户端**既不读也不断开**时该请求会连带上游连接一直挂着。实测残留在途成本：

| 僵死连接数 | RSS 增量 | 上游连接持有 |
|---|---|---|
| 1 | +5 MB | 1 |
| 10 | +45 MB | 10 |
| 50 | +248 MB | 50（**永久持有**）|

特性是**有界、不泄漏、客户端断开即回收**（RSS 曲线完全持平），但**连接数本身无上限**。

默认**不处理**，因为僵死客户端与「卡在工具执行的合法客户端」在协议层无法区分；且官方 CLI 对上游没有任何 idle timeout（见 [#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)），贸然加超时会重蹈「误杀健康请求」。

需要封顶时启用（opt-in）：

```bash
# 下游持续阻塞超过 60s 才断开，正常客户端只要在推进 drain 就不会触发
CC_CLIENT_DRAIN_TIMEOUT_MS=60000 npm start
```

启用后实测（50 个僵死连接）：上游连接持有数由 **50（永久）→ 0**，且丢弃后**不会**继续抽干上游。

更稳妥的封顶仍在反向代理层（`limit_conn`），因为只有它知道该部署能承受多少并发。

### 其它注意事项

- **`logFile` 是同步写**（`appendFileSync`），公网负载下会阻塞事件循环 —— 建议保持留空，从 stdout 收集。
- **systemd 兜底**：配 `MemoryMax=` 与 `NODE_OPTIONS=--max-old-space-size=`，让超限杀掉 proxy 而不是 `sshd`/`nginx`。
- **多账号 + 多实例**：`sessionStore` / `keyStateStore` 是进程内 `Map`。同一个 API key 打到两个实例会得到两个不同 session 与**两个不同设备指纹**，上游会看到「一个账号在多台机器上」。横向扩展请按 API key 做一致性哈希（`hash $cc_key consistent`），不要轮询。
## 许可与致谢

本项目以 **MIT License** 发布，详见 [`LICENSE`](LICENSE)。

本仓库是衍生作品，版权声明按「原作者在前、本分支在后」的顺序并列两位持有人：

```
Copyright (c) 2026 MAXeaglet
Copyright (c) 2026 1deaaa
```

- **原项目** —— [`MAXeaglet/commandcode-proxy`](https://github.com/MAXeaglet/commandcode-proxy)，作者 [@MAXeaglet](https://github.com/MAXeaglet)。反代核心、Command Code 请求协议实现（含设备指纹与生命周期预请求）和原始文档均出自该作者，本仓库保留了上游的 Git 提交历史。
- **本分支** —— [`1deaaa/cmdgo2api`](https://github.com/1deaaa/cmdgo2api)，作者 [@1deaaa](https://github.com/1deaaa)。本仓库新增的内容包括：Web 控制台与管理 API、多账号 token 暂存与一键切换、每账号 5 小时 / 一周 / 总额度展示、运行时更新重启管理、远程授权助手桥接，以及配套的部署适配与文档。

如果你分发本项目或其修改版本，请完整保留 `LICENSE` 文件以及其中的**两行**版权声明。删除上游声明会违反 MIT 条款——该条款要求在所有副本或实质性部分中保留原始版权与许可声明。在原有声明之上追加自己的版权行（即本仓库的做法）是衍生作品的通行惯例，不会削弱任何一方的权利。

Command Code 名称、网站和服务属于其各自权利人，本项目不是 Command Code 官方软件，也不代表 Command Code。

## 免责声明

本项目仅供**学习和研究**使用。

- **非官方**：本项目与 Command Code 无任何关联，非官方产品；Web 控制台为本仓库新增的管理界面。
- **个人使用**：使用者应自行承担所有责任。请遵守 [Command Code 服务条款](https://commandcode.ai/tos)。
- **API Key**：本项目不会收集、上传或泄露你的密钥。网关密钥只用于本地鉴权，上游账号 token 只由代理发送到配置的 Command Code API 地址；运行时文件应由部署者自行保护，日志不记录完整密钥。
- **合规性**：协议基于对本地 CLI 网络流量的被动观察，未对服务端进行任何未授权访问、破解或篡改。
- **账号风险**：建议和正常 CLI 使用频率保持一致，超高并发调用可能触发风控。

---

[Linux.do](https://linux.do)

## 开发

```bash
npm run web:dev   # 前端开发服务器
npm run dev       # 代理（node --watch 自动重启）
```
