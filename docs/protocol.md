# 协议与行为契约

本文件是 `github-account-default` 插件的**唯一行为契约**：`index.js` 实现、`test/` 断言、`README.md` 与施工单都引用本文件，不各写一份。

协议层照主仓库 [`GQY/docs/designs/04-插件运行时.md`](../../GQY/docs/designs/04-插件运行时.md) 的 P3 / P4 / P8 / P11 与 [`GQY/docs/blueprint/plugin.md`](../../GQY/docs/blueprint/plugin.md) 的 manifest 全字段表与 stdio 换行 JSON-RPC 契约。

## 1. 目标与两种用法

插件替**一个专属使用者**（`顾清影`）在本机托管一个 GitHub 账号，只用 Node 内置模块（零依赖）：

1. **远程 GitHub 授权、本地登录**：`login` 用 GitHub 设备码流程（OAuth Device Flow）拿 `user_code` + `verification_uri`，使用者在任意设备打开链接输入码授权，本机 `login-wait` 轮询到令牌后落盘——本机全程不用交互，也不需要浏览器。
2. **隔离 gh**：账号数据只写进 `$GQY_HOME/github/<profile>/`，gh 与 git 一律通过 `GH_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` 指向这里，**从不读写宿主机的 `~/.config/gh` 与 `~/.gitconfig`**。

两种能力汇合在同一个隔离目录布局上；插件不写 shell rc、不改宿主 git 全局配置、不回显令牌。

## 2. 目录布局（照 `github/` 参考布局）

参考布局（`account.json` + `gh/` + `gitconfig` 三件）被原样沿用，只多包一层 profile 目录：

```
$GQY_HOME/github/
  client.json                 # 可选：{"client_id":"..."}，device 路径的 OAuth App
  .probe/                     # 工具探测专用隔离目录（0700，gh --version / git --version 用）
  <profile-slug>/
    account.json              # {"login":"<login>","id":<number>}，与参考布局同形
    gh/                       # GH_CONFIG_DIR
      config.yml              # gh 配置（版本 1，git_protocol https 等）
      hosts.yml               # gh 凭据（0600）：users.<login>.oauth_token + 顶层 oauth_token / user
    gh-state/                 # XDG_STATE_HOME：gh 的 device-id 等状态，按需创建（0700）
    gh-data/                  # XDG_DATA_HOME：gh 扩展等数据，按需创建（0700）
    gitconfig                 # 隔离 git 配置：user.name / user.email / gh 凭据助手
    profile.json              # 插件自有元数据（不含令牌）：来源、scope、git 身份、时间戳
    pending.json              # 仅登录进行中存在（0600）：设备码流程状态，结束即删
```

- `GQY_HOME`：环境变量，缺省 `~/.gqy`。**测试与验收只用临时目录**，绝不用真实 `$GQY_HOME`。
- 目录权限 `0700`，`account.json` / `hosts.yml` / `profile.json` / `pending.json` / `gitconfig` 权限 `0600`；写入一律「临时文件 + rename」原子落盘。
- `profile-slug`：默认 profile 的显示名是 `顾清影`；slug 由显示名规范化得到——Unicode 字母 / 数字 / `.` / `_` / `-` 保留，其余字符（空格、`/`、`\`、控制字符等）替换为 `-`，折叠连续 `-`、去首尾 `-`；空结果回退 `default`。profile 参数必须能规范化成非空 slug，且不得为 `.` / `..`、不得含路径分隔符或 NUL，否则 `-32602`。
- 所有路径先 `path.resolve` 再校验仍在 `$GQY_HOME/github/` 之内；软链解析后的目标同样必须在根内（越界报 `-32000`），不跟随指向根外的软链。
- 清理逻辑（`logout purge`）只删根内的 profile 目录；根、根外、软链目标越界一律拒绝。

## 3. 隔离规则（硬约束）

1. 只写 `$GQY_HOME/github/` 之内；不读也不写 `~/.config/gh`、`~/.gitconfig`、`~/.config/git/config`、系统 git 配置。
2. 子进程环境**强制覆盖**：`GH_CONFIG_DIR=<profile>/gh`、`XDG_STATE_HOME=<profile>/gh-state`、`XDG_DATA_HOME=<profile>/gh-data`、`GIT_CONFIG_GLOBAL=<profile>/gitconfig`、`GIT_CONFIG_NOSYSTEM=1`；不继承宿主已有的 `GH_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` / `XDG_STATE_HOME` / `XDG_DATA_HOME`。
   - 非覆盖不可：`gh --version` 这种只读命令也会往 `$XDG_STATE_HOME/gh/device-id` 写文件（默认落在 `~/.local/state`），所以 gh 的 state / data 目录必须一起指进 profile。
3. `gh` 执行环境另加 `GH_PROMPT_DISABLED=1`、`GH_NO_UPDATE_NOTIFIER=1`、`GH_PAGER=cat`、`NO_COLOR=1`、`CLICOLOR=0`。`git` 执行环境另加 `GIT_TERMINAL_PROMPT=0`、`GIT_PAGER=cat`。
   - `status` 的 `gh --version` / `git --version` 探测只允许写 `<root>/.probe/`（0700）：`GH_CONFIG_DIR=<root>/.probe/gh`、`XDG_STATE_HOME=<root>/.probe/state`、`XDG_DATA_HOME=<root>/.probe/data`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`、`GH_NO_UPDATE_NOTIFIER=1`；探测不得创建任何 profile 目录。
