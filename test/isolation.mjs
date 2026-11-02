#!/usr/bin/env node
// GQY github-account-default 插件隔离探针（零依赖，走生产代码路径）：
// 在临时目录里起真实插件子进程，做对抗性探针并断言「只写 $GQY_HOME/github/」：
// 1) profile 传 ../x、a/b、/etc、..、空串、含控制字符 → -32602，且临时 GQY_HOME 之外
//    没有任何新文件（对比临时前缀目录的递归快照）；
// 2) HOME 指向临时目录，放诱饵 ~/.config/gh/hosts.yml 与 ~/.gitconfig（内容 + mtime + 权限快照），
//    依次跑 status / env / logout / 失败登录后断言诱饵完全未变；
// 3) 继承伪造的 GH_CONFIG_DIR / GIT_CONFIG_GLOBAL 也必须被忽略，返回路径都在临时 GQY_HOME 内；
// 4) 插件 owns 的目录 / 文件权限位：GQY_HOME/github 及 profile 目录 0700、文件 0600
//    （离线场景不创建 profile 时只检查已创建的层级，覆盖边界见文件末尾注释）；
// 5) 跑完后仓库工作树文件列表快照不变（插件不写仓库）。
// 失败即断言失败、非零退出；成功打印一行 OK 摘要。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGIN_ID = 'github-account-default';
const clients = [];
let checks = 0;

// ---------- 断言助手 ----------

function check(cond, message) {
  checks += 1;
  assert.ok(cond, message);
}

function checkEqual(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
}

function checkDeep(actual, expected, message) {
  checks += 1;
  assert.deepEqual(actual, expected, message);
}

function canonical(target) {
  const abs = path.resolve(String(target));
  let current = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(parent, child) {
  const base = canonical(parent);
  const target = canonical(child);
  return target === base || target.startsWith(base + path.sep);
}

function childEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (key === 'HOME' || key === 'GQY_HOME') continue;
    if (key.startsWith('GQY_GITHUB_')) continue;
    if (key.startsWith('GH_') || key.startsWith('GIT_') || key.startsWith('XDG_')) continue;
    if (key === 'GITHUB_TOKEN' || key === 'GITHUB_ENTERPRISE_TOKEN') continue;
    env[key] = value;
  }
  return Object.assign(env, overrides);
}

// 说明：gh CLI 首次运行会在 $XDG_STATE_HOME/gh/ 写 device-id。插件必须把 XDG_STATE_HOME /
// XDG_DATA_HOME 一并指到 $GQY_HOME/github/ 之内（本测试的严格「根外无新文件」断言即覆盖此点），
// 所以这里不做任何预热，也不接受 gh 往宿主 HOME 落状态文件。

// 递归快照：相对路径 → 类型 / 大小 / 权限 / mtime。
function snapshotTree(root, skip = new Set()) {
  const entries = new Map();
  if (!fs.existsSync(root)) return entries;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let items;
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (skip.has(item.name)) continue;
      const abs = path.join(current, item.name);
      let stat;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      entries.set(rel, {
        type: item.isSymbolicLink() ? 'symlink' : item.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        mode: stat.mode & 0o777,
        mtimeMs: stat.mtimeMs,
      });
      if (item.isDirectory() && !item.isSymbolicLink()) stack.push(abs);
    }
  }
  return entries;
}

function diffSnapshots(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [rel, meta] of after) {
    if (!before.has(rel)) {
      added.push(rel);
      continue;
    }
    const prev = before.get(rel);
    if (prev.type !== meta.type || prev.size !== meta.size || prev.mode !== meta.mode || prev.mtimeMs !== meta.mtimeMs) {
      changed.push(rel);
    }
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) removed.push(rel);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

function snapshotFile(abs) {
  const stat = fs.statSync(abs);
  return {
    content: fs.readFileSync(abs, 'utf8'),
    size: stat.size,
    mode: stat.mode & 0o777,
    mtimeMs: stat.mtimeMs,
  };
}

function checkMode(abs, expected, message) {
  const mode = fs.statSync(abs).mode & 0o777;
  checkEqual(mode.toString(8), expected.toString(8), message + '（实际 ' + mode.toString(8) + '）');
}

// ---------- 插件进程客户端 ----------

