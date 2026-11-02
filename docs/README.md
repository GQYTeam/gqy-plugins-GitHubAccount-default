# docs

本仓库（`gqy-plugins-GitHubAccount-default`）自己的文档索引。仓库是 GQY 的「GitHub 账号」插件：远程设备码授权 + 本地登录，gh / git 全程走隔离配置目录。文档保持最小；三层文档规范与跨仓库决定都在主仓库 `GQY/docs/`。

## 文档索引

| 文件 | 内容 |
| --- | --- |
| [`../README.md`](../README.md) | 插件定位、两种用法（远程授权本地登录 / 隔离 gh）、目录布局、七个动作、安装方式、隔离与安全、工具名、与主仓库关系、不做 |
| [`protocol.md`](protocol.md) | **唯一行为契约**：目录布局、隔离规则、JSON-RPC、七个动作的完整参数与返回、落盘细节、令牌脱敏、明确不做 |
| `docs/README.md`（本文件） | 文档索引 + manifest 约定 + 动作语义补充 + 存储布局与权限 + 当前状态 |
| [`GQY/docs/designs/04-插件运行时.md`](../../GQY/docs/designs/04-插件运行时.md) | 插件运行时四层模型与 P1–P12（本插件相关：P3 manifest、P4 适配器、P8 进程组回收、P11 工具注册） |
| [`GQY/docs/blueprint/plugin.md`](../../GQY/docs/blueprint/plugin.md) | manifest 全字段表、原生 stdio 换行 JSON-RPC 契约、`/api/plugins` 接口（本插件按它逐字段实现） |
| [`GQY/docs/designs/11-安全与沙盒.md`](../../GQY/docs/designs/11-安全与沙盒.md) | 安装即信任（SEC5），插件不设运行时权限墙 |
| [`GQY/docs/designs/09-存储.md`](../../GQY/docs/designs/09-存储.md) | 数据根 `$GQY_HOME`（缺省 `~/.gqy`）与目录权限约定 |
| [`GQY/docs/construction/024-GitHub账号插件.md`](../../GQY/docs/construction/024-GitHub账号插件.md) | 本插件的施工单与验收记录（Lead 维护） |

## manifest 约定（已实现）

`manifest.json` 在本仓库内提交，随仓库部署。字段规则见 [`GQY/docs/blueprint/plugin.md`](../../GQY/docs/blueprint/plugin.md) 的 manifest 全字段表。

| 字段 | 值 |
| --- | --- |
| `id` | `github-account-default`（目录名必须与它一致） |
| `name` / `version` | `GitHub 账号（顾清影 专属）` / `1.0.0` |
| `description` | `为 顾清影 专属的 GitHub 账号插件：远程设备码授权后在本机完成登录，gh 与 git 全程走隔离配置目录（GH_CONFIG_DIR / GIT_CONFIG_GLOBAL），提供 status / login / login-wait / logout / env / gh / git 七个动作` |
| `protocol` | `gqy-jsonrpc-v1`（原生 stdio 换行 JSON-RPC 2.0） |
| `command` | `["node", "index.js"]`，相对 manifest 目录，不经过 shell |
| `cwd` | `.` |
| `timeout_ms` | `120000`（契约规定的 GQY 单次调用超时；`login-wait` 单次自限 ≤90s） |
| `concurrency` | `single-channel`（请求按到达顺序串行；`login-wait` 阻塞期间后续请求排队） |
| `actions` | 七个：`status` / `login` / `login-wait` / `logout` / `env` / `gh` / `git`，各带 JSON Schema |
| `provides` / `requires` | 空数组 |

七个动作的 schema 要点：

- `status`：`profile` 可选（string）；`probe` 可选（boolean，默认 false，不联网）。
- `login`：`route` 必填（enum `device` / `gh` / `token` / `import`）；`profile` / `host` / `scopes` / `client_id` / `token` / `path` / `git_name` / `git_email` 为 string，`force` 为 boolean，都可选。
- `login-wait`：`profile` 可选；`wait_s` 可选 integer，1–90，默认 20。
- `logout`：`profile` 可选；`purge` 可选 boolean，默认 false。
- `env`：`profile` 可选。
- `gh`：`args` 必填（array，minItems 1，每项 string）；`profile` / `stdin` 可选 string；`timeout_s` 可选 integer，1–90，默认 30。
- `git`：`args` 必填；`profile` / `cwd` 可选 string；`timeout_s` 可选 integer，1–90，默认 30。

协议方法：`initialize` 回 `{ok:true,name,version}`；`call` 传 `{action, arguments}`，结果取 `result.content`（一个 JSON 对象的字符串，内部不再嵌套 JSON 字符串）；`shutdown` 回 ok 后退出 0；stdin EOF 自退是最后一道防线（04 P8）。错误码见下。