4. 令牌只在内存与 `hosts.yml` 出现：任何动作结果、错误消息、stderr 日志都不得含令牌；统一脱敏（见 §9）。
5. 不落浏览器、不弹窗、不调用系统钥匙串、不改 clipboards（设备码只作为结果返回）。
6. `import` 只读源目录，默认复制不移动；复制后重新校验权限位；`move` 不做。

## 4. JSON-RPC 协议（gqy-jsonrpc-v1）

一行一个 JSON-RPC 2.0，`\n` 分隔，`id` 原样回传。

| 方法 | 请求 | 响应 |
| --- | --- | --- |
| `initialize` | `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":"gqy-jsonrpc-v1"}}` | `{"ok":true,"name":"github-account-default","version":"1.0.0"}` |
| `call` | `{"jsonrpc":"2.0","id":2,"method":"call","params":{"action":"status","arguments":{}}}` | `{"result":{"content":"<JSON 字符串>"}}`；失败 `{"error":{"code":-32000,"message":"..."}}` |
| `shutdown` | `{"jsonrpc":"2.0","id":3,"method":"shutdown"}` | `{"ok":true}` 后退出码 0 |

- 每条动作返回 `result.content` 是**一个 JSON 对象的字符串**（`JSON.stringify`）；`content` 内不再嵌套 JSON 字符串。
- stdin 读到 EOF 立即退出 0（P8 第一道防线），不等 shutdown。
- 错误码：非法 JSON 行 `-32700`（`id` 回 `null`）；非对象 / 缺 method / 缺 id 类型错的请求 `-32600`；未知方法或未知动作 `-32601`；参数形状不合法 `-32602`；业务错误（未登录、令牌无效、越界路径、子进程超时等）`-32000`。任何错误都不崩进程。
- `concurrency: single-channel`：请求按到达顺序串行处理，`login-wait` 阻塞期间后续请求排队（GQY 单次调用超时 `timeout_ms=120000`，`login-wait` 单次自限 ≤90s）。

## 5. 动作契约

所有动作都接受可选 `profile`（string，缺省 `顾清影` 规范化的 slug）。除 `status` / `env` 外，未登录时动作返回 `-32000`（消息以「未登录」开头，并提示先 `login`）——但 `login` / `login-wait` / `logout` / `status` / `env` 本身允许未登录调用。

### 5.1 `status`

参数：`{profile?: string, probe?: boolean}`（默认 `probe:false`，不联网）。