class Client {
  constructor(label, env) {
    this.label = label;
    this.buf = '';
    this.nextId = 1;
    this.sent = [];
    this.received = [];
    this.waiters = new Map();
    this.strays = [];
    this.strayWaiters = [];
    this.stderr = '';
    this.exitInfo = null;
    this.exitWaiters = [];
    this.proc = spawn(process.execPath, ['index.js'], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    clients.push(this);
    this.proc.on('error', (err) => {
      this.exitInfo = { code: -1, signal: null };
      this.failAll(new Error(this.label + ' 进程启动失败：' + err.message));
    });
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
    this.proc.stdin.on('error', () => {});
    this.proc.on('close', (code, signal) => this.onClose(code, signal));
  }

  failAll(err) {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.waiters.clear();
  }

  onData(chunk) {
    this.buf += chunk.toString('utf8');
    let index;
    while ((index = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, index).trim();
      this.buf = this.buf.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.failAll(new Error(this.label + ' stdout 出现非 JSON 行：' + JSON.stringify(line)));
        return;
      }
      this.received.push(message);
      if (message.id === null || message.id === undefined) {
        const waiter = this.strayWaiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } else {
          this.strays.push(message);
        }
        continue;
      }
      const waiter = this.waiters.get(message.id);
      if (!waiter) {
        this.failAll(new Error(this.label + ' 收到未请求的回包 id=' + JSON.stringify(message.id)));
        return;
      }
      this.waiters.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  onClose(code, signal) {
    this.exitInfo = { code, signal };
    this.failAll(new Error(this.label + ' 进程提前退出（code=' + code + ', signal=' + signal + '）'));
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.exitInfo);
    }
  }

  request(method, params = {}, timeoutMs = 25000) {
    const id = this.nextId++;
    this.sent.push(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(this.label + ' 回包超时 id=' + id));
      }, timeoutMs);
      this.waiters.set(id, {
        timer,
        resolve: (reply) => {
          checks += 1;
          assert.equal(reply.id, id, this.label + ' 回包 id 不匹配');
          resolve(reply);
        },
        reject,
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  call(action, args = {}, timeoutMs = 25000) {
    return this.request('call', { action, arguments: args }, timeoutMs);
  }

  async callAction(action, args = {}, timeoutMs = 25000) {
    const reply = await this.call(action, args, timeoutMs);
    check(Boolean(reply.result) && typeof reply.result.content === 'string', action + ' 应成功返回 result.content（实际：' + JSON.stringify(reply.error || reply.result) + '）');
    let parsed;
    try {
      parsed = JSON.parse(reply.result.content);
    } catch (err) {
      check(false, action + ' 的 result.content 不是合法 JSON：' + err.message);
      throw err;
    }
    return parsed;
  }

  async expectError(action, args, code, why, pattern, timeoutMs = 25000) {
    const reply = await this.call(action, args, timeoutMs);
    check(Boolean(reply.error), why + '：应返回 error（实际 ' + JSON.stringify(reply.result) + '）');
    checkEqual(reply.error.code, code, why + '：错误码应为 ' + code + '（实际 ' + String(reply.error.code) + '：' + String(reply.error.message) + '）');
    check(typeof reply.error.message === 'string' && reply.error.message.length > 0, why + '：error.message 应为非空字符串');
    if (pattern) check(pattern.test(reply.error.message), why + '：错误消息不符（实际：' + String(reply.error.message) + '）');
    return reply.error;
  }

  waitExit(timeoutMs = 5000) {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.exitWaiters = this.exitWaiters.filter((item) => item !== waiter);
          resolve(this.exitInfo || { code: null, signal: 'timeout' });
        }, timeoutMs),
      };
      this.exitWaiters.push(waiter);
    });
  }

  kill() {
    if (this.exitInfo) return;
    try {
      this.proc.kill('SIGKILL');
    } catch {
      // 已退出则忽略
    }
  }

  dumpStderr() {
    const text = this.stderr.trim();
    if (text) console.error('[' + this.label + ' stderr]\n' + text.slice(-4000));
  }
}

function killAll() {
  for (const client of clients) client.kill();
}

// 对抗性 profile：路径穿越、分隔符、绝对路径、..、空串、控制字符、非字符串。
const INVALID_PROFILES = ['../x', 'a/b', '/etc', '..', '', '\u0000', 'x\u0000y', '\u0001\u0002', 42];
// 每个动作都必须先做参数校验，profile 非法一律 -32602。
const PROFILE_PROBE_ACTIONS = [
  ['status', {}],
  ['env', {}],
  ['logout', {}],
  ['login', { route: 'token', token: '' }],
  ['login-wait', { wait_s: 1 }],
  ['gh', { args: ['--version'] }],
  ['git', { args: ['--version'] }],
];

// index.js 由 plugin-core 提供；没有它就无法走生产代码路径。
if (!fs.existsSync(path.join(ROOT, 'index.js'))) {
  console.error('FAIL: 仓库缺少 index.js，无法启动真实插件子进程（测试本身按 docs/protocol.md 就绪）');
  process.exit(1);
}

