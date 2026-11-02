#!/usr/bin/env node
// GQY github-account-default 插件握手测试（零依赖，走生产代码路径）：
// 用临时 GQY_HOME / HOME 启动真实插件子进程（node index.js），按 docs/protocol.md 断言
// 1) initialize 回 {ok:true,name:"github-account-default",version:"1.0.0"}，id 一致；
// 2) status 默认不联网、字段齐全、路径都在临时 GQY_HOME 内；
// 3) env 形状与 shell exports 单引号转义（临时 GQY_HOME 路径里故意带单引号）；
// 4) logout 幂等；login-wait 无 pending 返回 missing；
// 5) 错误路径逐项：-32700 / -32600 / -32601 / -32602 / -32000，且进程不崩；
// 6) shutdown 后 exit 0；只关 stdin 也能在 5s 内自退（04 P8）。
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
const PLUGIN_VERSION = '1.0.0';
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

// 把路径规范成「解析软链后的形式」，不存在时沿祖先回溯，兼容 macOS /var → /private/var。
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

// 干净子进程环境：只保留 PATH / NODE_* 等基础变量，HOME 与 GQY_HOME 指向临时目录，
// 去掉宿主可能注入的 GH_* / GIT_* / GQY_GITHUB_* / 令牌变量。
function childEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (key === 'HOME' || key === 'GQY_HOME') continue;
    if (key.startsWith('GQY_GITHUB_')) continue;
    if (key.startsWith('GH_') || key.startsWith('GIT_')) continue;
    if (key === 'GITHUB_TOKEN' || key === 'GITHUB_ENTERPRISE_TOKEN') continue;
    env[key] = value;
  }
  return Object.assign(env, overrides);
}