```
{
  "plugin": "github-account-default",
  "version": "1.0.0",
  "default_profile": "<slug>",
  "default_display_name": "顾清影",
  "root": "<绝对路径 $GQY_HOME/github>",
  "profile": "<slug>",
  "display_name": "<profile 显示名>",
  "profile_dir": "<绝对路径>",
  "gh_config_dir": "<绝对路径>/gh",
  "gitconfig": "<绝对路径>/gitconfig",
  "host": "github.com",
  "logged_in": true,
  "account": {"login": "<login>", "id": 123},   // 未登录为 null
  "source": "device|gh|token|import|null",
  "scopes": ["repo", "read:org"],
  "git": {"name": "...", "email": "..."},
  "has_pending": false,
  "pending": null,                               // 有进行中登录时为 {route, user_code, verification_uri, expires_at}
  "tools": {"gh": {"available": true, "version": "gh version 2.103.3 (...)"}, "git": {"available": true, "version": "git version 2.x"}},
  "profiles": [{"profile": "<slug>", "display_name": "...", "login": "...|null", "logged_in": true, "host": "github.com"}],
  "isolated": {"root": "<绝对路径>", "outside_writes": false},
  "verified": null                               // probe=true 时为 {"ok":true,"login":"...","id":n,"scopes":[...],"checked_at":"RFC3339"} 或 {"ok":false,"status":401,"message":"..."}
}
```

- `tools`：在 `PATH` 里探测 `gh` / `git`（`gh --version`、`git --version` 各 3s 上限，失败 `available:false`）；结果缓存 60s。探测子进程按 §3 第 3 条的 `.probe/` 隔离环境执行，不碰 `$HOME`，也不创建 profile 目录。
- `profiles`：扫描 `$GQY_HOME/github/*/profile.json`（最多 100 条）；无法解析的目录跳过，不报错。
- `probe=true`：用现令牌 `GET https://api.github.com/user`（超时 10s）复核，**不抛错**——401/403/网络错误都装进 `verified.ok=false`。
- `status` 永不返回令牌；`scopes` 来自 `profile.json`（import 时来自令牌端点响应头）。

### 5.2 `login`

参数：`{route: "device"|"gh"|"token"|"import", profile?, host?, scopes?, client_id?, token?, path?, git_name?, git_email?, force?}`。

公共行为：先按 §6 解析出 profile 目录（已存在则沿用其 `profile.json` 的 git 身份，除非本次显式传 `git_name` / `git_email`）；`host` 缺省 `github.com`，规范化成小写、去掉 `https://` 前缀与末尾 `/`；`scopes` 缺省 `repo,read:org,gist,workflow`。

#### route=`token`（导入 PAT）

1. 校验 `token` 非空字符串（否则 `-32602`），长度 ≤4096。
2. `GET https://api.github.com/user`（`Authorization: Bearer`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、UA `gqy-github-account-default/1.0.0`，超时 15s）。
3. 401 → `-32000`「令牌无效或已过期（GitHub 返回 401）」；403 且 `x-ratelimit-remaining: 0` → 「GitHub API 限流」；网络失败 → `-32000` 带原因。
4. 成功：取 `login` / `id` / 响应头 `x-oauth-scopes`（逗号分隔；细粒度 PAT 无此头 → `[]`，`profile.json` 记 `"token_kind":"fine-grained"`）。
5. 落盘（§7）后返回 `{"state":"ready","route":"token", ...}`。

#### route=`import`（收养参考布局）

1. `path` 必须存在且是目录（否则 `-32602`）。目录里必须有 `account.json` 或 `gh/hosts.yml` 之一，否则 `-32000`「不是 github 账号布局目录」。
2. 从 `gh/hosts.yml` 取 `<host>` 段：优先顶层 `oauth_token`，其次 `users.<user>.oauth_token`；`user` 取顶层 `user`，缺失时取 `users` 里唯一键。`account.json` 提供 `login` / `id`（缺失则用令牌 `GET /user` 补齐）。
3. 用令牌 `GET /user` 复核：令牌身份与 `account.json` 的 `login` / `id` 不一致时，`force:true` 才继续（以令牌为准），否则 `-32000`「账号不一致」。
4. 复制 `account.json`、`gh/config.yml`（缺失则生成）、`gh/hosts.yml`、`gitconfig`（缺失则生成）到新 profile 目录，权限收紧到 `0700/0600`；写 `profile.json`（`source:"import"`）。
5. 返回 ready。源目录不变（不移动、不修改）。

