# gqy-plugins-GitHubAccount-default

[![CI](https://github.com/GQYTeam/gqy-plugins-GitHubAccount-default/actions/workflows/ci.yml/badge.svg)](https://github.com/GQYTeam/gqy-plugins-GitHubAccount-default/actions/workflows/ci.yml)

GQY 的「GitHub 账号」插件：为 顾清影 专属，在本机托管一个 GitHub 账号——远程设备码授权、本地完成登录；gh 与 git 全程走隔离配置目录，不碰宿主机的 gh / git 登录态。零依赖，只用 Node 内置模块（Node ≥18）。

## 干什么

两种能力汇合在同一套隔离目录上：

1. **远程 GitHub 授权、本地登录**：`login` 走 GitHub 设备码流程（OAuth Device Flow），本机只拿 `user_code` 与 `verification_uri`；使用者在任意设备打开链接输入码授权，本机 `login-wait` 轮询到令牌后落盘。本机全程不需要浏览器、不弹窗。
2. **隔离 gh**：账号数据只写进 `$GQY_HOME/github/<profile>/`。插件自己跑 gh / git 时强制 `GH_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` 与 gh 的 `XDG_STATE_HOME` / `XDG_DATA_HOME` 指向这里；`env` 动作把 `GH_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` 等隔离变量导出来，调用方在插件之外也能复用这套隔离账号。

七个动作：`status` / `login` / `login-wait` / `logout` / `env` / `gh` / `git`。唯一行为契约是 [`docs/protocol.md`](docs/protocol.md)；本文件讲用法，协议细节以契约为准。

## 用法一：远程 GitHub 授权，本地登录

### 设备码流程（`login` route=device，原生实现，不依赖 gh）

1. `login` 传 `route: "device"`。插件 `POST https://<host>/login/device/code` 拿到设备码，返回：

   ```
   {"state":"pending","route":"device","user_code":"XXXX-XXXX",
    "verification_uri":"https://github.com/login/device",
    "expires_in":900,"interval":5,"expires_at":"<RFC3339>","next_poll_s":5,
    "hint":"用任意设备打开 verification_uri 输入 user_code，完成后调用 login-wait"}
   ```

   `verification_uri` 原样用 GitHub 返回值，不把 `user_code` 拼进 URL。
2. 使用者在**任意设备**打开 `verification_uri`，输入 `user_code` 完成授权。本机只等，不交互。
3. 调用 `login-wait` 收口：单次最多 90 秒（`wait_s` 默认 20），按 `interval` 轮询令牌端点。没等到就返回 `pending`（带 `remaining_s` / `next_poll_s`），可以再调；成功返回 `state: "ready"` 并落盘；过期 / 拒绝 / 失败都有对应 `state`。

`device` 路径需要一个 OAuth App（或 GitHub App）的 `client_id`，三种提供方式：

| 方式 | 位置 | 说明 |
| --- | --- | --- |
| 参数 | `login.arguments.client_id` | 单次调用显式传 |
| 环境变量 | `GQY_GITHUB_CLIENT_ID` | 插件进程继承的环境 |
| 文件 | `$GQY_HOME/github/client.json` | `{"client_id":"..."}`，跨调用复用 |

三者都没有时 `login` 返回 `-32000`，提示设置 `GQY_GITHUB_CLIENT_ID`。

### 另外三条路径怎么替代

| 路径 | 什么时候用 | 关键点 |
| --- | --- | --- |
| `gh` | 本机装了 gh，不想自己注册 OAuth App | 插件拉起 `gh auth login --hostname <host> --git-protocol https --web`，用 **gh 自带的 OAuth App**；从输出解析 One-time code 与授权链接后返回 `pending`，子进程保持存活，由 `login-wait` 收口。`gh` 不在 `PATH` 时返回 `-32000`，改用 `device` 或 `token` |
| `token` | 已有 PAT（`ghp_` / `github_pat_` / `gho_`） | 用令牌 `GET /api.github.com/user` 校验身份与 scope 后落盘；401 / 403 限流 / 网络失败分别给原因 |
| `import` | 手上已有一份参考布局目录（`account.json` + `gh/` + `gitconfig`） | 只读源目录、默认复制不移动；用令牌复核身份，与 `account.json` 不一致时要 `force:true` 才以令牌为准 |

四条路径写入的是同一份隔离布局（见下节）；`login` 成功后都会更新 `gitconfig` 与 `profile.json`。

## 用法二：隔离 gh

账号数据全部落在 `$GQY_HOME/github/`（`GQY_HOME` 缺省 `~/.gqy`），一个 profile 一个目录：

```
$GQY_HOME/github/
  client.json                 # 可选：{"client_id":"..."}，device 路径的 OAuth App
  .probe/                     # 工具探测专用隔离目录（0700），gh --version / git --version 用
  <profile-slug>/
    account.json              # {"login":"<login>","id":<number>}
    gh/                       # GH_CONFIG_DIR
      config.yml              # gh 配置（version: 1、git_protocol: https 等）
      hosts.yml               # gh 凭据（0600）：users.<login>.oauth_token + 顶层 oauth_token / user
    gh-state/                 # XDG_STATE_HOME：gh 的 device-id 等状态，按需创建（0700）
    gh-data/                  # XDG_DATA_HOME：gh 扩展等数据，按需创建（0700）
    gitconfig                 # 隔离 git 配置：user.name / user.email / gh 凭据助手
    profile.json              # 插件自有元数据（不含令牌）：来源、scope、git 身份、时间戳
    pending.json              # 仅登录进行中存在（0600）：设备码流程状态，结束即删
```

- 缺省 profile 的显示名是 `顾清影`，目录名是它规范化后的 slug：Unicode 字母 / 数字 / `.` / `_` / `-` 保留，其余字符替换为 `-`，折叠连续 `-`、去首尾 `-`，空结果回退 `default`。`profile` 参数不能规范化成 `../` 之类越界路径，否则 `-32602`。
- 参考布局的 `account.json` + `gh/` + `gitconfig` 三件被原样沿用，只多包一层 profile 目录；`profile.json` / `pending.json` / `gh-state/` / `gh-data/` / `.probe/` 是插件自有的隔离补充，参考布局没有。
- `gh/config.yml` 已存在时不覆盖（保留使用者 `gh config set` 改过的值）；`gitconfig` 每次 `login` 成功都会重写。

### 在插件之外复用同一套隔离环境

`env` 动作返回这组键值（值都是绝对路径；**永远不含令牌**）：

```
GH_CONFIG_DIR          $GQY_HOME/github/<profile>/gh
GIT_CONFIG_GLOBAL      $GQY_HOME/github/<profile>/gitconfig
GIT_CONFIG_NOSYSTEM   1
GIT_TERMINAL_PROMPT   0
```

并给出可直接贴进 shell 的 `exports`：每行 `export KEY='值'`，所有值单引号包裹（含 `1` / `0`），值内部的单引号转义为 `'\''`。典型用法：

```bash
# 把 env 动作返回的 exports 贴进当前 shell，之后 gh / git 都走隔离配置
export GH_CONFIG_DIR="$GQY_HOME/github/<profile>/gh"
export GIT_CONFIG_GLOBAL="$GQY_HOME/github/<profile>/gitconfig"
export GIT_CONFIG_NOSYSTEM='1'
export GIT_TERMINAL_PROMPT='0'

gh api user --jq .login        # 用的是隔离目录里的登录态
git config --global user.name  # 读的是隔离 gitconfig
```

### git 提交身份

`gitconfig` 里的 `[user]` 由插件管理：`git_name` 缺省等于登录名；`git_email` 缺省对 `github.com` 用 `<id>+<login>@users.noreply.github.com`，其它 host 不写 `email` 行并提示传 `git_email`。改身份用 `login` 的 `git_name` / `git_email` 参数——手动改 profile 内的 `gitconfig` 会被下一次 `login` 覆盖。

## 动作

| 动作 | 参数 | 返回摘要 |
| --- | --- | --- |
| `status` | `profile?`、`probe?`（默认 false，不联网） | `{plugin, version, default_profile, root, profile, profile_dir, gh_config_dir, gitconfig, host, logged_in, account, source, scopes, git, has_pending, pending, tools, profiles, isolated:{root, outside_writes, blocked}, verified}`；`probe:true` 用真实 API 复核，失败装进 `verified.ok=false`，永不抛错 |
| `login` | `route`（必填：`device` / `gh` / `token` / `import`）、`profile?`、`host?`、`scopes?`、`client_id?`、`token?`、`path?`、`git_name?`、`git_email?`、`force?` | 成功 `{state:"ready", route, profile, host, login, id, scopes, source, config:{profile_dir, gh_config_dir, gitconfig, account_json}}`；device / gh 返回 `{state:"pending", …, user_code, verification_uri, expires_at}` |
| `login-wait` | `profile?`、`wait_s?`（1–90，默认 20） | `state` ∈ `ready` / `pending` / `expired` / `denied` / `failed` / `missing`；`missing` 与 `expired` 不报错 |
| `logout` | `profile?`、`purge?`（默认 false） | `{state:"logged-out", profile, removed:[...], purged}`；`purge:true` 删整个 profile 目录 |
| `env` | `profile?` | `{profile, display_name, host, logged_in, login, profile_dir, gh_config_dir, gitconfig, env:{GH_CONFIG_DIR, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM, GIT_TERMINAL_PROMPT}, exports, hint}` |
| `gh` | `args`（必填，argv 数组）、`profile?`、`timeout_s?`（1–90，默认 30）、`stdin?` | `{exit_code, stdout, stderr, duration_ms, timed_out, truncated:{stdout,stderr}, tool:"gh"}` |
| `git` | `args`（必填）、`profile?`、`cwd?`、`timeout_s?`（1–90，默认 30） | 同上，`tool:"git"` |

几个共同点（细节见 [`docs/protocol.md`](docs/protocol.md) §5）：

- 未登录时可用的动作是 `status` / `env` / `login` / `login-wait` / `logout`（`logout` 幂等）；只有 `gh` / `git` 在未登录时返回 `-32000`（消息以「未登录」开头，提示先 `login`）。
- `gh` / `git` 的 `args` 直接 `spawn`，不过 shell、不做变量展开；`gh` 拒绝相邻的 `auth`+`token`（防令牌输出）、`auth`+`login` / `auth`+`logout`（登录请用 `login` 动作），任一参数含 `--show-token` 也直接拒绝。
- `status` 的 `isolated`：正常是 `{root, outside_writes:false, blocked:null}`；profile 目录（含软链解析结果）在根外时 `outside_writes:true`、`blocked` 给原因，同时 `logged_in:false`、`account:null`（不读逃逸目录），`status` 本身永不抛错。
- 子进程超时默认 30s、上限 90s：先 `SIGTERM`，2s 不退再 `SIGKILL`，按进程组回收；stdout / stderr 各截断到 1 MiB。
- `logout` **不联网、不吊销远端令牌**（吊销需要 `client_secret`，插件不持有）；需要作废令牌请到 GitHub 设置页操作。

## 安装方式

GQY 按 `$GQY_HOME/plugins/<id>/manifest.json` 发现插件（见 [`GQY/docs/designs/04-插件运行时.md`](../GQY/docs/designs/04-插件运行时.md) 的 P3 与 [`GQY/docs/blueprint/plugin.md`](../GQY/docs/blueprint/plugin.md) 的 manifest 全字段表）。`$GQY_HOME` 缺省 `~/.gqy`，服务默认监听 `127.0.0.1:5173`。

把本仓库部署成（目录名必须是 plugin id，不是仓库名）：

```
$GQY_HOME/plugins/github-account-default/
  manifest.json      # 本仓库自带，直接使用
  index.js           # 零依赖 stdio JSON-RPC 服务（运行时只需要这两个）
  package.json       # 自检入口（npm test）
  test/              # 四组测试
  docs/
  README.md
```

- 自检（装之前也能跑）：`node --check index.js && npm test`；`make check` 等价于语法检查 + `npm test`。零依赖，只需 Node ≥18。
- 加载：`curl -X POST http://127.0.0.1:5173/api/plugins/github-account-default/load`
- 调试调用：`curl -X POST http://127.0.0.1:5173/api/plugins/github-account-default/call -H 'Content-Type: application/json' -d '{"action":"status","arguments":{}}'`
- 卸载：`curl -X POST http://127.0.0.1:5173/api/plugins/github-account-default/unload`（幂等）。
- 管理接口受 02 R8 鉴权：设了 `GQY_AUTH_TOKEN` 时请求要带 token。
- 安装插件 = 信任它：GQY 不设运行时权限墙（见 [`GQY/docs/designs/11-安全与沙盒.md`](../GQY/docs/designs/11-安全与沙盒.md) SEC5），只从可信来源安装。

## 隔离与安全

- **只写一个根**：`$GQY_HOME/github/`。不读也不写 `~/.config/gh`、`~/.gitconfig`、`~/.config/git/config`、系统 git 配置；不写 shell rc，不改宿主的 gh 登录态。
- **子进程环境强制覆盖**：`GH_CONFIG_DIR`、`XDG_STATE_HOME`、`XDG_DATA_HOME`、`GIT_CONFIG_GLOBAL`、`GIT_CONFIG_NOSYSTEM=1` 不继承宿主值（gh 的 `--version` 也会往 `$XDG_STATE_HOME/gh/device-id` 写文件，所以 state / data 目录必须一起指进 profile）；gh 另加 `GH_PROMPT_DISABLED=1` / `GH_NO_UPDATE_NOTIFIER=1` / `GH_PAGER=cat` / `NO_COLOR=1` / `CLICOLOR=0`，git 另加 `GIT_TERMINAL_PROMPT=0` / `GIT_PAGER=cat`。`status` 的 gh / git 版本探测只写 `<root>/.probe/`，不碰 `$HOME`、不创建 profile 目录。
- **路径与权限**：profile 目录 `0700`，`account.json` / `hosts.yml` / `profile.json` / `pending.json` / `gitconfig` 权限 `0600`；写入一律「临时文件 + rename」原子落盘；路径先 `path.resolve` 再校验仍在根内，软链解析结果越界报 `-32000`。
- **根外一律拒绝**：profile 目录（含软链解析结果）在根外时，`logout`（含 purge）、`env`、`gh`、`git`、`login-wait` 一律 `-32000`，绝不删除或写入根外文件；`status` 不抛错，用 `isolated.outside_writes:true` + `blocked` 标出，并且不读逃逸目录。
- **令牌不回显、不落日志**：令牌只存在于进程内存与 `gh/hosts.yml`（0600）；`pending.json` 只有短时有效的 `device_code`（gh 路径是 `gh_pid`），不含令牌。所有结果 / 错误 / stderr 统一脱敏（`gh[pousr]_*`、`github_pat_*`、`Authorization:` 头、`oauth_token:` 行）；不写请求日志，stderr 只有动作名、成败与耗时这类元信息。
- **不碰宿主交互面**：不拉起浏览器、不弹窗、不调系统钥匙串、不改剪贴板；设备码只作为结果返回。

## 工具名

加载成功后七个动作注册成外部工具（04 P11）。GQY 的 `ToolName` 会把插件 id 与动作名里的非字母数字字符统一转成 `_`（见 [`GQY/app/internal/plugin/tool.go`](../GQY/app/internal/plugin/tool.go)），所以 `github-account-default` 加 `login-wait` 实际得到的是 `github_account_default__login_wait`。实际工具名：

`github_account_default__status`、`github_account_default__login`、`github_account_default__login_wait`、`github_account_default__logout`、`github_account_default__env`、`github_account_default__gh`、`github_account_default__git`。

默认不注入模型：外部工具只在 `GQY_ENABLE_EXTERNAL=1` 或运行时开关开启时进 agent 的工具列表；HTTP `POST /api/plugins/github-account-default/call` 始终可单独调试。

## 与主仓库的关系

- 本仓库与 `GQY/` 主仓库地位平等，都在 GQYTeam 组织工作区里（见 org 根 `README.md` 的仓库地图）。
- 本仓库依赖 GQY 的插件运行时与 manifest 约定，但不 import GQY 的代码。
- 协议层照 `GQY/docs/designs/04-插件运行时.md` 的 P3 / P4 / P8 / P11 与 `GQY/docs/blueprint/plugin.md`；本仓库的施工单与验收记录在主仓库 `GQY/docs/construction/024-GitHub账号插件.md`。
- 跨仓库决定只写一份，放在主仓库 `GQY/docs/designs/`；本仓库只引用，不复制。

## 不做

- 不做 OAuth App 注册、不做 `client_secret`、不做令牌刷新（GitHub 设备码令牌不过期，吊销由使用者在 GitHub 设置页操作）。
- 不做多 host 批量同步、不做 SSH key 生成与上传（`git_protocol` 固定 `https`）。
- 不写 shell rc / git 全局配置 / `~/.config/gh`；不改宿主的 gh 登录态。
- 不做 GUI、不做二维码渲染（只回 `verification_uri` 与 `user_code`）。

## 许可与署名

本仓库按 **PolyForm Noncommercial License 1.0.0** 授权，全文见 [`LICENSE`](LICENSE)。

- **禁止商用。** 生产、部署、售卖、SaaS、内置于商业产品等任何商业目的的使用，都不在授权范围内。
- **必须署名。** fork、二次开发、摘取代码 / 文档 / 设计，都必须标注来源与原作者。
- **保留通知。** 分发任何副本（含修改后的）必须带上 `LICENSE`、[`NOTICE`](NOTICE) 与 `LICENSE` 顶部的 `Required Notice` 原文。

衍生项目的 `README.md`（或同等声明文件）里原样写清这四项：

```text
来源项目：GQYTeam/gqy-plugins-GitHubAccount-default
项目地址：https://github.com/GQYTeam/gqy-plugins-GitHubAccount-default
原作者：GQYTeam
许可证：PolyForm Noncommercial License 1.0.0
```

完整条款与示例见 [`NOTICE`](NOTICE)；第三方代码 / 素材 / 参考项目的许可与出处记在 `docs/third-party/`，各自许可优先于本仓库许可。
