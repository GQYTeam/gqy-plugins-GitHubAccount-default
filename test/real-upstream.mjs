#!/usr/bin/env node
// GQY github-account-default 插件「真实上游」用例（零依赖，走生产代码路径）。
//
// 触发条件（两者都没有则 SKIP 并 0 退出，CI 无令牌时必须跳过而不是失败）：
//   GQY_GITHUB_TEST_TOKEN  —— 真令牌；
//   GQY_GITHUB_TEST_LAYOUT —— 参考布局目录（含 account.json 与 gh/），
//                             令牌只在内存里从 <LAYOUT>/gh/hosts.yml 解析。
// 令牌纪律：只从环境变量 / 参考布局读，绝不打日志、绝不写进仓库、绝不写进断言消息；
//          也不用 `gh auth token` 取令牌。所有断言消息都不回显令牌。
//
// 主链：login route=token → status probe=true（verified 与令牌响应一致）→ env 形状
//       → gh ["api","user","--jq",".login"] 等于登录名 → git ["config","--global","user.name"] 非空
//       → logout → status logged_in:false；给了 LAYOUT 再加 login route=import 与 probe 复核。
// 额外探针：device 缺 client_id（不联网，-32000 且消息含 client_id）；device 用无效 client_id
//           （应走到上游 404，-32000）；PATH 有 gh 时 login route=gh 拿真实设备码（pending），
//           随后 logout purge 收尾，并断言 shutdown 后 5s 内不残留 `gh auth login` 子进程。
// 网络不可达（DNS / 连接失败）时打印 SKIP 并 0 退出；401/403/协议错误算 FAIL。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGIN_ID = 'github-account-default';
const PLUGIN_VERSION = '1.0.0';
// docs/protocol.md §8 的脱敏模式，用于反向断言结果里没有令牌。
const TOKEN_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{16,}/, /github_pat_[A-Za-z0-9_]{16,}/];
// 网络层不可达（环境问题 → SKIP）。401/403/协议错误不在此列（算 FAIL）。
const NETWORK_FAILURE_PATTERNS = [
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /getaddrinfo/i,
  /fetch failed/i,
  /network error/i,
  /网络不可达/,
  /网络不可用/,
  /网络异常/,
  /连接失败/,
  /无法连接/,
  /连不上/,
];
const clients = [];
let checks = 0;
let tempRoot = null;
let ghBaselinePids = null;
let ghAvailableSummary = false;
let gitAvailableSummary = false;
// 一旦有真实网络调用成功，后续再遇网络错误就不再当「环境无网」跳过，而是 FAIL（区分环境与实现）。
let networkProven = false;

const ENV_TOKEN = (process.env.GQY_GITHUB_TEST_TOKEN || '').trim();
const LAYOUT_DIR = (process.env.GQY_GITHUB_TEST_LAYOUT || '').trim();

// ---------- 令牌与参考布局（只读内存，不落盘、不回显） ----------

// 从 gh/hosts.yml 里取令牌：优先主机段顶层 oauth_token，其次 users.<user>.oauth_token。
function parseHostsToken(text) {
  const rows = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => ({ indent: line.length - line.trimStart().length, trimmed: line.trim() }));
  const tokens = [];
  for (const row of rows) {
    const match = /^oauth_token\s*:\s*(.+)$/.exec(row.trimmed);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    if (value) tokens.push({ indent: row.indent, value });
  }
  if (tokens.length === 0) return '';
  // 缩进最小的那一个就是主机段顶层的 oauth_token；否则退化为 users.<user>.oauth_token。
  tokens.sort((left, right) => left.indent - right.indent);
  return tokens[0].value;
}

function readLayout() {
  const dir = path.resolve(LAYOUT_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: '目录不存在：' + dir };
  const accountPath = path.join(dir, 'account.json');
  const hostsPath = path.join(dir, 'gh', 'hosts.yml');
  if (!fs.existsSync(accountPath)) return { error: '缺少 account.json：' + accountPath };
  if (!fs.existsSync(path.join(dir, 'gh'))) return { error: '缺少 gh/ 目录：' + dir };
  if (!fs.existsSync(hostsPath)) return { error: '缺少 gh/hosts.yml：' + hostsPath };
  let account;
  try {
    account = JSON.parse(fs.readFileSync(accountPath, 'utf8'));
  } catch (err) {
    return { error: 'account.json 不是合法 JSON：' + err.message };
  }
  const token = parseHostsToken(fs.readFileSync(hostsPath, 'utf8'));
  if (typeof account.login !== 'string' || !account.login) return { error: 'account.json.login 应为非空字符串' };
  if (!Number.isInteger(account.id)) return { error: 'account.json.id 应为整数' };
  if (!token) return { error: '未能从 gh/hosts.yml 解析出 oauth_token' };
  return { dir, account, token, accountPath, hostsPath };
}