#### route=`device`（原生设备码，远程授权）

1. `client_id` 解析顺序：参数 → 环境 `GQY_GITHUB_CLIENT_ID` → `$GQY_HOME/github/client.json` 的 `client_id`；都没有 → `-32000`「device 路径需要 client_id：注册 OAuth App / GitHub App 后设置 GQY_GITHUB_CLIENT_ID」。
2. `POST https://<host>/login/device/code`（`Accept: application/json`，body `{"client_id","scope"}`，超时 15s）→ `{device_code, user_code, verification_uri, expires_in, interval}`。
3. 写 `pending.json`（0600，**不含 access token**，含 device_code）。
4. 返回 `{"state":"pending","route":"device","profile":...,"user_code":"XXXX-XXXX","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5,"expires_at":"RFC3339","next_poll_s":<interval>,"hint":"用任意设备打开 verification_uri 输入 user_code，完成后调用 login-wait"}`。
5. `verification_uri` 原样用 GitHub 返回值；不要把 user_code 拼进 URL。

#### route=`gh`（委托隔离的 gh）

1. `gh` 不在 `PATH` → `-32000`「gh 不可用，改用 device 或 token 路径」。
2. 拉起 `gh auth login --hostname <host> --git-protocol https --web`，环境按 §3 覆盖（`GH_CONFIG_DIR` 指向**当前 profile 的 gh/**，不存在也照常创建）；stdin 为 pipe 且保持打开，stdout/stderr 各不超过 64 KiB 缓存。
3. 从输出解析 `One-time code ([A-Z0-9-]+)` 与 `https://<host>/login/device`；15s 内解析不到 → 杀掉子进程并 `-32000`「gh 未给出设备码」。
4. 解析到后**不关闭 stdin**、不杀子进程，内存记录 `{route:"gh", profile, host, child, user_code, verification_uri}`，写 `pending.json`（route=gh、`gh_pid`，0600）。
5. 返回 pending（同 device 形状，`expires_in` 取 900、`interval` 取 5，加 `"route":"gh"`）。
6. 若同一 profile 已有进行中的 gh 登录，先杀掉旧子进程再重开（幂等）。

### 5.3 `login-wait`

参数：`{profile?, wait_s?: 1..90}`（默认 20；越界 `-32602`）。

- 找到该 profile 的 pending（内存优先，其次 `pending.json`）：没有 → `{"state":"missing","hint":"没有进行中的登录，先调用 login"}`（**不报错**）。
- `expires_at` 已过 → 清 pending，返回 `{"state":"expired","hint":"设备码已过期，重新发起 login"}`。
- `route=device`：按 `interval`（≥5s，收到 `slow_down` 后 +5s）轮询 `POST https://<host>/login/oauth/access_token`（`Accept: application/json`，body `{"client_id","device_code","grant_type":"urn:ietf:params:oauth:grant-type:device_code"}`）：
  - `authorization_pending` → 继续等；
  - `slow_down` → 间隔 +5s 继续；
  - `expired_token` → 清 pending，`state:"expired"`；
  - `access_denied` → 清 pending，`state:"denied"`；
  - 其它 `error` → 清 pending，`state:"failed"` + `error` 原文；
  - 成功 → 校验 `GET /user` → 落盘（source=device）→ `state:"ready"`；
  - `wait_s` 用尽仍 pending → `{"state":"pending","remaining_s":<n>,"next_poll_s":<n>,"user_code":...,"verification_uri":...}`。
- `route=gh`：子进程已退出 0 且 `gh/hosts.yml` 出现令牌 → 读 hosts 取令牌与 login → `GET /user` 复核 → 补 `account.json` / `gitconfig` / `profile.json`（`gh/config.yml`、`hosts.yml` 由 gh 自己写，保持不动）→ ready；子进程非 0 退出 → `{"state":"failed","exit_code":n,"message":"<stderr 尾部脱敏>"}`；子进程还在跑 → pending（带 `remaining_s`）。
- ready 后删 `pending.json` 与内存状态；`state:"ready"` 的字段同 `login` ready：`{"state":"ready","route","profile","host","login","id","scopes","source","config":{"profile_dir","gh_config_dir","gitconfig","account_json"}}`。

### 5.4 `logout`

参数：`{profile?, purge?: boolean}`。

- 未登录且目录不存在 → 幂等返回 `{"state":"logged-out","profile":...,"removed":[],"purged":false}`。
- 非 purge：只从 `gh/hosts.yml` 删 `oauth_token` 字段与 `users.<login>` 条目（保留 config.yml、gitconfig、profile.json），删 `account.json` 与 `pending.json`，`profile.json` 置 `logged_in:false`。
- purge：先按 §3 校验路径在根内，再 `rm -rf` 整个 profile 目录。
- 不联网、不吊销远端令牌（吊销需 client_secret，交给使用者在 GitHub 设置页做；README 写明）。
- 返回 `{"state":"logged-out","profile":...,"removed":["<相对路径>",...],"purged":false}`。

### 5.5 `env`

参数：`{profile?}`。返回（**永远不含令牌**）：

```
{
  "profile": "<slug>", "display_name": "...", "host": "github.com",
  "logged_in": true, "login": "<login>|null",
  "profile_dir": "<绝对路径>", "gh_config_dir": "<绝对路径>", "gitconfig": "<绝对路径>",
  "env": {
    "GH_CONFIG_DIR": "<gh_config_dir>",
    "GIT_CONFIG_GLOBAL": "<gitconfig>",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_TERMINAL_PROMPT": "0"
  },
  "exports": "export GH_CONFIG_DIR='...'\nexport GIT_CONFIG_GLOBAL='...'\nexport GIT_CONFIG_NOSYSTEM='1'\nexport GIT_TERMINAL_PROMPT='0'",
  "hint": "把 exports 贴进当前 shell，或在子进程环境里直接用 env 的键值；不要用宿主 ~/.config/gh"
}
```

`exports` 每行都是 `export KEY='值'`：所有值一律单引号包裹（含 `1` / `0`），值内部的单引号转义为 `'\''`，保证可直接粘贴执行。

### 5.6 `gh` / `git`

参数：`gh {args: string[], profile?, timeout_s?: 1..90, stdin?}`、`git {args: string[], profile?, cwd?, timeout_s?: 1..90}`。

- `args` 必须是 1–64 个非空字符串、单个 ≤4096 字符、不含 NUL（否则 `-32602`）；argv 直接 `spawn`，不过 shell、不做变量展开。
- 未登录 → `-32000`「未登录」。
- `gh` 额外拒绝：`auth token`（任一段，含 `--show-token`）→ `-32000`「不通过插件取令牌」；`auth login` / `auth logout` → `-32000`「登录用 login 动作」（`--show-token` 属同一防御：令牌不经插件输出）。
- `git` 的 `cwd` 必须存在且是目录（否则 `-32602`），缺省插件进程 cwd。
- 返回 `{"exit_code":<n|null>,"stdout":"...","stderr":"...","duration_ms":<n>,"timed_out":false,"truncated":{"stdout":false,"stderr":false},"tool":"gh|git"}`。
- 超时：默认 30s、上限 90s；到点 `SIGTERM`，2s 不退出再 `SIGKILL`，返回 `exit_code:null,timed_out:true` 与已收到的输出。
- stdout / stderr 各截断到 1 MiB（`truncated` 标 true，尾部补 `\n…（截断）`）；输出统一脱敏。
- 进程组：`detached:true` 拉子进程，超时/结束时 `process.kill(-pid, sig)` 回收整组，防孤儿。

## 6. 输入校验与错误码

| 场景 | 码 |
| --- | --- |
| 非法 JSON 行 | `-32700`（`id:null`） |
| 请求不是对象 / `method` 非字符串 / `id` 缺失 | `-32600` |
| 未知方法、未知动作 | `-32601` |
| 参数不是对象、缺必填、类型错、枚举外、越界数值、profile 非法、args 形状错、cwd 不存在 | `-32602` |
| 未登录、令牌无效、设备码过期 / 拒绝、gh 不可用、路径越界、子进程超时、上游网络错误 | `-32000` |

`-32602` 的消息要指出**哪个字段**错；`-32000` 用中文短句，可带 GitHub 原文，但原文先脱敏。

## 7. 落盘细节

### `gh/hosts.yml`（gh 兼容）

```yaml
github.com:
    users:
        <login>:
            oauth_token: <token>
    git_protocol: https
    oauth_token: <token>
    user: <login>
```

- 4 空格缩进、`host` 键不带引号（与 gh 自己写的一致）；解析兼容 2/4 空格与行尾注释被忽略不了就报错（只认 `key: value` 与纯缩进结构，结构不合法 → `-32000`）。
- 写回保留其它 host 段（多主机不丢），只改目标 host。

### `gh/config.yml`

沿用参考布局的键（`version: 1`、`git_protocol: https`、`editor`、`prompt`、`prefer_editor_prompt`、`pager`、`aliases`、`http_unix_socket`、`browser`、`color_labels`、`accessible_colors`、`accessible_prompter`、`spinner`）。已存在时不覆盖（保留使用者在 `gh config set` 里改的值）。

### `gitconfig`（照参考布局）

```ini
# Managed by gqy plugin `github-account-default` (`login`). Rewritten on every login.
[user]
	name = <git_name>
	email = <git_email>
[credential]
	helper =
[credential "https://github.com"]
	helper =
	helper = !gh auth git-credential
[credential "https://gist.github.com"]
	helper =
	helper = !gh auth git-credential
```

- `git_name` 缺省 = 登录名；`git_email` 缺省 = 对 `github.com` 用 `<id>+<login>@users.noreply.github.com`，其它 host 用空（不写 `email` 行并提示传 `git_email`）。
- 每次 ready 重写；使用者在 profile 内手动改的 git 身份会被 `login` 覆盖（文档写明），改身份用 `git_name` / `git_email` 参数。

### `account.json`

```json
{
  "login": "<login>",
  "id": 123
}
```

两空格缩进 + 结尾换行，与参考布局同形。

### `profile.json`

```json
{
  "schema": 1,
  "plugin": "github-account-default",
  "version": "1.0.0",
  "profile": "<显示名>",
  "slug": "<slug>",
  "host": "github.com",
  "login": "<login>",
  "id": 123,
  "scopes": ["repo"],
  "source": "device|gh|token|import",
  "token_kind": "oauth|fine-grained|null",
  "git": {"name": "...", "email": "..."},
  "created_at": "RFC3339",
  "updated_at": "RFC3339",
  "logged_in": true
}
```

`profile.json` 永不包含令牌或令牌片段。

## 8. 令牌与敏感数据

- 令牌只在两处存在：进程内存、`gh/hosts.yml`（0600）。`pending.json` 只有 device_code（短时有效、不可换 token 之外的能力），结束即删。
- 脱敏模式：`gh[pousr]_[A-Za-z0-9]{16,}`、`github_pat_[A-Za-z0-9_]{16,}` → `gh*_…<末 4 位>`；同时脱敏 `Authorization: ...` 头与 `oauth_token: ...` 行。
- `gh` 动作结构性拒绝令牌输出：`auth token`（含 `--show-token` 变体）直接报错，不给「先取出来再脱敏」的机会。
- 错误消息只给原因与状态码，不给请求头、响应体原文（除 GitHub 的 `error` / `error_description` 短字段）。
- 不写请求日志；stderr 只写 `[github-account] <action> ok|fail <duration>ms` 这类元信息。

## 9. 明确不做

- 不做 OAuth App 注册、不做 client_secret、不做令牌刷新（GitHub 设备码令牌不过期，吊销由使用者操作）。
- 不做多 host 批量同步、不做 SSH key 生成与上传（`git_protocol` 固定 `https`）。
- 不写 shell rc / git 全局配置 / `~/.config/gh`；不改宿主的 gh 登录态。
- 不做 GUI、不做二维码渲染（只回 `verification_uri` 与 `user_code`）。
