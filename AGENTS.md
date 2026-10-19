# AGENTS.md — cmdgo2api 维护指南

本文件给在此仓库工作的 AI 代理和开发者提供约定。核心目标：**在不破坏本分支功能的前提下，让每次跟进上游更新时的 merge 成本尽可能低。**

## 项目概览

- 上游项目：`https://github.com/MAXeaglet/commandcode-proxy`（remote: `upstream`）
- 本分支仓库：`https://github.com/1deaaa/cmdgo2api`（remote: `github`），另有私有镜像 `origin`（`git.1dea.top/aidea/cmd2api.git`）
- 技术栈：Node.js（ESM，无打包器）核心代理 `proxy.mjs` + 原生 `http` 服务；Web 控制台为 Vite + React + Tailwind，构建到 `web/dist`（不入库）
- 运行端口：默认 `3050`（`config.json` / `PORT`）
- 控制台入口：`/`（用量概览）、`/log`（调用日志）、`/set`（代理设置）；旧 `/console` 会 302 跳转到 `/`
- 软件维护：从指向 `1deaaa/cmdgo2api` 的 remote 拉取 `main`，无冲突时自动快进/合并，随后 `npm run build` 并重启进程

## 常用命令

```bash
npm start                # 启动代理
npm run dev              # 代理热重启（node --watch）
npm run build            # 安装并构建 Web 控制台（web:install + web:build）
npm run web:dev          # 控制台前端开发服务器
npm test                 # node --test（当前仓库无内置测试用例）
node --check proxy.mjs   # 语法检查
node --check web/admin.mjs
```

本机部署形态（systemd 用户服务）：

```bash
systemctl --user restart commandcode-proxy.service
systemctl --user status commandcode-proxy.service
curl http://127.0.0.1:3050/health
```

服务定义在 `~/.config/systemd/user/commandcode-proxy.service`，启动脚本 `~/.config/commandcode-proxy/start.sh`（会加载 `credentials.env` 并 `cd` 到本仓库）。**项目目录移动后必须同步修改这两处路径。**

## 上游同步流程

```bash
git fetch upstream
git merge upstream/master        # 或 git rebase upstream/master（需评估团队习惯）
npm run build                    # 验证前端仍可构建
node --check proxy.mjs && node --check web/admin.mjs
npm start                        # 起服务，验证 /health、/、/log、/set、登录与代理转发
```

冲突处理原则：

1. 上游文件冲突时，**先接受上游版本，再把本分支改动逐块重新应用**，不要整段保留旧实现。
2. `proxy.mjs` 的冲突重点看下一节的「改动清单」，确保所有 fork 触点都还在。
3. merge 后必须实际启动一次服务并验证控制台可打开、账号可切换、LLM 请求可转发。

## 文件归属与修改原则

### 上游文件（尽量少改、改则集中）

`proxy.mjs`、`package.json`、`README.md`、`README_zh.md`、`.gitignore`、`Dockerfile`、`docker-compose.yml`、`config.json`、`LICENSE`

- **禁止**在这些文件里做大面积重构、格式化或无关改动。
- 新增能独立表达的配置/脚本，优先通过 `package.json` 的 `scripts` 收口（例如 `build`、`web:*`），避免在 `proxy.mjs` 里散落多条 npm 命令。
- 每次改动尽量小、成块、加中文注释说明「本分支新增」，便于冲突时识别。

### 本分支新增文件（自由修改）

`web/admin.mjs`、`web/request-log.mjs`、`web/src/**`、`web/package.json`、`web/vite.config.js`、`web/tailwind.config.js`、`web/index.html`、`web/postcss.config.js`、`tools/remote-login.mjs`、`reasoning.mjs`、`test/reasoning.test.mjs`、`test/reasoning-wire.test.mjs`、`AGENTS.md`

- 控制台 UI、管理 API、账号存储、远程授权等高耦合功能**必须**留在这些文件里，不要塞进 `proxy.mjs`。
- `web/dist/` 与 `web/node_modules/` 被 `.gitignore` 忽略，构建产物不入库；部署机需要执行一次 `npm run build`。

### 推理档位映射（本分支新增，改动必须留在 reasoning.mjs）

`reasoning.mjs` 承载 Anthropic 推理参数 → CC `reasoning_effort` 的全部判断：