## 动作语义

补充 `../README.md` 动作表之外的细节，全部以 [`protocol.md`](protocol.md) §5 为准。

### 四条登录路径的取舍

| 路径 | 前置条件 | 拿到什么 | 代价与边界 |
| --- | --- | --- | --- |
| `device` | 一个 OAuth App / GitHub App 的 `client_id`（参数 → `GQY_GITHUB_CLIENT_ID` → `$GQY_HOME/github/client.json`） | 原生设备码流程的 `user_code` + `verification_uri`，`login-wait` 轮询收口 | 插件不做 OAuth App 注册、不持 `client_secret`、不做刷新；`verification_uri` 原样用 GitHub 返回值 |
| `gh` | `PATH` 里有可用的 `gh` | 复用 gh 自带 OAuth App：拉起 `gh auth login --hostname <host> --git-protocol https --web`，解析 One-time code 与授权链接 | 依赖 gh 的输出格式（15s 内解析不到设备码 → `-32000`）；子进程要存活到 `login-wait` 收口；gh 不可用时改用 `device` / `token` |
| `token` | 已有的 PAT（`ghp_` / `github_pat_` / `gho_`，≤4096 字符） | 校验 `GET /user` 后直接 ready，一次调用完成 | 令牌由使用者自己生成与保管；细粒度 PAT 没有 `x-oauth-scopes` 头时 `scopes` 记 `[]`、`token_kind` 记 `fine-grained` |
| `import` | 一份参考布局目录，至少有 `account.json` 或 `gh/hosts.yml` | 收养已有账号（`account.json` + `gh/config.yml` + `gh/hosts.yml` + `gitconfig`） | 只读源目录、默认复制不移动；令牌身份与 `account.json` 不一致时必须 `force:true`；不支持 `move` |

四条路径落盘到同一套隔离布局，`source` 字段分别记 `device` / `gh` / `token` / `import`。

### pending 状态机

`login` 只对 `device` / `gh` 两条路径返回 `state:"pending"`（其余两条直接 ready）。pending 期间 `$GQY_HOME/github/<profile>/pending.json`（0600）记录进度：`device` 存 `device_code` 与过期时间，`gh` 存 `gh_pid`；**不含 access token**，结束即删。

`login-wait` 的单次结果：

| `state` | 触发条件 | 后续动作 |
| --- | --- | --- |
| `missing` | 该 profile 没有进行中的登录（内存与 `pending.json` 都没有） | 不报错；先调 `login` |
| `pending` | 还在等（含 `wait_s` 用尽的正常情况），带 `remaining_s` / `next_poll_s` / `user_code` / `verification_uri` | 再调一次 `login-wait` |
| `ready` | 令牌到手且 `GET /user` 校验通过，已落盘并删 pending | 可以调 `status` / `gh` / `git` |
| `expired` | 设备码过期（`expires_at` 已过，或令牌端点回 `expired_token`），pending 已清 | 重新 `login` |
| `denied` | 使用者在授权页拒绝（`access_denied`），pending 已清 | 重新 `login` |
| `failed` | 令牌端点回其它 `error`，或 gh 子进程非 0 退出 | 看返回里的 `error` / `exit_code` / `message`，重新 `login` |

`device` 的轮询规则：`authorization_pending` 继续等；`slow_down` 间隔 +5s；`expired_token` / `access_denied` / 其它 `error` 按上表收口；成功先 `GET /user` 校验再落盘。`gh` 路径：子进程退出 0 且隔离 `gh/hosts.yml` 出现令牌后读令牌、复核身份、补 `account.json` / `gitconfig` / `profile.json`（`gh` 自己写的 `config.yml` / `hosts.yml` 保持不动）；子进程非 0 退出给 `failed`，还在跑给 `pending`。

`login-wait` 在读取 pending 或落盘前先对 profile 目录（含软链解析结果）做根内校验，越界直接 `-32000`，不读也不写逃逸目录。

### 错误码

| 场景 | 码 |
| --- | --- |
| 非法 JSON 行（`id` 回 null） | `-32700` |
| 请求不是对象、`method` 非字符串、`id` 缺失或类型错 | `-32600` |
| 未知方法、未知动作 | `-32601` |
| 参数不是对象、缺必填、类型错、枚举外、数值越界、`profile` 非法、`args` 形状错、`cwd` 不存在、令牌非字符串或超长 | `-32602` |
| 未登录、令牌无效 / 限流、设备码过期或拒绝、gh 不可用、路径越界（含 profile 目录软链越出根）、子进程超时、上游网络错误 | `-32000` |

`-32602` 的消息要指出是哪个字段；`-32000` 用中文短句，可带 GitHub 原文但先脱敏。任何错误都不崩进程。