if (!ENV_TOKEN && !LAYOUT_DIR) {
  console.log('SKIP: 未提供 GQY_GITHUB_TEST_TOKEN / GQY_GITHUB_TEST_LAYOUT');
  process.exit(0);
}

const layout = LAYOUT_DIR ? readLayout() : null;
if (layout && layout.error) {
  console.error('FAIL: GQY_GITHUB_TEST_LAYOUT 不可用：' + layout.error);
  process.exit(1);
}
const TOKEN = ENV_TOKEN || (layout ? layout.token : '');
if (!TOKEN) {
  console.error('FAIL: 未拿到令牌（GQY_GITHUB_TEST_TOKEN 为空，参考布局也没解析出 oauth_token）');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'index.js'))) {
  console.error('FAIL: 仓库缺少 index.js，无法启动真实插件子进程（测试本身按 docs/protocol.md 就绪）');
  process.exit(1);
}

// ---------- 断言助手 ----------

function check(cond, message) {
  checks += 1;
  assert.ok(cond, message);
}

function checkEqual(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
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

function checkMode(abs, expected, message) {
  const mode = fs.statSync(abs).mode & 0o777;
  checkEqual(mode.toString(8), expected.toString(8), message + '（实际 ' + mode.toString(8) + '）');
}

// 递归快照（相对路径 → 类型 / 大小 / 权限 / mtime），用于断言 import 只读源目录。
function snapshotTree(root) {
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

function diffSnapshot(before, after) {
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
  return { added, removed, changed };
}

function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

// 断言文本里既没有令牌原文，也没有令牌形状的字符串（失败消息不回显匹配内容）。
function assertNoToken(text, where) {
  const value = String(text);
  checks += 1;
  assert.ok(!value.includes(TOKEN), where + ' 出现令牌原文（不打印令牌内容）');
  for (const pattern of TOKEN_PATTERNS) {
    checks += 1;
    assert.ok(!pattern.test(value), where + ' 出现令牌形状字符串（不打印匹配内容）');
  }
}

function isNetworkFailure(message) {
  const text = String(message || '');
  return NETWORK_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

// 分类器自检：只有环境级网络故障才 SKIP，401/403 等实现/凭据问题必须 FAIL。
assert.equal(isNetworkFailure('getaddrinfo ENOTFOUND api.github.com'), true, '网络故障分类器应识别 DNS 失败');
assert.equal(isNetworkFailure('connect ECONNREFUSED 140.82.121.6:443'), true, '网络故障分类器应识别连接失败');
assert.equal(isNetworkFailure('令牌无效或已过期（GitHub 返回 401）'), false, '401 不得被当作网络故障跳过');
assert.equal(isNetworkFailure('GitHub API 限流（403）'), false, '403 不得被当作网络故障跳过');
assert.equal(isNetworkFailure('无法解析的响应'), false, '协议错误不得被当作网络故障跳过');

// ---------- 清理 ----------

function newGhAuthLoginPids() {
  const current = listGhAuthLoginPids();
  if (current === null || ghBaselinePids === null) return [];
  return [...current].filter((pid) => !ghBaselinePids.has(pid));
}

function cleanupAll() {
  for (const client of clients) client.kill();
  // 只清理本测试新起的 gh auth login（plugin-core 若漏回收，兜底不污染本机）
  for (let round = 0; round < 3; round += 1) {
    const pids = newGhAuthLoginPids();
    if (pids.length === 0) break;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已退出则忽略
      }
    }
    sleepSync(200);
  }
  if (tempRoot) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言结论
    }
  }
}

