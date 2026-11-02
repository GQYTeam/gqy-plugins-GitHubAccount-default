# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（暂无）

## [1.0.0] - 2026-11-02

### Added

- 首个版本：零依赖的 GQY「GitHub 账号」插件（`github-account-default`，Node ≥18，只用 Node 内置模块），stdio 换行 JSON-RPC（`gqy-jsonrpc-v1`）。
- 七个动作：`status`（含 profile 扫描、gh / git 探测、`probe` 真实 API 复核）、`login`（四条路径）、`login-wait`（单次 ≤90s，pending 状态机）、`logout`（含 `purge`）、`env`（`GH_CONFIG_DIR` / `GIT_CONFIG_GLOBAL` 等与 shell `exports`）、`gh`、`git`（argv 数组、不过 shell、进程组回收、超时、输出截断、脱敏）。
- 四条登录路径：`device`（原生设备码流程，远程授权、本地登录；`client_id` 来自参数 / `GQY_GITHUB_CLIENT_ID` / `$GQY_HOME/github/client.json`）、`gh`（委托隔离的 `gh auth login --web`，复用 gh 自带 OAuth App）、`token`（导入 PAT 并校验）、`import`（收养参考布局目录，只读源目录）。
- 隔离存储：账号数据只写 `$GQY_HOME/github/<profile>/`（`account.json`、`gh/config.yml`、`gh/hosts.yml`、`gitconfig`、`profile.json`、`pending.json`），目录 `0700`、文件 `0600`、原子落盘；不读写宿主 `~/.config/gh`、`~/.gitconfig` 与系统 git 配置。
- 隔离执行：子进程强制覆盖 `GH_CONFIG_DIR` / `XDG_STATE_HOME` / `XDG_DATA_HOME` / `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_NOSYSTEM`（gh 的 device-id 等状态也落在 profile 内，不写 `~/.local/state`），gh / git 各自的非交互环境变量；工具探测只写 `<root>/.probe/`；令牌不回显、不落日志，统一脱敏。
- 四组零依赖测试：`test/manifest.mjs`（manifest 与仓库标准）、`test/handshake.mjs`（stdio 握手与错误路径）、`test/isolation.mjs`（路径对抗与诱饵探针）、`test/real-upstream.mjs`（真实上游，缺令牌 / 布局时 SKIP）。
- 建立仓库标准基线：`LICENSE`（PolyForm Noncommercial License 1.0.0）、`NOTICE`、`README.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、`.editorconfig`、`.gitignore`、`Makefile`、`.github/`（CI、Issue / PR 模板、dependabot）、`docs/protocol.md`、`docs/README.md`。