- 官方 `output_config.effort`（low/medium/high/xhigh/max）优先，兼容顶层 `reasoning_effort`、`reasoning.effort` 与旧客户端的 `thinking.effort`；
- `thinking.type = disabled/none` 尝试下发 `off`（仅模型声明了 off 时），`adaptive`/`between_tools` 无档位时不再硬编码 medium；
- 旧 `thinking.budget_tokens` 按 ≥16000/≥10000/≥5000 阈值推断（保持原有行为）；
- 最终按目标模型声明的档位向上归一（静态表 + `/provider/v1/models` 的 `reasoningEfforts` 运行时覆盖）。

`proxy.mjs` 侧只保留四个触点：import、`buildCcRequest` 里按模型归一、`convertAnthropicToOpenAI` 里一次调用、`fetchModels` 里一次注册。上游若改动这些位置，先接受上游版本，再把这四行重新贴上即可。

### `proxy.mjs` 当前 fork 触点清单（merge 时必须保留）

1. 头部 imports：`child_process`、`os`、`util`、`web/admin.mjs`。
2. `loadConfig()`：`publicUrl`、`ccApiKey`、`gatewayApiKey(s)`、运行时凭证/设置读取、`allowedModelIds`。
3. `getPresentedApiKey()` / `getApiKey()`：网关密钥校验 + `timingSafeEqual`，未配置网关密钥时兼容 `user_...`。
4. `isModelAllowed()` / `sendModelForbidden()`：模型白名单校验（OpenAI 与 Anthropic 两条入口都会调用）。
5. `reportUpstreamQuotaLimit()` 与 `mapCcError()` / `mapCcEventError()`：向上游限额事件注入自动切号钩子；`createSseTranslator()` 多传 `apiKey` 以避免迟到事件误伤新账号。
6. `handleChatCompletions()` / `handleMessages()`：模型白名单拦截。
7. `handleModels()`：网关校验 + 白名单过滤。
8. CORS 允许 `DELETE`；`server` 请求入口接入 `adminController.handle()`。
9. 文件末尾：`closeServer()` / `restartServer()` / `runMaintenanceCommand()` / `updateProject()` / `relaunchProcess()`、`createAdminController(...)`，并注册 `upstreamQuotaLimitHandler` / `requestLogHandler`。
10. 启动日志：网关密钥与 CC key 的配置状态提示。
11. `forwardToCC()`：通过 `web/request-log.mjs` 旁路采集调用日志（`response.clone()`，不改变下发内容），供控制台 `/admin/api/requests` 使用。

### 当前平衡度评估（结论与建议）

- 已经做得好的部分：控制台后端、前端、远程授权、账号存储全部在新增文件；构建命令统一收口到 `package.json`；运行时凭证独立于仓库目录；`.gitignore` 已排除凭证与构建产物。
- 仍存在的 merge 风险：`proxy.mjs` 累计改动约 250 行、分散在 10 个触点，主要在认证、配置加载与进程维护区域。上游若重构这些区域，冲突不可避免。
- 建议的长期优化（非必须，需单独评估与回归测试）：
  1. 把 `getApiKey`/白名单/配置合并逻辑整体搬到 `web/fork-hooks.mjs`，`proxy.mjs` 只保留一行 import 与薄委托；
  2. 把 `closeServer`/`restartServer`/`updateProject`/`relaunchProcess` 搬到 `web/fork-runtime.mjs`，由 `proxy.mjs` 传入 `server`、`CFG`、`log`；
  3. 向上游提 PR，为代理增加官方插件/钩子点（鉴权、错误映射、进程维护），从根上消除冲突。
- 判断标准：当上游文件改动只剩「import + 3~5 个调用点」时，即达到较优平衡；在此之前，保持每处改动小且集中。

## 安全与运行时约定

- 绝不提交任何凭证：`~/.config/commandcode-proxy/credentials.env`、`accounts.json`、`settings.json`、`~/.commandcode/auth.json` 等均在 `.gitignore` 覆盖范围内（仓库内同名文件也禁止提交）。
- 日志中不要输出 API key、token、完整请求头。
- 修改账号自动切换逻辑时，遵守「临时 429 不切号、窗口额度耗尽才切号」的原则，避免误切。