### 脱敏与权限

- 令牌只在两处：进程内存、`gh/hosts.yml`（0600）。`pending.json` 只放短时有效、不能单独换 token 的 `device_code`（`gh` 路径放 `gh_pid`）。
- `gh` 动作结构性拒绝令牌输出：相邻的 `auth`+`token`、`auth`+`login`、`auth`+`logout`（逐段匹配，不是任意位置出现即拒）以及任一参数含 `--show-token` 都直接 `-32000`，不给「先取出来再脱敏」的机会。
- 脱敏模式：`gh[pousr]_[A-Za-z0-9]{16,}`、`github_pat_[A-Za-z0-9_]{16,}` → `gh*_…<末 4 位>`；同时脱敏 `Authorization: ...` 头与 `oauth_token: ...` 行。`status` / `env` / `login-wait` 的任何结果都不含令牌。
- 错误消息只给原因与状态码，不给请求头或响应体原文（GitHub 的 `error` / `error_description` 短字段除外）。
- 不写请求日志；stderr 只有 `[github-account] <action> ok|fail <duration>ms` 这类元信息。

## 存储布局与权限

`root = $GQY_HOME/github`（`GQY_HOME` 缺省 `~/.gqy`），一个 profile 一个目录：

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `github/` | 根目录 | `0700` |
| `github/client.json` | 可选：`{"client_id":"..."}`，device 路径的 OAuth App | 契约未单列 |
| `github/.probe/` | 工具探测专用隔离目录：`status` 的 `gh --version` / `git --version` 只写这里 | `0700` |
| `github/<profile-slug>/` | profile 目录（slug 由显示名规范化） | `0700` |
| `.../account.json` | `{"login":"<login>","id":<number>}`，两空格缩进 + 结尾换行，与参考布局同形 | `0600` |
| `.../gh/config.yml` | gh 配置（`version: 1`、`git_protocol: https` 等）；已存在不覆盖 | 随 gh |
| `.../gh/hosts.yml` | gh 凭据：`users.<login>.oauth_token` + 顶层 `oauth_token` / `user`；保留其它 host 段 | `0600` |
| `.../gh-state/` | `XDG_STATE_HOME`：gh 的 device-id 等状态，按需创建 | `0700`（按需） |
| `.../gh-data/` | `XDG_DATA_HOME`：gh 扩展等数据，按需创建 | `0700`（按需） |
| `.../gitconfig` | 隔离 git 配置：`[user]` 身份 + `https://github.com` / `https://gist.github.com` 的 gh 凭据助手；每次 ready 重写 | `0600` |
| `.../profile.json` | 插件元数据：`schema` / `plugin` / `version` / `profile` / `slug` / `host` / `login` / `id` / `scopes` / `source` / `token_kind` / `git` / `created_at` / `updated_at` / `logged_in`；**永不包含令牌或令牌片段** | `0600` |
| `.../pending.json` | 仅登录进行中存在：`device` 存 `device_code`、`gh` 存 `gh_pid`，结束即删 | `0600` |