test('github-account-default 隔离与越界探针', async () => {
  const guard = setTimeout(() => {
    console.error('FAIL: 隔离测试总时长超过 180s');
    killAll();
    process.exit(1);
  }, 180000);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gqy-gh-iso-'));
  const gqyHome = path.join(base, 'gqy');
  const decoyHome = path.join(base, 'home');
  const decoyGhDir = path.join(decoyHome, '.config', 'gh');
  const decoyGhHosts = path.join(decoyGhDir, 'hosts.yml');
  const decoyGitconfig = path.join(decoyHome, '.gitconfig');
  fs.mkdirSync(gqyHome, { recursive: true });
  fs.mkdirSync(decoyGhDir, { recursive: true });
  fs.writeFileSync(decoyGhHosts, 'github.com:\n    oauth_token: decoy-token-in-home\n    user: decoy-user\n');
  fs.writeFileSync(decoyGitconfig, '[user]\n\tname = 宿主用户\n\temail = host@example.com\n');

  // 软链回归夹具（快照前建好，任何越界改动都会被「临时前缀目录快照」抓到）：
  //   github/evil  -> $base/outside（根外目录，含假账号布局，只用于断言「不被读取/不被删」）
  //   github/real  -> 根内真实 profile 目录；github/alias -> real（合法根内软链，不应误伤）
  //   github/loop-a <-> github/loop-b（软链环，不得让进程崩）
  const outsideDir = path.join(base, 'outside');
  const OUTSIDE_FAKE_LOGIN = 'outside-fake-login';
  const OUTSIDE_FAKE_TOKEN = 'OUTSIDE_TOKEN_DO_NOT_READ';
  const writeFixture = (abs, content) => {
    fs.writeFileSync(abs, content, { mode: 0o600 });
    fs.chmodSync(abs, 0o600);
  };
  fs.mkdirSync(path.join(outsideDir, 'gh'), { recursive: true, mode: 0o700 });
  fs.chmodSync(outsideDir, 0o700);
  fs.chmodSync(path.join(outsideDir, 'gh'), 0o700);
  writeFixture(path.join(outsideDir, 'account.json'), JSON.stringify({ login: OUTSIDE_FAKE_LOGIN, id: 987654 }) + '\n');
  writeFixture(
    path.join(outsideDir, 'gh', 'hosts.yml'),
    'github.com:\n    users:\n        ' +
      OUTSIDE_FAKE_LOGIN +
      ':\n            oauth_token: ' +
      OUTSIDE_FAKE_TOKEN +
      '\n    git_protocol: https\n    oauth_token: ' +
      OUTSIDE_FAKE_TOKEN +
      '\n    user: ' +
      OUTSIDE_FAKE_LOGIN +
      '\n'
  );
  writeFixture(
    path.join(outsideDir, 'profile.json'),
    JSON.stringify({
      schema: 1,
      plugin: PLUGIN_ID,
      version: '1.0.0',
      profile: OUTSIDE_FAKE_LOGIN,
      slug: 'evil',
      host: 'github.com',
      login: OUTSIDE_FAKE_LOGIN,
      id: 987654,
      scopes: [],
      source: 'import',
      token_kind: null,
      git: { name: OUTSIDE_FAKE_LOGIN, email: '' },
      created_at: '2026-11-02T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
      logged_in: true,
    }) + '\n'
  );
  writeFixture(
    path.join(outsideDir, 'gitconfig'),
    '[user]\n\tname = ' + OUTSIDE_FAKE_LOGIN + '\n\temail = ' + OUTSIDE_FAKE_LOGIN + '@example.com\n'
  );

  const githubRootFixture = path.join(gqyHome, 'github');
  fs.mkdirSync(githubRootFixture, { recursive: true, mode: 0o700 });
  fs.chmodSync(githubRootFixture, 0o700);
  const realProfileDir = path.join(githubRootFixture, 'real');
  fs.mkdirSync(path.join(realProfileDir, 'gh'), { recursive: true, mode: 0o700 });
  fs.chmodSync(realProfileDir, 0o700);
  fs.chmodSync(path.join(realProfileDir, 'gh'), 0o700);
  writeFixture(path.join(realProfileDir, 'account.json'), JSON.stringify({ login: 'real-inroot', id: 424242 }) + '\n');
  writeFixture(path.join(realProfileDir, 'gh', 'config.yml'), 'version: 1\ngit_protocol: https\n');
  writeFixture(
    path.join(realProfileDir, 'gh', 'hosts.yml'),
    'github.com:\n    users:\n        real-inroot:\n            oauth_token: INROOT_TOKEN_NOT_REAL\n    git_protocol: https\n    oauth_token: INROOT_TOKEN_NOT_REAL\n    user: real-inroot\n'
  );
  writeFixture(
    path.join(realProfileDir, 'gitconfig'),
    '[user]\n\tname = real-inroot\n\temail = real-inroot@users.noreply.github.com\n'
  );
  writeFixture(
    path.join(realProfileDir, 'profile.json'),
    JSON.stringify({
      schema: 1,
      plugin: PLUGIN_ID,
      version: '1.0.0',
      profile: 'real',
      slug: 'real',
      host: 'github.com',
      login: 'real-inroot',
      id: 424242,
      scopes: [],
      source: 'import',
      token_kind: null,
      git: { name: 'real-inroot', email: 'real-inroot@users.noreply.github.com' },
      created_at: '2026-11-02T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
      logged_in: true,
    }) + '\n'
  );
  fs.symlinkSync(outsideDir, path.join(githubRootFixture, 'evil'), 'dir');
  fs.symlinkSync(realProfileDir, path.join(githubRootFixture, 'alias'), 'dir');
  fs.symlinkSync(path.join(githubRootFixture, 'loop-b'), path.join(githubRootFixture, 'loop-a'), 'dir');
  fs.symlinkSync(path.join(githubRootFixture, 'loop-a'), path.join(githubRootFixture, 'loop-b'), 'dir');

  const outsideSnapshotBefore = snapshotTree(outsideDir);
  const outsideAccountBefore = snapshotFile(path.join(outsideDir, 'account.json'));
  const githubDirsBeforeSpawn = new Set(
    fs.readdirSync(githubRootFixture, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
  );

  const decoyBefore = { hosts: snapshotFile(decoyGhHosts), gitconfig: snapshotFile(decoyGitconfig) };
  const decoyDirEntriesBefore = fs.readdirSync(decoyGhDir).sort();
  const baseBefore = snapshotTree(base);
  const repoBefore = snapshotTree(ROOT, new Set(['.git', 'node_modules']));

  // 继承伪造的宿主 gh / git 配置目录：插件必须无视它们（docs/protocol.md §3.2）。
  const hostileXdgState = path.join(decoyHome, '.local', 'state');
  const hostileXdgData = path.join(decoyHome, '.local', 'share');
  const env = childEnv({
    HOME: decoyHome,
    GQY_HOME: gqyHome,
    GH_CONFIG_DIR: decoyGhDir,
    GIT_CONFIG_GLOBAL: decoyGitconfig,
    GIT_CONFIG_NOSYSTEM: '0',
    // 宿主已有的 gh state/data 位置：契约 §3.2 要求插件全部覆盖，不能采纳
    XDG_CONFIG_HOME: path.join(decoyHome, '.config'),
    XDG_STATE_HOME: hostileXdgState,
    XDG_DATA_HOME: hostileXdgData,
  });
  let client = null;
  let ownedDirCount = 0;

  try {
    client = new Client('iso', env);
    const init = await client.request('initialize', { protocol: 'gqy-jsonrpc-v1' });
    checkEqual(init.result && init.result.name, PLUGIN_ID, 'initialize 应返回插件名');

    // 1) 基线路径：全部在临时 GQY_HOME 内，且不采纳继承的 GH_CONFIG_DIR / GIT_CONFIG_GLOBAL
    const status = await client.callAction('status', {});
    checkEqual(status.plugin, PLUGIN_ID, 'status.plugin 不符');
    checkEqual(canonical(status.root), canonical(path.join(gqyHome, 'github')), 'status.root 应为临时 GQY_HOME/github');
    check(isInside(gqyHome, status.profile_dir), 'status.profile_dir 应在临时 GQY_HOME 内（实际 ' + status.profile_dir + '）');
    check(isInside(gqyHome, status.gh_config_dir), 'status.gh_config_dir 应在临时 GQY_HOME 内（实际 ' + status.gh_config_dir + '）');
    check(isInside(gqyHome, status.gitconfig), 'status.gitconfig 应在临时 GQY_HOME 内（实际 ' + status.gitconfig + '）');
    check(canonical(status.gh_config_dir) !== canonical(decoyGhDir), 'status.gh_config_dir 不得使用继承的 GH_CONFIG_DIR');
    check(canonical(status.gitconfig) !== canonical(decoyGitconfig), 'status.gitconfig 不得使用继承的 GIT_CONFIG_GLOBAL');
    check(!isInside(decoyHome, status.profile_dir), 'status.profile_dir 不得落在临时 HOME 内');
    check(canonical(status.gitconfig) !== canonical(path.join(os.homedir(), '.gitconfig')), 'status.gitconfig 不得指向宿主 ~/.gitconfig');
    check(!String(status.gh_config_dir).includes(path.join(os.homedir(), '.config', 'gh')), 'status.gh_config_dir 不得指向宿主 ~/.config/gh');
    checkEqual(status.isolated && status.isolated.outside_writes, false, 'status.isolated.outside_writes 应为 false');

    const envResult = await client.callAction('env', {});
    check(isInside(gqyHome, envResult.profile_dir), 'env.profile_dir 应在临时 GQY_HOME 内');
    check(isInside(gqyHome, envResult.gh_config_dir), 'env.gh_config_dir 应在临时 GQY_HOME 内');
    check(isInside(gqyHome, envResult.gitconfig), 'env.gitconfig 应在临时 GQY_HOME 内');
    checkEqual(envResult.env.GH_CONFIG_DIR, envResult.gh_config_dir, 'env.exports 用的 GH_CONFIG_DIR 应指向隔离目录');
    checkEqual(envResult.env.GIT_CONFIG_GLOBAL, envResult.gitconfig, 'env.exports 用的 GIT_CONFIG_GLOBAL 应指向隔离目录');
    checkEqual(envResult.env.GIT_CONFIG_NOSYSTEM, '1', 'env.env.GIT_CONFIG_NOSYSTEM 应强制为 "1"');
    checkEqual(envResult.env.GIT_TERMINAL_PROMPT, '0', 'env.env.GIT_TERMINAL_PROMPT 应强制为 "0"');
    check(canonical(envResult.env.GH_CONFIG_DIR) !== canonical(decoyGhDir), 'env 不得复用继承的 GH_CONFIG_DIR');
    check(canonical(envResult.env.GIT_CONFIG_GLOBAL) !== canonical(decoyGitconfig), 'env 不得复用继承的 GIT_CONFIG_GLOBAL');

    // 1b) 新契约 §2/§3：status 的工具探测只允许写 <root>/.probe/（0700），不得创建 profile 目录，
    //     且必须覆盖继承的 XDG_STATE_HOME / XDG_DATA_HOME（不往宿主 gh state/data 落文件）。
    const githubRootAfterStatus = path.join(gqyHome, 'github');
    if (fs.existsSync(githubRootAfterStatus)) {
      const subdirs = fs
        .readdirSync(githubRootAfterStatus, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name);
      const newSubdirs = subdirs.filter((name) => !githubDirsBeforeSpawn.has(name));
      check(
        newSubdirs.every((name) => name === '.probe'),
        'status 的工具探测只允许写 <root>/.probe/，不得创建 profile 目录（新增子目录：' + newSubdirs.join(',') + '）'
      );
      const probeDir = path.join(githubRootAfterStatus, '.probe');
      if (fs.existsSync(probeDir)) {
        checkMode(probeDir, 0o700, '工具探测隔离目录 .probe 权限应为 0700（docs/protocol.md §2）');
      }
    }
    check(!fs.existsSync(path.join(hostileXdgState, 'gh')), '插件不得采纳继承的 XDG_STATE_HOME（gh state 应隔离进 profile/.probe）');
    check(!fs.existsSync(path.join(hostileXdgData, 'gh')), '插件不得采纳继承的 XDG_DATA_HOME（gh data 应隔离进 profile/.probe）');

    // 2) 对抗性 profile：每个动作都必须 -32602，且不越界写文件
    for (const bad of INVALID_PROFILES) {
      const label = JSON.stringify(bad);
      for (const [action, args] of PROFILE_PROBE_ACTIONS) {
        const payload = Object.assign({}, args, { profile: bad });
        await client.expectError(action, payload, -32602, action + ' profile=' + label + ' 应返回 -32602', /profile/i);
      }
    }

    // 3) 离线业务错误路径：不得联网、不得写到根外
    const deviceReply = await client.call('login', { route: 'device' }, 30000);
    check(Boolean(deviceReply.error), '缺 client_id 的 device 登录应返回 error');
    checkEqual(deviceReply.error.code, -32000, '缺 client_id 的 device 登录应返回 -32000');
    await client.expectError('login', { route: 'import', path: path.join(base, 'no-such-layout') }, -32602, 'import 路径不存在应返回 -32602', /path/);
    await client.expectError('login', { route: 'import', path: decoyHome }, -32000, 'import 指向非布局目录应返回 -32000', /布局|account|hosts|import/i);

    // 失败路径之后进程仍可服务
    const afterProbes = await client.callAction('status', {});
    checkEqual(afterProbes.logged_in, false, '失败探针之后仍应是未登录状态');

    // 3b) 软链越界回归（task-5 修复后的行为契约；verifier task-4 指出的覆盖缺口）
    // 判定助手：软链环这类「降级可接受」的调用，要么成功返回 content，要么 -32000，不能崩进程。
    const softResult = (reply, why) => {
      if (reply.error) {
        checkEqual(
          reply.error.code,
          -32000,
          why + '：若报错应为 -32000（实际 ' + String(reply.error.code) + '：' + String(reply.error.message) + '）'
        );
        return null;
      }
      check(Boolean(reply.result) && typeof reply.result.content === 'string', why + '：应返回 result.content 或 -32000');
      try {
        return JSON.parse(reply.result.content);
      } catch (err) {
        check(false, why + '：result.content 不是合法 JSON（' + err.message + '）');
        return null;
      }
    };

    // 3b-1) 根内 -> 根外的 profile 软链：logout（含 purge）/ env / gh / git 必须 -32000
    await client.expectError('logout', { profile: 'evil' }, -32000, 'logout 对根外软链 profile 应返回 -32000');
    await client.expectError('logout', { profile: 'evil', purge: true }, -32000, 'logout purge=true 对根外软链 profile 应返回 -32000');
    await client.expectError('env', { profile: 'evil' }, -32000, 'env 对根外软链 profile 应返回 -32000');
    const ghEvil = await client.expectError('gh', { profile: 'evil', args: ['--version'] }, -32000, 'gh 对根外软链 profile 应返回 -32000');
    check(/^profile 目录/.test(String(ghEvil.message)), 'gh 越界错误消息应以「profile 目录」开头（实际：' + String(ghEvil.message) + '）');
    const gitEvil = await client.expectError('git', { profile: 'evil', args: ['--version'] }, -32000, 'git 对根外软链 profile 应返回 -32000');
    check(/^profile 目录/.test(String(gitEvil.message)), 'git 越界错误消息应以「profile 目录」开头（实际：' + String(gitEvil.message) + '）');

    // 3b-2) status 永不抛错，但不读逃逸目录：outside_writes:true + blocked + 未登录 + 不泄露假 login
    const statusEvil = await client.callAction('status', { profile: 'evil' });
    checkEqual(statusEvil.plugin, PLUGIN_ID, '根外软链 profile 的 status 仍应返回插件信息');
    check(Boolean(statusEvil.isolated) && statusEvil.isolated.outside_writes === true, 'status 对根外软链应返回 isolated.outside_writes:true');
    check(
      typeof (statusEvil.isolated || {}).blocked === 'string' && statusEvil.isolated.blocked.trim().length > 0,
      'status 对根外软链应给 isolated.blocked 原因'
    );
    checkEqual(statusEvil.logged_in, false, 'status 对根外软链应 logged_in:false（不读逃逸目录）');
    checkEqual(statusEvil.account, null, 'status 对根外软链应 account:null（不读逃逸目录）');
    checkEqual(statusEvil.pending, null, 'status 对根外软链应 pending:null');
    const statusEvilRaw = JSON.stringify(statusEvil);
    check(!statusEvilRaw.includes(OUTSIDE_FAKE_LOGIN), 'status 不得泄露根外目录里的假 login');
    check(!statusEvilRaw.includes(OUTSIDE_FAKE_TOKEN), 'status 不得泄露根外目录里的假令牌标记');
    const statusAfterEvil = await client.callAction('status', {});
    check(!JSON.stringify(statusAfterEvil).includes(OUTSIDE_FAKE_LOGIN), '默认 status 的 profiles 扫描不得跟随根外软链');

    // 3b-3) login-wait：missing 或 -32000 均可，进程不得崩
    const waitEvilReply = await client.call('login-wait', { profile: 'evil', wait_s: 1 });
    const waitEvilData = softResult(waitEvilReply, 'login-wait 对根外软链 profile');
    check(
      waitEvilData === null || (waitEvilData && waitEvilData.state === 'missing'),
      'login-wait 对根外软链应返回 missing 或 -32000（实际：' + JSON.stringify(waitEvilData) + '）'
    );

    // 3b-4) 根内合法软链不误伤：outside_writes:false，env 可用且 realpath 仍在根内
    const statusAlias = await client.callAction('status', { profile: 'alias' });
    check(Boolean(statusAlias.isolated) && statusAlias.isolated.outside_writes === false, '根内合法软链 status 不应误伤（outside_writes:false）');
    checkEqual((statusAlias.isolated || {}).blocked, null, '根内合法软链 status 的 isolated.blocked 应为 null');
    const envAlias = await client.callAction('env', { profile: 'alias' });
    check(isInside(gqyHome, envAlias.profile_dir), '根内合法软链的 env.profile_dir realpath 应在 GQY_HOME 内');
    check(isInside(gqyHome, envAlias.gh_config_dir), '根内合法软链的 env.gh_config_dir realpath 应在 GQY_HOME 内');
    check(isInside(gqyHome, envAlias.gitconfig), '根内合法软链的 env.gitconfig realpath 应在 GQY_HOME 内');
    checkEqual(canonical(envAlias.profile_dir), canonical(realProfileDir), '根内合法软链的 env.profile_dir 应解析到根内真实 profile 目录');

    // 3b-5) 软链环：status / logout / env 任一降级都可，但进程不崩
    softResult(await client.call('status', { profile: 'loop-a' }), 'status 对软链环');
    softResult(await client.call('logout', { profile: 'loop-a' }), 'logout 对软链环');
    softResult(await client.call('env', { profile: 'loop-a' }), 'env 对软链环');

    // 3b-6) 根外目录零增删改，且进程仍可服务
    const outsideAfterSymlinkProbes = snapshotTree(outsideDir);
    const outsideDiff = diffSnapshots(outsideSnapshotBefore, outsideAfterSymlinkProbes);
    checkEqual(outsideDiff.added.length, 0, '软链越界探针不应在根外目录新增文件/目录（' + outsideDiff.added.join(',') + '）');
    checkEqual(outsideDiff.removed.length, 0, '软链越界探针不应删除根外目录文件（' + outsideDiff.removed.join(',') + '）');
    checkEqual(outsideDiff.changed.length, 0, '软链越界探针不应改动根外目录文件（' + outsideDiff.changed.join(',') + '）');
    check(fs.existsSync(path.join(outsideDir, 'account.json')), '根外 account.json 必须仍然存在（logout 不得跟随软链删除）');
    if (fs.existsSync(path.join(outsideDir, 'account.json'))) {
      checkEqual(
        snapshotFile(path.join(outsideDir, 'account.json')).content,
        outsideAccountBefore.content,
        '根外 account.json 内容应保持不变'
      );
    }
    const aliveAfterSymlink = await client.callAction('status', {});
    checkEqual(aliveAfterSymlink.plugin, PLUGIN_ID, '软链探针之后进程应仍可服务');

    // 4) 诱饵文件：内容 / 大小 / 权限 / mtime 完全未变（插件不读写宿主 gh/git 配置）
    const decoyAfter = { hosts: snapshotFile(decoyGhHosts), gitconfig: snapshotFile(decoyGitconfig) };
    checkEqual(decoyAfter.hosts.content, decoyBefore.hosts.content, '诱饵 ~/.config/gh/hosts.yml 内容被改动');
    checkEqual(decoyAfter.hosts.size, decoyBefore.hosts.size, '诱饵 ~/.config/gh/hosts.yml 大小被改动');
    checkEqual(decoyAfter.hosts.mode, decoyBefore.hosts.mode, '诱饵 ~/.config/gh/hosts.yml 权限被改动');
    checkEqual(decoyAfter.hosts.mtimeMs, decoyBefore.hosts.mtimeMs, '诱饵 ~/.config/gh/hosts.yml mtime 被改动');
    checkEqual(decoyAfter.gitconfig.content, decoyBefore.gitconfig.content, '诱饵 ~/.gitconfig 内容被改动');
    checkEqual(decoyAfter.gitconfig.size, decoyBefore.gitconfig.size, '诱饵 ~/.gitconfig 大小被改动');
    checkEqual(decoyAfter.gitconfig.mode, decoyBefore.gitconfig.mode, '诱饵 ~/.gitconfig 权限被改动');
    checkEqual(decoyAfter.gitconfig.mtimeMs, decoyBefore.gitconfig.mtimeMs, '诱饵 ~/.gitconfig mtime 被改动');
    checkDeep(fs.readdirSync(decoyGhDir).sort(), decoyDirEntriesBefore, '诱饵 ~/.config/gh/ 目录项被改动');

    // 5) 临时前缀目录快照：GQY_HOME 之外不得出现任何新文件 / 改动 / 删除
    const baseAfter = snapshotTree(base);
    const baseDiff = diffSnapshots(baseBefore, baseAfter);
    for (const rel of baseDiff.added) {
      const abs = path.join(base, rel);
      check(isInside(gqyHome, abs), '越界：临时 GQY_HOME 之外新建了路径 ' + rel);
    }
    for (const rel of baseDiff.removed) {
      check(false, '不应删除临时目录里的既有路径 ' + rel);
    }
    for (const rel of baseDiff.changed) {
      const abs = path.join(base, rel);
      check(isInside(gqyHome, abs), '不应改动临时 GQY_HOME 之外的文件 ' + rel);
    }

    // 6) 权限位：插件 owns 的目录 / 文件（离线场景可能只创建了 github 根，未创建 profile 目录）
    const githubRoot = path.join(gqyHome, 'github');
    if (fs.existsSync(githubRoot)) {
      checkMode(githubRoot, 0o700, 'GQY_HOME/github 根目录权限应为 0700（docs/protocol.md §2）');
      const walkOwned = (dir, depth) => {
        let items;
        try {
          items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const item of items) {
          const abs = path.join(dir, item.name);
          if (item.isDirectory()) {
            checkMode(abs, 0o700, '插件 owns 的目录权限应为 0700：' + path.relative(githubRoot, abs));
            if (depth > 1) walkOwned(abs, depth - 1);
          } else if (item.isFile()) {
            checkMode(abs, 0o600, '插件 owns 的文件权限应为 0600：' + path.relative(githubRoot, abs));
          }
        }
      };
      walkOwned(githubRoot, 3);
      for (const item of fs.readdirSync(githubRoot, { withFileTypes: true })) {
        if (item.isDirectory()) ownedDirCount += 1;
      }
    }

    // 7) 仓库工作树：插件不写仓库（文件集合与权限不变）
    const repoAfter = snapshotTree(ROOT, new Set(['.git', 'node_modules']));
    const repoDiff = diffSnapshots(repoBefore, repoAfter);
    // 本仓正被并行施工：index.js / 文档可能由其他作者在测试期间落盘，这些新增不算插件写入。
    const concurrentlyAuthored = new Set(['index.js', 'README.md', 'CHANGELOG.md', 'docs/README.md']);
    const unexpectedAdded = repoDiff.added.filter((rel) => !concurrentlyAuthored.has(rel));
    const unexpectedChanged = repoDiff.changed.filter((rel) => !concurrentlyAuthored.has(rel));
    for (const rel of unexpectedAdded) check(false, '插件不应在仓库内新建文件：' + rel);
    for (const rel of unexpectedChanged) check(false, '插件不应改动仓库内文件：' + rel);
    checkDeep(repoDiff.removed, [], '插件不应删除仓库内文件');
    for (const [rel, meta] of repoBefore) {
      if (!repoAfter.has(rel)) continue;
      if (concurrentlyAuthored.has(rel)) continue;
      checkEqual(repoAfter.get(rel).mode, meta.mode, '仓库文件权限不应被插件改动：' + rel);
    }
    if (repoDiff.added.length > unexpectedAdded.length) {
      console.error(
        'NOTE: 测试期间仓库新增（并行作者写入，非插件行为）：' +
          repoDiff.added.filter((rel) => concurrentlyAuthored.has(rel)).join(' / ')
      );
    }

    // 8. shutdown 收尾（进程 0 退出）
    const shutdown = await client.request('shutdown', {});
    check(shutdown.result && shutdown.result.ok === true, 'shutdown 应返回 ok:true');
    const exitInfo = await client.waitExit(5000);
    checkEqual(exitInfo.code, 0, 'shutdown 后进程应以 0 退出（实际 ' + JSON.stringify(exitInfo) + '）');
  } catch (err) {
    for (const item of clients) item.dumpStderr();
    throw err;
  } finally {
    killAll();
    clearTimeout(guard);
    fs.rmSync(base, { recursive: true, force: true });
  }

  // 覆盖边界（离线场景，避免联网登录）：
  // - 这里对插件实际创建的每一层做 0700/0600 断言；离线时通常只建到 GQY_HOME/github 根，
  //   若登录失败路径已创建 profile 目录则连带检查 gh/ 与文件。
  // - 登录成功后必然出现的 hosts.yml / gitconfig / account.json 的 0600 由 real-upstream 覆盖。
  // - 「不读宿主 ~/.config/gh」以内容 / 大小 / mtime / 权限快照为准（apfs 的 atime 不可靠，
  //   不读 vs 读了没改在文件系统层面不可区分）；诱饵文件由临时 HOME 提供，不触碰真实宿主目录。
  console.log(
    'OK: 隔离与越界探针通过（' +
      INVALID_PROFILES.length +
      ' 个非法 profile × ' +
      PROFILE_PROBE_ACTIONS.length +
      ' 个动作、软链越界/合法软链/软链环回归、诱饵未变、根外无写入，' +
      (ownedDirCount > 0 ? '含 ' + ownedDirCount + ' 个插件自有子目录的权限检查' : '离线未创建 profile 目录，权限检查限于已创建层级') +
      '，' +
      checks +
      ' 项检查）'
  );
});