function skipNetwork(reason) {
  console.log('SKIP: 网络不可达，跳过真实上游用例（' + reason + '）');
  cleanupAll();
  process.exit(0);
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

  request(method, params = {}, timeoutMs = 130000) {
    const id = this.nextId++;
    this.sent.push(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(this.label + ' 回包超时 id=' + id + '（实现可能卡住，非环境网络问题）'));
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

  waitExit(timeoutMs = 10000) {
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
    // 只打印元信息：先做令牌断言，绝不再输出可能含令牌的原文
    if (this.stderr.includes(TOKEN)) return;
    const text = this.stderr.trim();
    if (text) console.error('[' + this.label + ' stderr]\n' + text.slice(-2000));
  }
}

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

// ---------- 真实上游调用助手 ----------

async function requestCall(client, action, args, timeoutMs) {
  const reply = await client.request('call', { action, arguments: args }, timeoutMs);
  assertNoToken(JSON.stringify(reply), action + ' 的回包');
  return reply;
}

async function callOk(client, action, args, why, timeoutMs = 130000, allowNetworkSkip = false) {
  const reply = await requestCall(client, action, args, timeoutMs);
  if (reply.error) {
    if (allowNetworkSkip && !networkProven && reply.error.code === -32000 && isNetworkFailure(reply.error.message)) {
      skipNetwork(action + ' 上游不可达：' + String(reply.error.message));
    }
    check(false, why + ' 应成功（实际错误 ' + String(reply.error.code) + '：' + String(reply.error.message) + '）');
  }
  check(Boolean(reply.result) && typeof reply.result.content === 'string', why + ' 应返回 result.content 字符串');
  try {
    return JSON.parse(reply.result.content);
  } catch (err) {
    check(false, why + ' 的 result.content 不是合法 JSON：' + err.message);
    throw err;
  }
}

async function callErr(client, action, args, code, why, pattern, timeoutMs = 130000, allowNetworkSkip = false) {
  const reply = await requestCall(client, action, args, timeoutMs);
  check(Boolean(reply.error), why + '：应返回 error（实际 ' + JSON.stringify(reply.result) + '）');
  if (reply.error && allowNetworkSkip && !networkProven && reply.error.code === -32000 && isNetworkFailure(reply.error.message)) {
    skipNetwork(action + ' 上游不可达：' + String(reply.error.message));
  }
  checkEqual(reply.error.code, code, why + '：错误码应为 ' + code + '（实际 ' + String(reply.error.code) + '：' + String(reply.error.message) + '）');
  if (pattern) check(pattern.test(reply.error.message), why + '：错误消息不符（实际：' + String(reply.error.message) + '）');
  return reply.error;
}

// ---------- 本机 gh auth login 进程探测（残留自检） ----------

function listGhAuthLoginPids() {
  const result = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const pids = new Set();
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    if (/(^|\/)gh\s+auth\s+login(\s|$)/.test(match[2])) pids.add(Number(match[1]));
  }
  return pids;
}