// 一个长驻插件进程的轻客户端：按 id 分发回包，收集 id=null 的杂项回包与 stderr。
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
    this.violations = [];
    this.stderr = '';
    this.exitInfo = null;
    this.exitWaiters = [];
    this.proc = spawn(process.execPath, ['index.js'], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.failAll(new Error(this.label + ' 回包不是 JSON 对象：' + line));
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
        this.violations.push(message);
        console.error(
          this.label + ' 收到未请求或重复的回包 id=' + JSON.stringify(message.id) + '：' + JSON.stringify(message).slice(0, 300)
        );
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

  request(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return this.sendObject({ jsonrpc: '2.0', id, method, params }, id, timeoutMs);
  }

  // 发一条任意 JSON-RPC 消息（用于缺 method / 非对象等非法请求）
  sendObject(message, id, timeoutMs = 20000) {
    this.sent.push(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(this.label + ' 回包超时 id=' + String(id)));
      }, timeoutMs);
      this.waiters.set(id, {
        timer,
        resolve: (reply) => {
          checks += 1;
          assert.equal(reply.id, id, this.label + ' 回包 id 不匹配：请求 ' + id + '，回包 ' + String(reply.id));
          resolve(reply);
        },
        reject,
      });
      try {
        this.proc.stdin.write(JSON.stringify(message) + '\n');
      } catch (err) {
        this.waiters.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  call(action, args = {}, timeoutMs = 20000) {
    return this.request('call', { action, arguments: args }, timeoutMs);
  }

  // 成功动作：返回 result.content 解析后的对象
  async callAction(action, args = {}, timeoutMs = 20000) {
    const reply = await this.call(action, args, timeoutMs);
    check(Boolean(reply.result) && typeof reply.result.content === 'string', action + ' 应返回 result.content 字符串（实际：' + JSON.stringify(reply.error || reply.result) + '）');
    let parsed;
    try {
      parsed = JSON.parse(reply.result.content);
    } catch (err) {
      check(false, action + ' 的 result.content 不是合法 JSON：' + err.message);
      throw err;
    }
    check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), action + ' 的 content 应是一个 JSON 对象');
    return parsed;
  }

  async expectError(action, args, code, why, pattern, timeoutMs = 20000) {
    const reply = await this.call(action, args, timeoutMs);
    check(Boolean(reply.error), why + '：应返回 error（实际 ' + JSON.stringify(reply.result) + '）');
    checkEqual(reply.error.code, code, why + '：错误码应为 ' + code + '（实际 ' + String(reply.error.code) + '：' + String(reply.error.message) + '）');
    check(typeof reply.error.message === 'string' && reply.error.message.length > 0, why + '：error.message 应为非空字符串');
    if (pattern) {
      check(pattern.test(reply.error.message), why + '：错误消息不符（实际：' + String(reply.error.message) + '）');
    }
    return reply.error;
  }

  writeRaw(text) {
    this.proc.stdin.write(text);
  }

  nextStray(timeoutMs = 20000) {
    if (this.strays.length > 0) return Promise.resolve(this.strays.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(this.label + ' 等待 id=null 回包超时')), timeoutMs);
      this.strayWaiters.push({
        timer,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
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

  endStdin() {
    try {
      this.proc.stdin.end();
    } catch {
      // 已关闭则忽略
    }
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

const INVALID_PROFILES = ['../x', 'a/b', '/etc', '..', '', '\u0000', 'x\u0000y', '\u0001'];

// index.js 由 plugin-core 提供；没有它就无法走生产代码路径。
if (!fs.existsSync(path.join(ROOT, 'index.js'))) {
  console.error('FAIL: 仓库缺少 index.js，无法启动真实插件子进程（测试本身按 docs/protocol.md 就绪）');
  process.exit(1);
}

// ---------- 场景 ----------

test('github-account-default 握手与错误路径', async () => {
  const guard = setTimeout(() => {
    console.error('FAIL: 握手测试总时长超过 180s');
    killAll();
    process.exit(1);
  }, 180000);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gqy-gh-handshake-'));
  // GQY_HOME 路径里带单引号：用来验证 env.exports 的 '\'' 转义（docs/protocol.md §5.5）
  const gqyHome = path.join(tempRoot, "gqy-home-'quote'");
  const home = path.join(tempRoot, 'home');
  fs.mkdirSync(gqyHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const env = childEnv({ HOME: home, GQY_HOME: gqyHome });
  let client = null;

  try {
    client = new Client('main', env);

    // 1. initialize
    const init = await client.request('initialize', { protocol: 'gqy-jsonrpc-v1' });
    check(init.result && typeof init.result === 'object', 'initialize 应返回 result 对象');
    checkEqual(init.result.ok, true, 'initialize 应返回 ok:true');
    checkEqual(init.result.name, PLUGIN_ID, 'initialize 返回的 name 不符');
    checkEqual(init.result.version, PLUGIN_VERSION, 'initialize 返回的 version 不符');

    // 2. status：默认 probe:false，不联网，字段齐全，路径都在临时 GQY_HOME 下
    const statusStarted = Date.now();
    const status = await client.callAction('status', {});
    const statusMs = Date.now() - statusStarted;
    checkEqual(status.plugin, PLUGIN_ID, 'status.plugin 不符');
    checkEqual(status.version, PLUGIN_VERSION, 'status.version 不符');
    checkEqual(status.host, 'github.com', 'status.host 默认应为 github.com');
    checkEqual(status.logged_in, false, '临时 GQY_HOME 里 status.logged_in 应为 false');
    checkEqual(status.account, null, '未登录时 status.account 应为 null');
    checkEqual(status.source, null, '未登录时 status.source 应为 null');
    check(Array.isArray(status.scopes), 'status.scopes 应为数组');
    check(Array.isArray(status.profiles) && status.profiles.length === 0, '临时 GQY_HOME 里 status.profiles 应为空数组');
    checkEqual(status.has_pending, false, '未登录时 status.has_pending 应为 false');
    checkEqual(status.pending, null, '未登录时 status.pending 应为 null');
    checkEqual(status.verified, null, 'status 默认 probe:false，verified 应为 null（不联网复核）');
    // probe 默认 false 时不应发起 GitHub API 调用（§5.1）；这里用 verified:null 作为确定性证据，
    // 时间上限只兜底「卡住」：真联网复核要等 api.github.com（超时 10s），5s 未返回即可判失败。
    check(statusMs < 5000, 'status(probe:false) 应在 5s 内返回（默认不联网，网络复核超时为 10s），实际 ' + statusMs + 'ms');

    check(typeof status.default_profile === 'string' && status.default_profile.trim().length > 0, 'status.default_profile 应为非空字符串');
    check(!status.default_profile.includes('/') && !status.default_profile.includes('\\'), 'status.default_profile 不得含路径分隔符');
    check(status.default_profile !== '.' && status.default_profile !== '..', 'status.default_profile 不得是 . 或 ..');
    checkEqual(status.profile, status.default_profile, '未指定 profile 时 status.profile 应等于 default_profile');
    check(typeof status.display_name === 'string' && status.display_name.trim().length > 0, 'status.display_name 应为非空字符串');
    check(typeof status.default_display_name === 'string' && status.default_display_name.trim().length > 0, 'status.default_display_name 应为非空字符串');
    checkEqual(status.default_display_name, status.display_name, '默认 profile 的 display_name 应等于 default_display_name');

    const expectedRoot = path.join(gqyHome, 'github');
    check(path.isAbsolute(String(status.root)), 'status.root 应为绝对路径');
    checkEqual(canonical(status.root), canonical(expectedRoot), 'status.root 应为 $GQY_HOME/github');
    check(isInside(gqyHome, status.root), 'status.root 应在临时 GQY_HOME 内');
    checkEqual(canonical(status.profile_dir), canonical(path.join(status.root, status.profile)), 'status.profile_dir 应为 <root>/<profile>');
    checkEqual(canonical(status.gh_config_dir), canonical(path.join(status.profile_dir, 'gh')), 'status.gh_config_dir 应为 <profile_dir>/gh');
    checkEqual(canonical(status.gitconfig), canonical(path.join(status.profile_dir, 'gitconfig')), 'status.gitconfig 应为 <profile_dir>/gitconfig');
    check(isInside(gqyHome, status.profile_dir), 'status.profile_dir 应在临时 GQY_HOME 内');
    check(isInside(gqyHome, status.gh_config_dir), 'status.gh_config_dir 应在临时 GQY_HOME 内');
    check(isInside(gqyHome, status.gitconfig), 'status.gitconfig 应在临时 GQY_HOME 内');

    check(status.tools && typeof status.tools === 'object', 'status.tools 应为对象');
    for (const tool of ['gh', 'git']) {
      const info = status.tools[tool];
      check(Boolean(info) && typeof info === 'object', 'status.tools.' + tool + ' 应为对象');
      check(typeof info.available === 'boolean', 'status.tools.' + tool + '.available 应为布尔');
      if (info.available) {
        check(typeof info.version === 'string' && info.version.trim().length > 0, 'status.tools.' + tool + '.version 在可用时应为非空字符串');
      }
    }

    check(status.isolated && typeof status.isolated === 'object', 'status.isolated 应为对象');
    checkEqual(canonical(status.isolated.root), canonical(status.root), 'status.isolated.root 应等于 status.root');
    checkEqual(status.isolated.outside_writes, false, 'status.isolated.outside_writes 应为 false');
    check(Object.prototype.hasOwnProperty.call(status, 'git'), 'status 应包含 git 字段（docs/protocol.md §5.1）');
    check(status.git === null || (typeof status.git === 'object' && !Array.isArray(status.git)), 'status.git 应为对象或 null');

    // 3. env：形状与 exports 的单引号转义
    const envResult = await client.callAction('env', {});
    checkEqual(envResult.profile, status.profile, 'env.profile 应等于 status.profile');
    check(typeof envResult.display_name === 'string' && envResult.display_name.trim().length > 0, 'env.display_name 应为非空字符串');
    checkEqual(envResult.host, 'github.com', 'env.host 默认应为 github.com');
    checkEqual(envResult.logged_in, false, '未登录时 env.logged_in 应为 false');
    checkEqual(envResult.login, null, '未登录时 env.login 应为 null');
    checkEqual(canonical(envResult.profile_dir), canonical(status.profile_dir), 'env.profile_dir 应与 status 一致');
    checkEqual(canonical(envResult.gh_config_dir), canonical(status.gh_config_dir), 'env.gh_config_dir 应与 status 一致');
    checkEqual(canonical(envResult.gitconfig), canonical(status.gitconfig), 'env.gitconfig 应与 status 一致');
    check(isInside(gqyHome, envResult.profile_dir), 'env.profile_dir 应在临时 GQY_HOME 内');

    check(envResult.env && typeof envResult.env === 'object', 'env.env 应为对象');
    checkDeep(
      Object.keys(envResult.env).sort(),
      ['GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'].sort(),
      'env.env 应只含 §5.5 规定的四个键'
    );
    checkEqual(envResult.env.GH_CONFIG_DIR, envResult.gh_config_dir, 'env.env.GH_CONFIG_DIR 应等于 env.gh_config_dir');
    checkEqual(envResult.env.GIT_CONFIG_GLOBAL, envResult.gitconfig, 'env.env.GIT_CONFIG_GLOBAL 应等于 env.gitconfig');
    checkEqual(envResult.env.GIT_CONFIG_NOSYSTEM, '1', 'env.env.GIT_CONFIG_NOSYSTEM 应为 "1"');
    checkEqual(envResult.env.GIT_TERMINAL_PROMPT, '0', 'env.env.GIT_TERMINAL_PROMPT 应为 "0"');

    check(typeof envResult.exports === 'string' && envResult.exports.length > 0, 'env.exports 应为非空字符串');
    // docs/protocol.md §5.5（21:23 版）：exports 每行都是 export KEY='值'，所有值一律单引号包裹
    // （含 1 / 0），值内部单引号转义为 '\''，保证可直接粘贴执行。
    const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
    const expectedExports = [
      'export GH_CONFIG_DIR=' + shellQuote(envResult.gh_config_dir),
      'export GIT_CONFIG_GLOBAL=' + shellQuote(envResult.gitconfig),
      "export GIT_CONFIG_NOSYSTEM='1'",
      "export GIT_TERMINAL_PROMPT='0'",
    ].join('\n');
    checkEqual(envResult.exports.trimEnd(), expectedExports, 'env.exports 应按 §5.5 输出（所有值单引号包裹、内部单引号转义）');
    const exportLines = envResult.exports.trimEnd().split('\n');
    checkEqual(exportLines.length, 4, 'env.exports 应有四行（四个环境变量）');
    for (const line of exportLines) {
      check(/^export [A-Z][A-Z0-9_]*='([\s\S]*)'$/.test(line), 'env.exports 每行都必须是 export KEY=\'值\'（实际：' + line + '）');
    }
    check(envResult.exports.includes("'\\''"), 'env.exports 应体现单引号转义（临时 GQY_HOME 路径含单引号）');
    check(typeof envResult.hint === 'string' && envResult.hint.trim().length > 0, 'env.hint 应为非空字符串');

    // 3b. 自定义 profile：slug 直接可用，路径加到 <root>/<profile>
    const customStatus = await client.callAction('status', { profile: 'custom-profile' });
    checkEqual(customStatus.profile, 'custom-profile', 'status 应接受合法 profile 名');
    checkEqual(canonical(customStatus.profile_dir), canonical(path.join(customStatus.root, 'custom-profile')), '自定义 profile 的 profile_dir 应为 <root>/custom-profile');
    check(isInside(gqyHome, customStatus.profile_dir), '自定义 profile 的路径应在临时 GQY_HOME 内');
    const customEnv = await client.callAction('env', { profile: 'custom-profile' });
    checkEqual(customEnv.profile, 'custom-profile', 'env 应接受合法 profile 名');
    check(isInside(gqyHome, customEnv.gh_config_dir), '自定义 profile 的 gh_config_dir 应在临时 GQY_HOME 内');

    // 4. logout 幂等（未登录、目录不存在也返回 logged-out）
    const firstLogout = await client.callAction('logout', {});
    checkEqual(firstLogout.state, 'logged-out', '未登录时 logout 应幂等返回 logged-out');
    checkEqual(firstLogout.profile, status.profile, 'logout.profile 应等于默认 profile');
    check(Array.isArray(firstLogout.removed), 'logout.removed 应为数组');
    checkEqual(firstLogout.removed.length, 0, '未登录且无目录时 logout.removed 应为空数组');
    checkEqual(firstLogout.purged, false, '未 purge 时 logout.purged 应为 false');
    const secondLogout = await client.callAction('logout', {});
    checkEqual(secondLogout.state, 'logged-out', '重复 logout 应幂等返回 logged-out');
    checkEqual(secondLogout.removed.length, 0, '重复 logout 的 removed 应为空数组');
    const customLogout = await client.callAction('logout', { profile: 'custom-profile' });
    checkEqual(customLogout.state, 'logged-out', '自定义 profile 的 logout 应幂等');
    checkEqual(customLogout.profile, 'custom-profile', '自定义 profile 的 logout.profile 不符');

    // 5. login-wait：没有进行中的登录 → missing（不报错）
    const waitMissing = await client.callAction('login-wait', { wait_s: 1 });
    checkEqual(waitMissing.state, 'missing', '没有 pending 时 login-wait 应返回 missing');
    check(typeof waitMissing.hint === 'string' && waitMissing.hint.length > 0, 'login-wait missing 应带 hint');

    // 6. 未知动作 / 未知方法 → -32601
    await client.expectError('nope', {}, -32601, '未知动作应返回 -32601', /未知动作|unknown/i);
    const unknownMethod = await client.request('no_such_method', {});
    check(Boolean(unknownMethod.error), '未知方法应返回 error');
    checkEqual(unknownMethod.error.code, -32601, '未知方法应返回 -32601');
    check(/未知方法|unknown/i.test(String(unknownMethod.error.message)), '未知方法的 error.message 应说明方法未知');

    // 7. 非法 JSON → -32700 且 id:null；非对象 / 缺 method / method 非字符串 → -32600
    client.writeRaw('{not json}\n');
    const badJson = await client.nextStray();
    checkEqual(badJson.id, null, '非法 JSON 的回包 id 应为 null');
    checkEqual(badJson.error && badJson.error.code, -32700, '非法 JSON 应返回 -32700');
    client.writeRaw('[1,2,3]\n');
    const badRequest = await client.nextStray();
    check(badRequest.id === null || badRequest.id === undefined, '非对象请求的回包 id 应为 null');
    checkEqual(badRequest.error && badRequest.error.code, -32600, '非对象请求应返回 -32600');
    const missingMethod = await client.sendObject({ jsonrpc: '2.0', id: 9001 }, 9001);
    checkEqual(missingMethod.error && missingMethod.error.code, -32600, '缺 method 的请求应返回 -32600');
    const badMethodType = await client.sendObject({ jsonrpc: '2.0', id: 9002, method: 123 }, 9002);
    checkEqual(badMethodType.error && badMethodType.error.code, -32600, 'method 非字符串的请求应返回 -32600');
    // 非法请求之后进程仍可服务
    const afterBadJson = await client.callAction('status', {});
    checkEqual(afterBadJson.plugin, PLUGIN_ID, '非法请求之后进程应继续服务');

    // 8. profile 非法 → -32602（逐项）
    for (const bad of INVALID_PROFILES) {
      const label = JSON.stringify(bad);
      await client.expectError('status', { profile: bad }, -32602, 'status profile=' + label + ' 应返回 -32602', /profile/i);
    }
    await client.expectError('env', { profile: '../x' }, -32602, 'env profile=../x 应返回 -32602', /profile/i);
    await client.expectError('logout', { profile: 'a/b' }, -32602, 'logout profile=a/b 应返回 -32602', /profile/i);
    await client.expectError('gh', { profile: '/etc', args: ['--version'] }, -32602, 'gh profile=/etc 应返回 -32602', /profile/i);
    await client.expectError('git', { profile: '..', args: ['--version'] }, -32602, 'git profile=.. 应返回 -32602', /profile/i);
    await client.expectError('login-wait', { profile: '', wait_s: 1 }, -32602, 'login-wait profile="" 应返回 -32602', /profile/i);
    await client.expectError('status', { profile: 42 }, -32602, 'status profile 非字符串应返回 -32602', /profile/i);

    // 9. wait_s 越界 / 类型错 → -32602
    await client.expectError('login-wait', { wait_s: 0 }, -32602, 'wait_s=0 应返回 -32602', /wait_s/);
    await client.expectError('login-wait', { wait_s: 91 }, -32602, 'wait_s=91 应返回 -32602', /wait_s/);
    await client.expectError('login-wait', { wait_s: 2.5 }, -32602, 'wait_s=2.5 应返回 -32602', /wait_s/);
    await client.expectError('login-wait', { wait_s: '5' }, -32602, 'wait_s 字符串应返回 -32602', /wait_s/);

    // 10. args 形状错 → -32602；参数本身合法但未登录 → -32000
    await client.expectError('gh', { args: [] }, -32602, 'gh args 空数组应返回 -32602', /args/);
    await client.expectError('gh', { args: ['a\u0000b'] }, -32602, 'gh args 含 NUL 应返回 -32602', /args/);
    await client.expectError('gh', { args: 'api user' }, -32602, 'gh args 非数组应返回 -32602', /args/);
    await client.expectError('gh', { args: [42] }, -32602, 'gh args 非字符串项应返回 -32602', /args/);
    await client.expectError('git', { args: [] }, -32602, 'git args 空数组应返回 -32602', /args/);
    await client.expectError('git', { args: ['x\u0000'] }, -32602, 'git args 含 NUL 应返回 -32602', /args/);
    await client.expectError('gh', { args: Array.from({ length: 65 }, (__, index) => 'a' + index) }, -32602, 'gh args 超过 64 项应返回 -32602', /args/);
    await client.expectError('gh', { args: ['--version'] }, -32000, '未登录时 gh 应返回 -32000', /未登录/);
    await client.expectError('git', { args: ['--version'] }, -32000, '未登录时 git 应返回 -32000', /未登录/);

    // 11. login 参数形状 → -32602
    await client.expectError('login', {}, -32602, 'login 缺 route 应返回 -32602', /route/);
    await client.expectError('login', { route: 'ssh' }, -32602, 'login route=ssh 应返回 -32602', /route/);
    await client.expectError('login', { route: '' }, -32602, 'login route="" 应返回 -32602', /route/);
    await client.expectError('login', { route: 42 }, -32602, 'login route 非字符串应返回 -32602', /route/);
    await client.expectError('login', { route: 'token' }, -32602, 'login route=token 缺 token 应返回 -32602', /token/);
    await client.expectError('login', { route: 'token', token: '' }, -32602, 'login token 空串应返回 -32602', /token/);
    await client.expectError('login', { route: 'token', token: 42 }, -32602, 'login token 非字符串应返回 -32602', /token/);
    await client.expectError('login', { route: 'import' }, -32602, 'login route=import 缺 path 应返回 -32602', /path/);
    await client.expectError('login', { route: 'import', path: '' }, -32602, 'login path 空串应返回 -32602', /path/);
    await client.expectError('login', { route: 'import', path: path.join(tempRoot, 'missing-dir') }, -32602, 'login path 不存在应返回 -32602', /path/);
    await client.expectError('login', { route: 'device', client_id: 42 }, -32602, 'device client_id 非字符串应返回 -32602', /client_id/);

    // 12. status / logout 参数类型 → -32602
    await client.expectError('status', { probe: 'yes' }, -32602, 'status probe 非布尔应返回 -32602', /probe/);
    await client.expectError('logout', { purge: 'yes' }, -32602, 'logout purge 非布尔应返回 -32602', /purge/);

    // 13. device 路径缺 client_id：业务错误 -32000（不得联网；环境里没给 client_id/client.json）
    const deviceReply = await client.call('login', { route: 'device' }, 25000);
    check(Boolean(deviceReply.error), '缺 client_id 的 device 登录应返回 error');
    checkEqual(deviceReply.error.code, -32000, '缺 client_id 应返回 -32000（docs/protocol.md §5.2）');

    // 14. shutdown → ok:true，进程 0 退出，stdout 无残留半行
    const shutdown = await client.request('shutdown', {});
    check(shutdown.result && shutdown.result.ok === true, 'shutdown 应返回 ok:true');
    const exitInfo = await client.waitExit(5000);
    checkEqual(exitInfo.code, 0, 'shutdown 后进程应以 0 退出（实际 ' + JSON.stringify(exitInfo) + '）');
    checkEqual(client.buf.trim(), '', '退出时 stdout 不应残留半行');
    checkEqual(client.waiters.size, 0, 'shutdown 后不应有未回包请求');

    // 不应出现未请求或重复回包
    checkEqual(client.violations.length, 0, '不应出现未请求或重复的回包：' + JSON.stringify(client.violations).slice(0, 400));

    // 请求与回包 id 一一对应（含两条 id:null 的非法请求回包）
    const repliedIds = client.received.filter((message) => message.id !== null && message.id !== undefined).map((message) => message.id);
    checkEqual(repliedIds.length, client.sent.length, '回包数量应与请求数量一致');
    checkEqual(new Set(repliedIds).size, repliedIds.length, '回包 id 不应重复');
    const sentSorted = client.sent.slice().sort((a, b) => a - b);
    const repliedSorted = repliedIds.slice().sort((a, b) => a - b);
    checkDeep(repliedSorted, sentSorted, '回包 id 应与请求 id 一一对应');
    const strayCount = client.received.filter((message) => message.id === null || message.id === undefined).length;
    checkEqual(strayCount, 2, '应恰好收到 2 个 id:null 回包（非法 JSON + 非对象请求）');

    // 15. 只关 stdin（EOF）也能在 5s 内自退（04 P8 第一道防线）
    const eofClient = new Client('eof', env);
    const eofInit = await eofClient.request('initialize', { protocol: 'gqy-jsonrpc-v1' });
    checkEqual(eofInit.result && eofInit.result.name, PLUGIN_ID, 'EOF 用例的 initialize 应成功');
    eofClient.endStdin();
    const eofExit = await eofClient.waitExit(5000);
    checkEqual(eofExit.code, 0, '只关 stdin 后进程应以 0 在 5s 内自退（实际 ' + JSON.stringify(eofExit) + '）');
    checkEqual(eofClient.buf.trim(), '', 'EOF 自退时 stdout 不应残留半行');
  } catch (err) {
    for (const item of clients) item.dumpStderr();
    throw err;
  } finally {
    killAll();
    clearTimeout(guard);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('OK: 握手与错误路径测试通过（initialize/status/env/logout/login-wait/错误码/shutdown/EOF 自退，' + checks + ' 项检查）');
});
