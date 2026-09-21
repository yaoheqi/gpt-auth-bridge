# GPTAuthBridge

ChatGPT 账号认证与会话管理工具，支持协议登录、多工作区 RT 获取、会话转换、自动测活及 CPA / Sub2API 推送。仓库名与 npm 包名为 `gpt-auth-bridge`；应用使用 Node.js，只有一份根目录 `.env`、一个启动入口和一个 HTTP 端口。

基于 [gtxx3600/GPTSession2CPAandSub2API](https://github.com/gtxx3600/GPTSession2CPAandSub2API) 开发，使用 [MIT 许可证](LICENSE)。原始贡献者与历史整理说明见 [AUTHORS.md](AUTHORS.md)。

## 本地启动

需要 Node.js **22.19.0 或更高版本**、Python、curl_cffi 和 Playwright Chromium。在项目根目录执行：

```powershell
npm ci
python -m pip install -r requirements.txt
python -m playwright install chromium
Copy-Item config.example.env .env
npm start
```

打开 **http://127.0.0.1:4173**。Windows 安装上述依赖后，可双击 `start.bat` 在后台启动，服务就绪后自动打开浏览器；双击 `stop.bat` 关闭当前项目的服务及其 Python/Chromium 子进程。

启动地址沿用 `.env` 和环境变量中的 `HOST`、`PORT`，重复启动会复用已有服务。端口冲突或启动失败时显示提示；启动失败会清理本次进程。启动记录和日志位于被忽略的 `runtime/` 目录（`local-server.json`、`local-server.log`、`local-server.error.log`）。命令行可用 `start.bat -NoBrowser -NoPause` 跳过自动打开页面及出错暂停，`stop.bat -NoPause` 可用于自动化关闭。

- `HOST` 默认 `127.0.0.1`，`PORT` 默认 `4173`。
- `PYTHON` 可指定 Python 路径；默认查找根目录 `.venv`、旧 `login-service/.venv` 和系统 PATH。
- 默认直连，不会隐式使用本机 `127.0.0.1:7890`。服务器级任务仍可显式设置 `OPENAI_PROXY_URL`、`APP_PROXY_POOL` 或 `PROXY_CHAIN_URL`。
- 协议登录页面统一提供“直连”“本地代理”“内置代理池”和“自定义代理池”四种模式；本地代理端口、代理池和模式都保存在当前浏览器，并随请求发送。本地代理默认使用 `127.0.0.1:7890`，可在页面修改端口，因此本地运行和服务器部署使用同一套配置。`OPENAI_BUILT_IN_PROXY_POOL` 仅在页面主动选择内置代理池时使用，代理凭据不下发给浏览器。

## 浏览器保存数据

账号、密码、TOTP、Session、Cookie、个人及工作区 RT、页面输入、协议登录代理池、结果与 Sub2API / CPA 设置仅保存到当前浏览器同源的 IndexedDB。整个工作区使用 AES-GCM-256 加密，每次保存生成新的随机 IV；不可导出的 CryptoKey 也仅保存在该浏览器中。旧版明文工作区首次读取时自动迁移，解密失败不会覆盖原数据。需要 HTTPS 或 localhost；没有加密能力时不会退回明文保存。刷新页面可恢复已完成的结果并继续导出；更换浏览器、设备或站点地址不会自动同步。此加密用于保护本地存储内容，不抵御同源恶意脚本或已被控制的浏览器。

服务器只在单次请求期间临时处理浏览器提交的数据。内部沿用 SQLite 仓库接口，但每个请求独立使用 `:memory:` 数据库，请求结束或断开即释放，不产生数据库、设置文件、账号日志或推送队列。只提交上一次的账号 ID 无法读取数据，调用方必须同时提交自己的 `browserState`。服务器重启不影响已保存在浏览器的结果，进行中的操作需要重新发起。

顶部提供两种清空操作：“清空登录数据”删除账号输入、密码/TOTP、Session/RT、日志及转换和推送结果，保留自定义代理、Sub2API、CPA 配置和导出参数，并重新加密保存；“清空所有数据”同时删除所有浏览器配置和加密密钥。浏览器禁止存储或空间不足时页面会提示，请及时下载。主动下载的文件保存在用户设备；用户主动推送至 Sub2API / CPA 后，数据由目标服务管理。

多个标签页共用同一份浏览器数据。保存使用 IndexedDB 事务校验版本；其他标签页更新数据后，旧页面会停止请求并提示刷新，避免覆盖新结果。清空数据会通知其他标签页刷新，并保留一个不含用户信息的版本计数，防止旧页面重新写回凭据。禁用 BroadcastChannel 的浏览器仍由事务版本校验保护。

批量 SSE 在账号完成时只同步该账号，结束时同步一次完整状态；页面合并短时间内的保存。响应缓冲过大或客户端长时间不读取时，服务会断开请求并释放临时数据。

账号进度按发生变化的账号增量更新，保留日志滚动位置和“阶段耗时”的展开状态。阶段耗时随进度发送并保存到当前浏览器，刷新后仍可查看；持续更新不会重建整个账号列表。

所有任务并发统一由根目录 `.env` 的 **`TASK_CONCURRENCY=10`** 设置（范围 1–30，修改后重启）。协议登录、2FA 重设、测活、退出会话和账号批处理使用同一个全局任务队列；多个请求、浏览器同时操作也不会叠加突破上限。页面只展示服务端配置，旧浏览器设置和 API 请求中的并发值不会覆盖它。Sub2API 的“导出账号并发/每账号并发”是导出 JSON 中各账号的 `concurrency`，默认 **50**，可在页面修改；已有浏览器保存的设置仍生效。此值与本工具执行并发无关。

HTTP worker 数量和 Chromium 辅助验证并发也使用 `TASK_CONCURRENCY`。默认启动并预热 **10 个 Python HTTP worker**，固定保留 10 个，退出的空闲 worker 自动补起；不再动态扩缩容。超过容量的操作排队，断开后取消等待；账号交接前清理 Session，同账号的工作区仍顺序授权。浏览器辅助最多同时运行 **10 个**，仅在需要人机验证时启动。限流和网络错误保留原有的重试、退避处理，不再改变并发数。

协议登录的浏览器辅助只获取登录所需的一个验证结果，不再额外等待注册流程结果；Chromium 路径查找复用已启动的 Playwright 驱动。验证计算分段让出事件循环，避免阻塞其他账号请求、进度日志和取消操作。

实验性的 `BROWSER_REUSE_ENABLED=true` 可复用 Python、Playwright 和 Chromium 进程，默认 `false`。每次辅助验证仍新建并关闭独立浏览器 Context，Cookie、本地存储、代理和 User-Agent 按任务隔离。池按需启动，上限同为 `TASK_CONCURRENCY`；空闲 60 秒、完成 20 次任务或发生异常、取消、超时后回收进程。开关修改后需重启。默认关闭时，每次任务结束都会回收进程。测试使用本地模拟页面验证隔离、代理切换及冷暖启动耗时，不代表真实上游登录速度或成功率。

`/api/system/config` 返回服务端固定并发；`/api/system/metrics` 的 `tasks`、`browsers` 展示任务和辅助浏览器的上限、占用与排队，`workers` 展示固定 HTTP worker 数量和租约情况。

`/api/system/metrics.stageTimings` 按固定阶段汇总排队、代理预检、HTTP 请求、密码/TOTP、工作区授权和浏览器启动/导航/验证等耗时。次数、失败数、取消数、平均值和最大值自进程启动累计；P50/P95 仅统计各阶段最近 512 次样本。每个账号的进度卡片提供“阶段耗时”，对应流水线响应的 `timings` 和 SSE 的 `account_timing` 事件。账号执行总耗时不含排队；父阶段包含子阶段，同一阶段多次调用累计，各项不能直接相加。全局统计不记录账号、代理地址或凭据，重启后清零。

旧 `SENTINEL_BROWSER_CONCURRENCY`、`OAUTH_CONCURRENCY`、`OAUTH_BATCH_CONCURRENCY`、`ALIVE_CHECK_THREADS`、`SESSION_RELOGIN_THREADS` 和 `CURL_CFFI_*POOL_SIZE`/`CURL_CFFI_WORKERS` 均不再控制并发，可从已有 `.env` 删除。CLI 不再接受 `--concurrency`，统一读取配置文件。容器默认 `APP_PIDS_LIMIT=2048`，为 Chromium 的进程和线程留出空间；CPU 和内存分别由 `APP_CPU_LIMIT`、`APP_MEMORY_LIMIT` 控制，默认上限为 4 核、6 GiB；临时目录上限为 512 MiB。实际资源需求取决于浏览器页面和代理延迟，提高并发时应同时调整资源限制。

服务器后台任务已停用；推送在当前请求内完成，失败时在浏览器保留结果供重试。`.env` 仅保留服务运营配置，不写入用户提交的数据。旧 SQLite 和 settings.json 不会被加载。

## 浏览器定时测活

定时测活默认关闭，在推送目标左侧通过“测活：关闭 / 开启”单选按钮控制，选择加密保存在当前浏览器。必须先选择 Sub2API 或 CPA 并保存完整推送配置，才允许开启；Sub2API 还需要选择推送分组。配置不完整时会回到“关闭”并提示原因；改为“不推送”或切到未配置的目标也会关闭测活，补齐配置后需手动重新开启。开启后，有已保存登录凭据（邮箱、密码、TOTP）和 Session / OAuth 访问令牌的账号才会每 60 秒检查一次。页面显示状态和最近结果。关闭测活或清空登录数据会停止执行并释放租约。

测活兼容 Web Session、个人 OAuth 和工作区令牌。只有明确失效才直接执行密码/TOTP 的“全部工作区 RT”流程，保存新凭据并推送非 free 账号，与手动选择的登录模式无关。已确认失效的旧 Web Session 会被清理，后续使用新 OAuth 令牌测活，避免旧 Session 引起反复重登。网络错误、403 验证拦截、429 限流不触发重登；临时重登失败以 5、10、20、30 分钟退避。明确的账号删除/停用/不存在、密码错误、2FA 凭据错误会持久标记在当前浏览器中，停止该账号的自动检查和重试；页面列出跳过原因，修正凭据并手动登录成功后恢复。Sub2API 根据邮箱、工作区 ID 和所选分组匹配并更新已有账号，匹配重复时暂停该项；CPA 更新同名认证文件。

定时器、账号和配置均由当前浏览器持有，并发仍共用 `TASK_CONCURRENCY`（默认 10）。Web Locks 和加密存储版本检查避免同一浏览器多个标签页重复执行。独立浏览器访问同一服务时，服务器按邮箱发放 180 秒的内存租约：同一账号仅一个浏览器测活、重登及自动推送，不同账号可并行。每分钟续约，执行期间每 30 秒续约；服务器还会锁住正在执行的请求，避免长任务被另一浏览器接管。负责的浏览器关闭/掉线且在途请求结束后，租约到期，其他浏览器在下一轮检查时接管（通常约 3–4 分钟）。显式关闭会提前释放空闲租约。

协调服务仅在进程内保留带随机盐的账号/凭据/持有者摘要、到期时间和错误类别，不保存明文账号、密码、2FA、令牌或推送配置，也不写数据库/磁盘。相同错误凭据的停止状态临时共享 24 小时；各浏览器自己的停止标记持续保留。服务重启会清空协调状态；该实现适用于当前单实例部署，多实例需要共享的租约协调存储。新令牌仍只更新执行任务的浏览器，其他浏览器接管时使用自己的凭据，不会自动同步配置或新令牌。

正在手动操作时推迟检查。页面必须保持打开，后台标签页节流或设备休眠会延迟执行，恢复后继续，不补发积压轮次。所有浏览器都关闭后无法继续定时运行。

“清空所有数据”位于“浏览器本地解析”左侧，点击后须确认，将同时删除账号、代理和推送配置，并停止测活；“清空登录数据”保留配置。

## Sub2API / CPA 推送

协议登录标题右侧通过“不推送 / Sub2API / CPA”单选按钮选择目标，默认不推送；格式转换页面在工具栏显示同一组控件。两种服务分别使用独立配置弹窗；保存配置只写当前浏览器的加密工作区，不调用服务器设置保存接口。

- **Sub2API**：填写地址和 Admin Key，读取 OpenAI 分组，选择一个或多个推送分组后保存。协议登录导出与推送共用账号参数，账号 `concurrency` 默认 50；Session 转换沿用转换区的导出参数。
- Session 转换会保留输入中的真实 `refresh_token` 和 `id_token`；Sub2API 推送也支持只有 `access_token` 的账号。只有 AT 时无法在过期后自动续期；协议登录生成 RT 的流程仍要求完整的 AT/RT。账号校验失败会指出序号和缺失字段，不会误报为地址或网络问题。
- **CPA（CLIProxyAPI）**：填写服务地址和 Management Key，可测试连接。标准 CPA 的认证文件接口不支持 Sub2API 式账号分组；模型前缀用于路由。按当前 CPA 导出格式上传 `type: codex` 的 JSON 认证文件；文件名包含邮箱和账号/工作区标识的摘要，同一邮箱的个人及不同工作区不会互相覆盖，相同账号重复推送会更新同名文件。
- **使用方式**：格式转换页面点击“推送转换结果”，范围沿用下载范围，格式由目标决定。协议登录选择目标并保存配置后，全部工作区 RT 完成时，按每个个人/工作区凭据自己的 `plan_type` 自动推送非 `free` 账号；`free` 或类型缺失的账号不推送。全部被过滤时显示跳过提示，不发送推送请求。协议登录不再提供个人/Business 手动推送按钮；手动下载仍包含所有类型，不受自动推送筛选影响。
- **结果与重试**：逐项显示成功、失败或待核对；“重试失败项”只发送远端明确拒绝的条目。超时或未确认的结果需先在目标服务核对，避免重复导入。刷新不会自动重发。

浏览器只在读取分组、测试连接或推送时提交所选服务的管理密钥；普通登录和导出请求不携带这些密钥。`/api/push/*` 接口直接在请求内转发，完全绕过 SQLite 设置/账号仓库，不保存配置、文件或后台队列。转发不跟随重定向，避免将密钥发送到其他地址。推送与其他任务共享 `TASK_CONCURRENCY`，执行并发仍为 10。

接口按参考项目实现：Sub2API 的 `GET /api/v1/admin/groups/all`、`POST /api/v1/admin/accounts/batch`（`x-api-key`，读取逐项 `results`）；CLIProxyAPI 的 `GET /v0/management/auth-files`、`POST /v0/management/auth-files?name=...`（`Authorization: Bearer`，原始 JSON 文件内容）。参考源码为本地 Sub2API `535486b93` 的 `account_handler.go`，以及 Cockpit Tools `b3fc6bd` 内附 CLIProxyAPI 的 `auth_files.go`、`handler.go`。

## 登录模式

正式登录前，先通过该账号实际选中的代理（含首跳链路）访问 OAuth 入口并跟随跳转，确认能到达登录页。检测不携带账号邮箱、密码、TOTP 或已有 Cookie；页面显示脱敏代理地址、结果和耗时。检测失败不提交账号凭据，直连模式同样检测。每个登录流程只检测一次，成功后保持原代理；Session 流程重试时重新检测。`APP_PROXY_PREFLIGHT_TIMEOUT_MS` 设置检测总超时，默认 15000 毫秒。检测通过仅代表当时链路可用。

默认 **全部工作区 RT**：直接走 Codex OAuth，获取个人 RT，再沿用同一 Cookie、设备和代理连接授权已加入的工作区；不先登录 ChatGPT Web。部分工作区失败仍可导出成功结果。

工作区列表优先从当前授权页的结构化数据读取，兼容 React Router 流式数据；页面未提供时才读取工作区 Cookie。已完成密码和 TOTP 验证后，缺少工作区数据会明确报错，不再通过重复登录尝试修复。

**仅协议登录**：登录 ChatGPT Web，将 Session 返回浏览器，成功后结束，不再二次测活。原“个人 RT”已合并到全部工作区模式。

“退出全部会话”“自踢”“重设 2FA”优先复用当前浏览器保存的认证数据。退出会话和重设 2FA 使用已有 Web Session 和 Cookie；缺少有效访问令牌时先尝试从 Web Session Cookie 恢复。明确的会话失效或要求重新认证才回退一次密码/TOTP 登录，网络错误、限流和普通 403 不触发这两个操作的重登。自踢优先使用匹配目标工作区的缓存访问令牌，缺少令牌时用已保存 Cookie 授权，必要时才提交密码和 TOTP。“仅协议登录”和“全部工作区 RT”的登录方式不变。

重设 2FA 成功后，新密钥会立即更新当前账号输入行和加密浏览器存储，保留 Session、Cookie 和设备指纹，后续退出会话可直接复用。若上游要求 MFA 近期认证仍需登录一次；已经禁用旧因子后不会自动用旧 TOTP 重跑整套换绑。退出全部会话成功后，清理该账号的 Session、Cookie、个人/团队令牌和待推送结果，暂停该账号的定时重登，手动登录成功后恢复。密码、最新 TOTP 和代理/推送配置保留。

协议登录仅支持邮箱、密码和 TOTP。“导入文件”位于“退出全部会话”上方，可选择一个或多个 UTF-8 TXT 文件（每个最多 5 MB），每行一个账号，验证通过后追加到输入框并加密保存在当前浏览器；选择功能后才执行。错误行会提示行号，整个文件批次不会部分导入。

文件导入和粘贴使用同一解析器，支持 `email----password----TOTP_SECRET`、`email---password---TOTP_SECRET` 和 `email--password--TOTP_SECRET`。两端连字符数量不同时，按较短端确定分隔宽度（最多 4 个），多余连字符属于密码；例如 `email---password--TOTP_SECRET` 的密码为 `-password`，`email--password---TOTP_SECRET` 的密码为 `password-`。密码内部的连续连字符保留。不再支持邮箱 OAuth、邮箱验证码或接码 API；登录遇到邮箱验证码页面（如 `/email-verification`）会立即失败，不发码、不轮询邮箱。

### 子号自踢

账号输入区右侧的“自踢”位于“重设 2FA”上方。输入邮箱、密码和 TOTP 后点击并确认，将退出这些账号加入的所有非 owner 团队工作区；个人空间、owner 工作区、角色不明确或停用的工作区跳过。退出后需要重新邀请才能加入。

团队识别优先使用工作区结构，兼容 `self_serve_business_prolite` 等套餐名称；类型无法识别会报错，不当作“没有团队”。成员列表允许邮箱为空，仍保留该成员的 ID 参与分页完整性及退出复核；只在唯一匹配当前账号 ID／邮箱后发送自退请求。

`POST /api/v2/accounts/self-leave` 接收所选账号 ID、`confirmed: true` 和当前浏览器账号快照，沿用页面所选代理及全局并发（默认 10）。先读取账号自己的工作区列表，再用其自己的 workspace AT 调用 `DELETE /backend-api/accounts/{workspace_id}/users/{user_id}`，并校验令牌中的工作区和用户身份；不接受调用者指定其他成员 ID。AT 缺失或失效时使用现有密码/TOTP Codex OAuth 授权目标工作区，不依赖 ChatGPT Web 最终 Session。自踢请求遇到 409 或 429 时，各自按 5/10/15 秒最多重试三次，重试耗尽后报告失败；每个工作区单独计数，等待期间可取消。401/403 最多重新认证一次。明确的密码或 2FA 错误停止该账号后续自踢。

删除返回 2xx 仍需复核：优先分页读取完整成员快照，确认本账号已不在其中；自退后无法读取成员列表时，改用本账号完整的工作区清单确认目标已消失。403、部分分页或无法读取都不能计为成功，显示“待确认”。确认退出后只清除已退出工作区的本地凭据；待确认账号暂停定时测活，核对后手动登录可恢复。操作与同账号的定时测活/重登互斥，独立账号仍可并发；所有账号数据仍仅随请求临时处理，并加密返回当前浏览器。

## 代码和检查

- `server.js`、`src/config.js`：唯一入口和环境配置。
- `src/converter.js`：页面服务和会话工具接口；`src/session-network.js`：复用代理和取消机制的测活、用量查询与退出会话。
- `docs/index.html`、`docs/app.css`、`docs/app.js`、`docs/browser-store.js`：页面结构、样式、交互与浏览器存储。
- `login-service/src/api/routes/protocol-pipeline-routes.js`：账号登录流水线路由及依赖组装。
- `login-service/`：内部登录、临时数据处理及导出模块，不是独立 npm 项目。

页面使用 `/api/v2/*`，旧 `/api/login-icloud/api/v2/*` 路径仍兼容，但数据同样必须随请求提交。`/api/ready` 检查服务就绪。

`/api/ready` 还会验证 Python、curl_cffi 和 Playwright Chromium，并实际启动 Sentinel 使用的完整 Chromium、打开本地测试页面；检查结果缓存 60 秒，不访问上游服务。`/api/health` 只检查进程存活。`/api/system/metrics` 可查看请求数量、错误率、平均/最大耗时和 HTTP worker 队列；指标只在内存保存汇总数字，不包含账号、URL、请求内容或凭据。

```powershell
npm test
npm run test:browser
npm run check
npm run check:sensitive-paths
npm run check:runtime
npm audit --omit=dev --registry=https://registry.npmjs.org
```

`check` 检查所有项目 JS/MJS、HTML 内联脚本和 Python 语法。敏感文件检查覆盖 Git 跟踪文件及未忽略的新文件，正常的本地 `.env` 不会误报，但强行加入 Git 的 `.env` 会被拒绝。浏览器测试包含刷新导出、多标签页冲突、清空后旧数据回写及 BroadcastChannel 不可用的场景。GitHub Actions 在 Windows/Linux、Node 22.19/24 上执行检查，并另行构建和验证只读 Docker 容器。

## Docker 部署

Compose 只运行一个应用容器，不挂载持久化数据卷；临时浏览器目录使用 `/tmp` 内存挂载，并禁用容器日志落盘。

Python 直接和传递依赖均固定版本；Docker 基础镜像固定版本与摘要。升级依赖时同步更新锁文件并运行网络、浏览器回归测试。Compose 默认限制 6 GiB 内存、4 个 CPU，可通过 `APP_MEMORY_LIMIT`、`APP_CPU_LIMIT` 调整。

```sh
docker network create sub2api_sub2api-network  # 网络不存在时执行
docker compose -f compose.prod.yaml up -d --build --remove-orphans
```

入口为 `http://127.0.0.1:14173`。从旧版本升级时停止旧容器，并清理旧 runtime 目录及仅供本项目使用的旧数据卷。新版本不会加载或自动删除其他部署的旧数据卷。反向代理应关闭请求体、响应体及账号数据日志。