async function waitNoNewGhProcesses(baseline, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = listGhAuthLoginPids();
    if (current === null) return { supported: false, leftover: [] };
    const leftover = [...current].filter((pid) => !baseline.has(pid));
    if (leftover.length === 0) return { supported: true, leftover: [] };
    if (Date.now() >= deadline) return { supported: true, leftover };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// ---------- 场景 ----------

test('github-account-default 真实上游用例', async () => {
  const guard = setTimeout(() => {
    console.error('FAIL: 真实上游用例总时长超过 300s');
    cleanupAll();
    process.exit(1);
  }, 300000);

  ghBaselinePids = listGhAuthLoginPids();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gqy-gh-real-'));
  const gqyHome = path.join(tempRoot, 'gqy-home');
  const home = path.join(tempRoot, 'home');
  fs.mkdirSync(gqyHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const env = childEnv({ HOME: home, GQY_HOME: gqyHome });
  const client = new Client('real', env);
  const profileToken = 'real-token';
  const profileGh = 'real-gh';
  const profileImport = 'real-import';

  try {
    const init = await client.request('initialize', { protocol: 'gqy-jsonrpc-v1' });
    checkEqual(init.result && init.result.ok, true, 'initialize 应返回 ok:true');
    checkEqual(init.result && init.result.name, PLUGIN_ID, 'initialize 返回的 name 不符');
    checkEqual(init.result && init.result.version, PLUGIN_VERSION, 'initialize 返回的 version 不符');

    // 0) device 缺 client_id：不联网、-32000、消息必须指出 client_id（docs/protocol.md §5.2）
    const noClientId = await callErr(
      client,
      'login',
      { route: 'device' },
      -32000,
      'device 路径缺 client_id 应返回 -32000',
      /client_id/i
    );
    check(/client_id/i.test(noClientId.message), 'device 缺 client_id 的错误消息应含 client_id');

    // 1) login route=token（真令牌；网络不可达则 SKIP）
    const tokenLogin = await callOk(
      client,
      'login',
      { route: 'token', token: TOKEN, profile: profileToken },
      'login route=token',
      130000,
      true
    );
    networkProven = true;
    checkEqual(tokenLogin.state, 'ready', 'token 登录应返回 state:ready');
    checkEqual(tokenLogin.route, 'token', 'token 登录应回 route:token');
    checkEqual(tokenLogin.profile, profileToken, 'token 登录应回请求的 profile');
    checkEqual(tokenLogin.source, 'token', 'token 登录的 source 应为 token');
    checkEqual(tokenLogin.host, 'github.com', 'token 登录的 host 应为 github.com');
    check(typeof tokenLogin.login === 'string' && tokenLogin.login.length > 0, 'token 登录应返回非空 login');
    check(Number.isInteger(tokenLogin.id) && tokenLogin.id > 0, 'token 登录应返回整数 id');
    check(Array.isArray(tokenLogin.scopes), 'token 登录应返回 scopes 数组');
    check(Boolean(tokenLogin.config) && typeof tokenLogin.config === 'object', 'login ready 应返回 config（docs/protocol.md §5.3）');
    const login = tokenLogin.login;
    const accountId = tokenLogin.id;
    if (tokenLogin.config) {
      check(isInside(gqyHome, tokenLogin.config.profile_dir), '登录后的 profile_dir 应在临时 GQY_HOME 内');
      checkEqual(canonical(tokenLogin.config.gh_config_dir), canonical(path.join(tokenLogin.config.profile_dir, 'gh')), 'gh_config_dir 应为 <profile_dir>/gh');
      checkEqual(canonical(tokenLogin.config.gitconfig), canonical(path.join(tokenLogin.config.profile_dir, 'gitconfig')), 'gitconfig 应为 <profile_dir>/gitconfig');
      check(fs.existsSync(tokenLogin.config.account_json), '登录后应写出 account.json');
    }

    // 2) 落盘检查：hosts.yml 0600 含令牌（断言只回答布尔，不打印内容）；profile.json 不得含令牌
    const profileDir = tokenLogin.config ? tokenLogin.config.profile_dir : path.join(gqyHome, 'github', profileToken);
    const ghConfigDir = path.join(profileDir, 'gh');
    const hostsPath = path.join(ghConfigDir, 'hosts.yml');
    check(fs.existsSync(hostsPath), '登录后应写出 gh/hosts.yml');
    if (fs.existsSync(hostsPath)) {
      checkMode(hostsPath, 0o600, 'gh/hosts.yml 权限应为 0600（docs/protocol.md §2）');
      const hostsText = fs.readFileSync(hostsPath, 'utf8');
      checks += 1;
      assert.ok(hostsText.includes(TOKEN), 'gh/hosts.yml 应保存令牌（断言不打印内容）');
      check(hostsText.includes('github.com'), 'gh/hosts.yml 应包含 github.com 主机段');
      check(hostsText.includes('oauth_token'), 'gh/hosts.yml 应包含 oauth_token 字段');
      check(hostsText.includes(login), 'gh/hosts.yml 的 user 应为登录名');
      // 去掉令牌本身后，hosts.yml 其它部分也不应再出现令牌形状（防重复落盘 / 日志混入）
      assertNoToken(hostsText.split(TOKEN).join(''), 'gh/hosts.yml 除令牌外的部分');
    }
    checkMode(profileDir, 0o700, 'profile 目录权限应为 0700（docs/protocol.md §2）');
    const accountPath = path.join(profileDir, 'account.json');
    check(fs.existsSync(accountPath), '登录后应写出 account.json');
    if (fs.existsSync(accountPath)) {
      checkMode(accountPath, 0o600, 'account.json 权限应为 0600');
      const account = JSON.parse(fs.readFileSync(accountPath, 'utf8'));
      checkEqual(account.login, login, 'account.json.login 应与登录响应一致');
      checkEqual(account.id, accountId, 'account.json.id 应与登录响应一致');
    }
    const profileJsonPath = path.join(profileDir, 'profile.json');
    check(fs.existsSync(profileJsonPath), '登录后应写出 profile.json');
    if (fs.existsSync(profileJsonPath)) {
      checkMode(profileJsonPath, 0o600, 'profile.json 权限应为 0600');
      const profileText = fs.readFileSync(profileJsonPath, 'utf8');
      checks += 1;
      assert.ok(!profileText.includes(TOKEN), 'profile.json 不得包含令牌（docs/protocol.md §7）');
      const profileJson = JSON.parse(profileText);
      checkEqual(profileJson.schema, 1, 'profile.json.schema 应为 1');
      checkEqual(profileJson.plugin, PLUGIN_ID, 'profile.json.plugin 应为插件 id');
      checkEqual(profileJson.profile, profileToken, 'profile.json.profile（显示名）应与请求一致');
      checkEqual(profileJson.slug, profileToken, 'profile.json.slug 应为规范化 slug');
      checkEqual(profileJson.login, login, 'profile.json.login 应与令牌响应一致');
      checkEqual(profileJson.id, accountId, 'profile.json.id 应与令牌响应一致');
      checkEqual(profileJson.source, 'token', 'profile.json.source 应为 token');
      checkEqual(profileJson.logged_in, true, 'profile.json.logged_in 应为 true');
      check(Array.isArray(profileJson.scopes), 'profile.json.scopes 应为数组');
    }
    const gitconfigPath = path.join(profileDir, 'gitconfig');
    check(fs.existsSync(gitconfigPath), '登录后应写出隔离 gitconfig');
    if (fs.existsSync(gitconfigPath)) {
      checkMode(gitconfigPath, 0o600, 'gitconfig 权限应为 0600');
      const gitconfigText = fs.readFileSync(gitconfigPath, 'utf8');
      checks += 1;
      assert.ok(!gitconfigText.includes(TOKEN), 'gitconfig 不得包含令牌');
      check(gitconfigText.includes('[user]'), '隔离 gitconfig 应包含 [user] 段');
      check(gitconfigText.includes('gh auth git-credential'), '隔离 gitconfig 应配置 gh 凭据助手（docs/protocol.md §7）');
      check(gitconfigText.includes(login), '隔离 gitconfig 的 user.name 缺省应为登录名');
    }
    const ghConfigYmlPath = path.join(ghConfigDir, 'config.yml');
    check(fs.existsSync(ghConfigYmlPath), '登录后应写出 gh/config.yml（docs/protocol.md §2/§7）');
    if (fs.existsSync(ghConfigYmlPath)) {
      const ghConfigText = fs.readFileSync(ghConfigYmlPath, 'utf8');
      check(/version:\s*1/.test(ghConfigText), 'gh/config.yml 应包含 version: 1');
      check(/git_protocol:\s*https/.test(ghConfigText), 'gh/config.yml 的 git_protocol 应为 https');
    }

    // 3) status probe=true：verified 与令牌响应一致
    const probed = await callOk(
      client,
      'status',
      { profile: profileToken, probe: true },
      'status probe=true',
      130000,
      true
    );
    checkEqual(probed.plugin, PLUGIN_ID, 'status.plugin 不符');
    checkEqual(probed.logged_in, true, 'status.logged_in 应为 true');
    checkEqual(probed.source, 'token', 'status.source 应为 token');
    check(Boolean(probed.account) && probed.account.login === login, 'status.account.login 应与令牌响应一致');
    check(Boolean(probed.account) && probed.account.id === accountId, 'status.account.id 应与令牌响应一致');
    check(Boolean(probed.verified) && typeof probed.verified === 'object', 'probe=true 时 status.verified 应为对象');
    checkEqual(probed.verified && probed.verified.ok, true, 'probe=true 时 verified.ok 应为 true（令牌真实有效）');
    checkEqual(probed.verified && probed.verified.login, login, 'verified.login 应与令牌响应一致');
    checkEqual(probed.verified && probed.verified.id, accountId, 'verified.id 应与令牌响应一致');
    check(/^\d{4}-\d{2}-\d{2}T/.test(String(probed.verified && probed.verified.checked_at)), 'verified.checked_at 应为 RFC3339 时间');
    check(Array.isArray(probed.profiles) && probed.profiles.some((item) => item.profile === profileToken), 'status.profiles 应包含当前 profile');
    checkEqual(probed.isolated && probed.isolated.outside_writes, false, 'status.isolated.outside_writes 应为 false');

    const ghAvailable = Boolean(probed.tools && probed.tools.gh && probed.tools.gh.available === true);
    const gitAvailable = Boolean(probed.tools && probed.tools.git && probed.tools.git.available === true);
    ghAvailableSummary = ghAvailable;
    gitAvailableSummary = gitAvailable;

    // 4) env 形状
    const envOut = await callOk(client, 'env', { profile: profileToken }, 'env', 130000, true);
    checkEqual(envOut.profile, profileToken, 'env.profile 不符');
    checkEqual(envOut.logged_in, true, 'env.logged_in 应为 true');
    checkEqual(envOut.login, login, 'env.login 应与登录名一致');
    checkEqual(envOut.host, 'github.com', 'env.host 应为 github.com');
    check(isInside(gqyHome, envOut.profile_dir), 'env.profile_dir 应在临时 GQY_HOME 内');
    check(isInside(gqyHome, envOut.gh_config_dir), 'env.gh_config_dir 应在临时 GQY_HOME 内');
    check(isInside(gqyHome, envOut.gitconfig), 'env.gitconfig 应在临时 GQY_HOME 内');
    checkEqual(envOut.env && envOut.env.GH_CONFIG_DIR, envOut.gh_config_dir, 'env.GH_CONFIG_DIR 应为隔离 gh 目录');
    checkEqual(envOut.env && envOut.env.GIT_CONFIG_GLOBAL, envOut.gitconfig, 'env.GIT_CONFIG_GLOBAL 应为隔离 gitconfig');
    checkEqual(envOut.env && envOut.env.GIT_CONFIG_NOSYSTEM, '1', 'env.GIT_CONFIG_NOSYSTEM 应为 "1"');
    checkEqual(envOut.env && envOut.env.GIT_TERMINAL_PROMPT, '0', 'env.GIT_TERMINAL_PROMPT 应为 "0"');
    const exportLines = String(envOut.exports || '').split('\n').filter((line) => line.trim().length > 0);
    checkEqual(exportLines.length, 4, 'env.exports 应有四行');
    for (const line of exportLines) {
      check(/^export [A-Z][A-Z0-9_]*='([\s\S]*)'$/.test(line), 'env.exports 每行都必须是 export KEY=\'值\'（§5.5：所有值单引号）');
    }

    // 5) gh 动作：真实上游取登录名
    if (ghAvailable) {
      const ghUser = await callOk(
        client,
        'gh',
        { profile: profileToken, args: ['api', 'user', '--jq', '.login'] },
        'gh api user --jq .login',
        130000,
        true
      );
      checkEqual(ghUser.tool, 'gh', 'gh 动作应回 tool:gh');
      checkEqual(ghUser.exit_code, 0, 'gh api user 应 0 退出');
      checkEqual(String(ghUser.stdout).trim(), login, 'gh 动作 stdout 应等于登录名');
      checkEqual(ghUser.timed_out, false, 'gh 动作不应超时');
      check(Boolean(ghUser.truncated) && ghUser.truncated.stdout === false && ghUser.truncated.stderr === false, 'gh 动作不应截断输出');
      check(typeof ghUser.duration_ms === 'number' && ghUser.duration_ms >= 0, 'gh 动作应返回 duration_ms');
      await callErr(
        client,
        'gh',
        { profile: profileToken, args: ['auth', 'token'] },
        -32000,
        'gh auth token 必须被拒绝',
        /不通过插件取令牌/
      );
    } else {
      console.log('NOTE: 本机 PATH 无 gh（status.tools.gh.available=false），跳过 gh 动作真实上游断言');
    }

    // 6) git 动作：隔离 git 配置里的提交身份
    if (gitAvailable) {
      const gitName = await callOk(
        client,
        'git',
        { profile: profileToken, args: ['config', '--global', 'user.name'] },
        'git config --global user.name',
        130000,
        true
      );
      checkEqual(gitName.tool, 'git', 'git 动作应回 tool:git');
      checkEqual(gitName.exit_code, 0, 'git config --global user.name 应 0 退出');
      check(String(gitName.stdout).trim().length > 0, 'git 动作返回的 user.name 应非空');
      checkEqual(String(gitName.stdout).trim(), login, 'git user.name 缺省应等于登录名（docs/protocol.md §7）');
      checkEqual(gitName.timed_out, false, 'git 动作不应超时');
      await callErr(
        client,
        'git',
        { profile: profileToken, args: ['config', '--global', 'user.name'], cwd: path.join(tempRoot, 'missing-cwd') },
        -32602,
        'git cwd 不存在应返回 -32602',
        /cwd/i
      );
    } else {
      console.log('NOTE: 本机 PATH 无 git（status.tools.git.available=false），跳过 git 动作真实上游断言');
    }

    // 7) device 用无效 client_id：必须真的走到上游（404 → -32000），不能是本地缺参短路
    const badDevice = await callErr(
      client,
      'login',
      { route: 'device', client_id: '00000000000000000000' },
      -32000,
      '无效 client_id 的 device 登录应由上游拒绝（-32000）',
      undefined,
      130000,
      true
    );
    networkProven = true;
    check(!/需要 client_id/.test(String(badDevice.message)), '无效 client_id 不应被当成「缺 client_id」短路（应走到上游 404）');

    // 8) login route=gh：真实设备码 pending（只取设备码，不授权），随后 logout purge 收尾
    let ghVerification = null;
    if (ghAvailable) {
      const ghPending = await callOk(
        client,
        'login',
        { route: 'gh', profile: profileGh },
        'login route=gh 应返回 pending',
        130000,
        true
      );
      checkEqual(ghPending.state, 'pending', 'gh 路径应返回 state:pending');
      checkEqual(ghPending.route, 'gh', 'gh 路径应回 route:gh');
      checkEqual(ghPending.profile, profileGh, 'gh 路径应回请求的 profile');
      check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(ghPending.user_code)), 'gh 设备码 user_code 应形如 XXXX-XXXX（实际 ' + String(ghPending.user_code) + '）');
      checkEqual(ghPending.verification_uri, 'https://github.com/login/device', 'gh 设备码 verification_uri 应为 https://github.com/login/device');
      checkEqual(ghPending.expires_in, 900, 'gh 路径 expires_in 应为 900');
      checkEqual(ghPending.interval, 5, 'gh 路径 interval 应为 5');
      ghVerification = ghPending.user_code;

      const ghStatus = await callOk(client, 'status', { profile: profileGh }, 'status（gh pending 中）', 130000, true);
      checkEqual(ghStatus.has_pending, true, 'gh pending 期间 status.has_pending 应为 true');
      checkEqual(ghStatus.pending && ghStatus.pending.user_code, ghVerification, 'status.pending.user_code 应与 login 返回一致');

      const purged = await callOk(client, 'logout', { profile: profileGh, purge: true }, 'logout purge=true', 130000, true);
      checkEqual(purged.state, 'logged-out', 'gh 收尾 logout 应返回 logged-out');
      checkEqual(purged.purged, true, 'gh 收尾 logout purge=true 应真的删掉 profile 目录');
      const afterPurge = await callOk(client, 'status', { profile: profileGh }, 'status（gh 收尾后）', 130000, true);
      checkEqual(afterPurge.has_pending, false, 'purge 后 status.has_pending 应为 false');
      checkEqual(afterPurge.logged_in, false, 'purge 后 status.logged_in 应为 false');
      check(!fs.existsSync(path.join(gqyHome, 'github', profileGh)), 'logout purge=true 后 profile 目录应被删除（docs/protocol.md §5.4）');
    } else {
      console.log('NOTE: 本机 PATH 无 gh，跳过 login route=gh 真实设备码断言');
    }

    // 9) logout → status logged_in:false
    const logout = await callOk(client, 'logout', { profile: profileToken }, 'logout', 130000, true);
    checkEqual(logout.state, 'logged-out', 'logout 应返回 logged-out');
    checkEqual(logout.profile, profileToken, 'logout.profile 不符');
    checkEqual(logout.purged, false, '非 purge 的 logout purged 应为 false');
    check(Array.isArray(logout.removed), 'logout.removed 应为数组');
    check(logout.removed.length > 0, '已登录状态 logout 的 removed 应列出被删条目（docs/protocol.md §5.4）');
    check(logout.removed.every((item) => typeof item === 'string' && item.length > 0), 'logout.removed 每项应为非空相对路径');
    // 落盘：hosts.yml 保留但不再含令牌；account.json 删除；profile.json 置 logged_in:false
    check(fs.existsSync(hostsPath), '非 purge 的 logout 应保留 gh/hosts.yml（docs/protocol.md §5.4）');
    if (fs.existsSync(hostsPath)) {
      const hostsAfterLogout = fs.readFileSync(hostsPath, 'utf8');
      checks += 1;
      assert.ok(!hostsAfterLogout.includes(TOKEN), 'logout 后 gh/hosts.yml 不得再含令牌');
      assertNoToken(hostsAfterLogout, 'logout 后的 gh/hosts.yml');
    }
    check(!fs.existsSync(path.join(profileDir, 'account.json')), 'logout 应删除 account.json');
    const profileJsonAfterLogout = path.join(profileDir, 'profile.json');
    check(fs.existsSync(profileJsonAfterLogout), '非 purge 的 logout 应保留 profile.json');
    if (fs.existsSync(profileJsonAfterLogout)) {
      const profileAfter = JSON.parse(fs.readFileSync(profileJsonAfterLogout, 'utf8'));
      checkEqual(profileAfter.logged_in, false, 'logout 后 profile.json 的 logged_in 应为 false');
      checks += 1;
      assert.ok(!fs.readFileSync(profileJsonAfterLogout, 'utf8').includes(TOKEN), 'logout 后 profile.json 不得含令牌');
    }
    const afterLogout = await callOk(client, 'status', { profile: profileToken }, 'status（logout 后）', 130000, true);
    checkEqual(afterLogout.logged_in, false, 'logout 后 status.logged_in 应为 false');
    checkEqual(afterLogout.account, null, 'logout 后 status.account 应为 null');
    checkEqual(afterLogout.verified, null, 'logout 后 status.verified 应为 null（未 probe）');

    // 10) login route=import（参考布局）：收养并核对 account.json
    if (layout) {
      const layoutBefore = snapshotTree(layout.dir);
      const imported = await callOk(
        client,
        'login',
        { route: 'import', path: layout.dir, profile: profileImport },
        'login route=import',
        130000,
        true
      );
      checkEqual(imported.state, 'ready', 'import 应返回 state:ready');
      checkEqual(imported.route, 'import', 'import 应回 route:import');
      checkEqual(imported.source, 'import', 'import 的 source 应为 import');
      checkEqual(imported.login, layout.account.login, 'import 后的 login 应与源 account.json 一致');
      checkEqual(imported.id, layout.account.id, 'import 后的 id 应与源 account.json 一致');
      check(Boolean(imported.config) && typeof imported.config === 'object', 'import ready 应返回 config');
      const importedDir = imported.config ? imported.config.profile_dir : path.join(gqyHome, 'github', profileImport);
      check(isInside(gqyHome, importedDir), 'import 后的 profile_dir 应在临时 GQY_HOME 内');
      check(fs.existsSync(importedDir), 'import 后 profile 目录应存在');
      if (fs.existsSync(importedDir)) checkMode(importedDir, 0o700, 'import 后的 profile 目录权限应为 0700');
      const importedAccountPath = path.join(importedDir, 'account.json');
      const importedHostsPath = path.join(importedDir, 'gh', 'hosts.yml');
      const importedGitconfigPath = path.join(importedDir, 'gitconfig');
      check(fs.existsSync(importedAccountPath), 'import 后应复制出 account.json');
      check(fs.existsSync(importedHostsPath), 'import 后应有 gh/hosts.yml');
      check(fs.existsSync(importedGitconfigPath), 'import 后应有 gitconfig');
      if (fs.existsSync(importedAccountPath)) checkMode(importedAccountPath, 0o600, 'import 后的 account.json 权限应为 0600');
      if (fs.existsSync(importedHostsPath)) checkMode(importedHostsPath, 0o600, 'import 后的 gh/hosts.yml 权限应为 0600');
      if (fs.existsSync(importedGitconfigPath)) checkMode(importedGitconfigPath, 0o600, 'import 后的 gitconfig 权限应为 0600');
      const importedAccount = JSON.parse(fs.readFileSync(importedAccountPath, 'utf8'));
      checkEqual(importedAccount.login, layout.account.login, '复制的 account.json.login 应与源一致');
      checkEqual(importedAccount.id, layout.account.id, '复制的 account.json.id 应与源一致');

      const importedProbed = await callOk(
        client,
        'status',
        { profile: profileImport, probe: true },
        'import 后 status probe=true',
        130000,
        true
      );
      checkEqual(importedProbed.verified && importedProbed.verified.ok, true, 'import 后 probe=true 应复核通过');
      checkEqual(importedProbed.verified && importedProbed.verified.login, layout.account.login, 'import 后 verified.login 应与源一致');
      checkEqual(importedProbed.account && importedProbed.account.login, layout.account.login, 'import 后 status.account.login 应与源一致');

      const layoutAfter = snapshotTree(layout.dir);
      const diff = diffSnapshot(layoutBefore, layoutAfter);
      checkEqual(diff.added.length, 0, 'import 不应在参考布局目录里新建文件');
      checkEqual(diff.removed.length, 0, 'import 不应删除参考布局目录里的文件');
      checkEqual(diff.changed.length, 0, 'import 不应修改参考布局目录里的文件（只读收养）');
    } else {
      console.log('NOTE: 未提供 GQY_GITHUB_TEST_LAYOUT，跳过 login route=import 真实上游断言');
    }

    // 11) 插件 stderr 不得含令牌（docs/protocol.md §8：只写 [github-account] <action> ok|fail <ms> 元信息）
    assertNoToken(client.stderr, '插件 stderr');
    for (const line of client.stderr.split('\n').filter((item) => item.trim().length > 0)) {
      check(!line.includes(TOKEN), '插件 stderr 单行不得含令牌');
      check(/^\[github-account\]/.test(line.trim()), '插件 stderr 应只写 [github-account] 元信息（实际：' + line.slice(0, 160) + '）');
    }

    // 12) shutdown：0 退出；不残留 gh auth login 子进程
    const shutdown = await client.request('shutdown', {});
    checkEqual(shutdown.result && shutdown.result.ok, true, 'shutdown 应返回 ok:true');
    const exitInfo = await client.waitExit(10000);
    checkEqual(exitInfo.code, 0, 'shutdown 后进程应以 0 退出（实际 ' + JSON.stringify(exitInfo) + '）');

    if (ghBaselinePids === null) {
      console.log('NOTE: 本机 ps 不可用，跳过 shutdown 后 gh auth login 残留自检');
    } else {
      const leftover = await waitNoNewGhProcesses(ghBaselinePids);
      if (!leftover.supported) {
        console.log('NOTE: 本机 ps 不可用，跳过 shutdown 后 gh auth login 残留自检');
      } else {
        checkEqual(
          leftover.leftover.length,
          0,
          'shutdown 后 5s 内不应残留 gh auth login 子进程（残留 pid：' + leftover.leftover.join(',') + '）'
        );
      }
    }
  } catch (err) {
    for (const item of clients) item.dumpStderr();
    throw err;
  } finally {
    clearTimeout(guard);
    cleanupAll();
  }

  console.log(
    'OK: 真实上游用例通过（token 登录 / status probe / env / ' +
      (ghAvailableSummary ? 'gh / ' : '') +
      (gitAvailableSummary ? 'git / ' : '') +
      'logout' +
      (layout ? ' / import' : '') +
      '，' +
      checks +
      ' 项检查）'
  );
});