- 写入一律「临时文件 + rename」原子落盘；路径先 `path.resolve` 再校验仍在根内，软链解析结果越界报 `-32000`。
- profile 目录（含软链解析结果）在根外时，`logout`（含 purge）、`env`、`gh`、`git`、`login-wait` 一律 `-32000`；绝不删除、写入根外任何文件（内部删文件工具同样先做词法 + realpath 双重校验）。
- `status` 的 `isolated` 是 `{root, outside_writes, blocked}`：正常 `outside_writes:false`、`blocked:null`；profile 目录在根外时 `outside_writes:true`、`blocked` 给原因，同时 `logged_in:false`、`account:null`，不读逃逸目录里的任何文件；`status` 永不抛错。
- 子进程环境强制覆盖 `GH_CONFIG_DIR`、`XDG_STATE_HOME`、`XDG_DATA_HOME`、`GIT_CONFIG_GLOBAL`、`GIT_CONFIG_NOSYSTEM=1`，不继承宿主同名变量。XDG 两项不是装饰：gh 连 `--version` 都会往 `$XDG_STATE_HOME/gh/device-id` 写文件（默认落 `~/.local/state`），所以 gh 的 state / data 目录必须一起指进 profile（`gh-state/`、`gh-data/`）。
- `status` 的 `gh --version` / `git --version` 探测只写 `<root>/.probe/`（`0700`）：`GH_CONFIG_DIR=<root>/.probe/gh`、`XDG_STATE_HOME=<root>/.probe/state`、`XDG_DATA_HOME=<root>/.probe/data`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`、`GH_NO_UPDATE_NOTIFIER=1`；探测不创建任何 profile 目录。
- `logout` 非 purge：只删 `gh/hosts.yml` 里的 `oauth_token` 与 `users.<login>` 条目、删 `account.json` 与 `pending.json`，保留 `config.yml` / `gitconfig` / `profile.json` 并把 `profile.json` 置 `logged_in:false`。
- `logout purge`：先校验路径在根内，再删整个 profile 目录；根、根外、软链越界一律拒绝。
- `import` 复制后重新收紧权限到 `0700`（目录）/ `0600`（文件）；源目录不变。

## 当前状态

- 实现：`index.js`（零依赖，只用 Node 内置模块；Node ≥18）、`manifest.json`、`package.json`。
- 测试：`test/manifest.mjs`、`test/handshake.mjs`、`test/isolation.mjs`、`test/real-upstream.mjs`，`package.json` 的 `test` 依次串起四组。离线三组测试通过（manifest 229 项 / handshake 347 项 / isolation 483 项检查）；真实上游用例需 `GQY_GITHUB_TEST_TOKEN` / `GQY_GITHUB_TEST_LAYOUT`，无令牌时打印 SKIP 并 exit 0，带 `GQY_GITHUB_TEST_LAYOUT` 时 281 项通过。
- 自检命令：`cd gqy-plugins-GitHubAccount-default && node --check index.js && npm test`；`make check` = `make syntax`（`node --check` 全部 `.js` / `.mjs`）+ `make test`。
- 四组测试各覆盖：
  1. `test/manifest.mjs`：manifest 全字段按 [`GQY/docs/blueprint/plugin.md`](../../GQY/docs/blueprint/plugin.md) 校验（id / name / version / description / protocol / command / cwd / timeout_ms / concurrency / actions / provides / requires，动作集合恰为七个、动作名正则、description 长度、schema 根 `type: object`、必填项），仓库标准文件齐全（`LICENSE` / `NOTICE` / `CONTRIBUTING.md` / `SECURITY.md` / `CHANGELOG.md` / `.editorconfig` / `.gitignore` / `Makefile` / `index.js` / `.github/` 的 CI、Issue / PR 模板、dependabot），文档四件套存在，`package.json` 的 `test` 依次串起四组，`docs/protocol.md` 写明 `gqy-jsonrpc-v1` 与隔离环境变量，全仓扫描不出现令牌形态字符串。
  2. `test/handshake.mjs`：临时 `GQY_HOME` 启动真实插件子进程，走真实 stdio JSON-RPC——`initialize` 回 `{ok:true,name,version}` 且 id 一致；`status` 默认不联网且字段齐全；`env` 形状与 `exports` 转义；`logout` 幂等；`-32700` / `-32600` / `-32601` / `-32602` 各条错误路径；`shutdown` 后 exit 0；只关 stdin 也能自退。
  3. `test/isolation.mjs`：对抗性探针——`profile` 传 `../x`、`a/b`、绝对路径、`..`、空串、控制字符必须 `-32602` 且根外不产生新文件；`HOME` 指向临时目录并放诱饵 `~/.config/gh/hosts.yml` 与 `~/.gitconfig`，同时预置伪造的 `GH_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_NOSYSTEM`，跑 `status` / `env` / `logout` 后断言诱饵内容与 mtime 未变、继承值被无视；软链回归：根内指向根外的 profile 软链对 `logout`（含 purge）/ `env` / `gh` / `git` 一律 `-32000`，`status` 返回 `outside_writes:true` + `blocked` 且不泄露逃逸目录里的假 login / 假令牌，根内合法软链不误伤、软链环不崩；`gh_config_dir` / `gitconfig` 都在临时 `GQY_HOME` 内；目录 `0700` / 文件 `0600`；插件进程不写仓库目录，根外目录零增删改。
  4. `test/real-upstream.mjs`：真实上游用例。**SKIP 条件**：既没有 `GQY_GITHUB_TEST_TOKEN`、也没有 `GQY_GITHUB_TEST_LAYOUT` 时打印 SKIP 并 exit 0（不失败）；网络不可达（DNS / 连接失败）时同样 SKIP，401 / 403 / 协议错误算 FAIL。有令牌时跑 `login route=token` → `status probe=true` 复核 `verified.ok=true` 且身份一致 → `env` 形状 → `gh ["api","user","--jq",".login"]` → `git ["config","--global","user.name"]` → `logout` 后 `logged_in:false`；给了 layout 再跑 `login route=import` 收养并核对 `account.json`；另含 device 缺 `client_id` 的离线探针与有 gh 时的 `login route=gh` 真实设备码探针；全程断言结果字符串不含令牌原文，临时目录用完清理。
- 施工单：主仓库 `GQY/docs/construction/024-GitHub账号插件.md`（Lead 维护）。
