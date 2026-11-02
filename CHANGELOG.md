# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Security

- 修复 profile 目录软链逃逸：`logout`（含 purge）原先只做词法校验，会跟随「根内指向根外的目录软链」删除根外文件；`env` 会返回逃逸路径，`gh` / `git` 会用逃逸的 `GH_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` 在根外写。现在 `profileEscapeReason` / `assertProfilePathsSafe` 对 profile 目录及 `gh/`、`gh-state/`、`gh-data/`、`gitconfig` 逐个做词法 + realpath 校验，`removeFileQuietly` 也改走 `guardInternalPath`；`logout` / `env` / `gh` / `git` / `login` / `login-wait` / 落盘与读令牌前一律 `-32000`，根外零删除零写入。
- `status` 保持永不抛错：profile 目录逃逸时返回 `isolated.outside_writes:true` + `blocked` 原因、`logged_in:false`、`account:null`，且不读逃逸目录里的任何文件。
- `test/isolation.mjs` 新增软链越界回归（根外软链 / 子路径逃逸 / 根内合法软链不误伤 / 软链环），检查项 415 → 562。

### Fixed

- 文档修正（对照 verifier 复核）：测试检查项数改为实测值（`manifest` 229 / `handshake` 347 / `isolation` 562；带 `GQY_GITHUB_TEST_LAYOUT` 时真实上游 281 项）；工具名按 GQY `ToolName` 规则改为下划线形式（`github_account_default__status` 等，非字母数字统一转 `_`）；未登录可用动作改为 `status` / `env` / `login` / `login-wait` / `logout`（只有 `gh` / `git` 未登录返回 `-32000`）；`gh` 拒绝规则改为「相邻的 `auth`+`token`（或 `auth`+`login` / `auth`+`logout`）或任一参数含 `--show-token`」。
- 文档补充新契约：`status.isolated` 为 `{root, outside_writes, blocked}`，根外软链时 `outside_writes:true`、`blocked` 给原因、`logged_in:false`、`account:null` 且不读逃逸目录；`logout`（含 purge）/ `env` / `gh` / `git` / `login-wait` 对根外 profile 一律 `-32000`，绝不删除或写入根外文件。

## [1.0.0] - 2026-11-02

### Added

- 首个版本：零依赖的 GQY「GitHub 账号」插件（`github-account-default`，Node ≥18，只用 Node 内置模块），stdio 换行 JSON-RPC（`gqy-jsonrpc-v1`）。
- 七个动作：`status`（含 profile 扫描、gh / git 探测、`probe` 真实 API 复核）、`login`（四条路径）、`login-wait`（单次 ≤90s，pending 状态机）、`logout`（含 `purge`）、`env`（`GH_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` 等与 shell `exports`）、`gh`、`git`（argv 数组、不过 shell、进程组回收、超时、输出截断、脱敏）。
- 四条登录路径：`device`（原生设备码流程，远程授权、本地登录；`client_id` 来自参数 / `GQY_GITHUB_CLIENT_ID` / `$GQY_HOME/github/client.json`）、`gh`（委托隔离的 `gh auth login --web`，复用 gh 自带 OAuth App）、`token`（导入 PAT 并校验）、`import`（收养参考布局目录，只读源目录）。
- 隔离存储：账号数据只写 `$GQY_HOME/github/<profile>/`（`account.json`、`gh/config.yml`、`gh/hosts.yml`、`gitconfig`、`profile.json`、`pending.json`），目录 `0700`、文件 `0600`、原子落盘；不读写宿主 `~/.config/gh`、`~/.gitconfig` 与系统 git 配置。
- 隔离执行：子进程强制覆盖 `GH_CONFIG_DIR` / `XDG_STATE_HOME` / `XDG_DATA_HOME` / `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_NOSYSTEM`（gh 的 device-id 等状态也落在 profile 内，不写 `~/.local/state`），gh / git 各自的非交互环境变量；工具探测只写 `<root>/.probe/`；令牌不回显、不落日志，统一脱敏。
- 四组零依赖测试：`test/manifest.mjs`（manifest 与仓库标准）、`test/handshake.mjs`（stdio 握手与错误路径）、`test/isolation.mjs`（路径对抗与诱饵探针）、`test/real-upstream.mjs`（真实上游，缺令牌 / 布局时 SKIP）。
- 建立仓库标准基线：`LICENSE`（PolyForm Noncommercial License 1.0.0）、`NOTICE`、`README.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、`.editorconfig`、`.gitignore`、`Makefile`、`.github/`（CI、Issue / PR 模板、dependabot）、`docs/protocol.md`、`docs/README.md`。
