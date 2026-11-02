#!/usr/bin/env node
// GQY github-account-default 插件静态自检（零依赖）：
// 1) 按 GQY/docs/blueprint/plugin.md 的 manifest 全字段表校验 manifest.json
//    （id / name / version / description / protocol / command / cwd / timeout_ms /
//     concurrency / actions / provides / requires，动作集合恰为七个）；
// 2) 按 .standards/STANDARDS.md §1 校验仓库标准文件齐全；
// 3) 校验 package.json 的 test 串起四组测试、文档四件套齐全；
// 4) 扫描全仓（排除 .git / node_modules）确认没有令牌形状的字符串；
// 5) 校验 .gitignore 含 .DS_Store 与 node_modules。
// 失败打印全部问题并以 1 退出；成功打印一行 OK。
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGIN_ID = 'github-account-default';
const PLUGIN_VERSION = '1.0.0';
// 契约（docs/protocol.md §5）规定的动作集合。
const REQUIRED_ACTIONS = ['status', 'login', 'login-wait', 'logout', 'env', 'gh', 'git'];
// 契约 §5 规定的每个动作的 schema 形状（properties.type 与 required）。
const ACTION_SCHEMAS = {
  status: { required: [], properties: { profile: 'string', probe: 'boolean' } },
  login: {
    required: ['route'],
    properties: {
      route: 'string',
      profile: 'string',
      host: 'string',
      scopes: 'string',
      client_id: 'string',
      token: 'string',
      path: 'string',
      git_name: 'string',
      git_email: 'string',
      force: 'boolean',
    },
  },
  'login-wait': { required: [], properties: { profile: 'string', wait_s: 'integer' } },
  logout: { required: [], properties: { profile: 'string', purge: 'boolean' } },
  env: { required: [], properties: { profile: 'string' } },
  gh: { required: ['args'], properties: { args: 'array', profile: 'string', timeout_s: 'integer', stdin: 'string' } },
  git: { required: ['args'], properties: { args: 'array', profile: 'string', cwd: 'string', timeout_s: 'integer' } },
};
// .standards/STANDARDS.md §1 必备文件；数字是「最小字节数」，防止空壳文件。
const REQUIRED_FILES = [
  ['LICENSE', 500],
  ['NOTICE', 200],
  ['README.md', 500],
  ['CONTRIBUTING.md', 200],
  ['SECURITY.md', 200],
  ['CHANGELOG.md', 100],
  ['.editorconfig', 20],
  ['.gitignore', 20],
  ['Makefile', 50],
  ['package.json', 50],
  ['manifest.json', 100],
  ['index.js', 1000],
  ['docs/protocol.md', 1000],
  ['docs/README.md', 100],
  ['.github/workflows/ci.yml', 100],
  ['.github/pull_request_template.md', 50],
  ['.github/dependabot.yml', 50],
  ['.github/ISSUE_TEMPLATE/bug_report.yml', 50],
  ['.github/ISSUE_TEMPLATE/feature_request.yml', 50],
  ['.github/ISSUE_TEMPLATE/config.yml', 20],
];
// 令牌形状（docs/protocol.md §8 的脱敏模式，用于反向扫描仓库）。
const TOKEN_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{16,}/, /github_pat_[A-Za-z0-9_]{16,}/];
const SCAN_SKIP_DIRS = new Set(['.git', 'node_modules']);
const SCAN_SKIP_FILES = new Set(['.DS_Store', '.localized', 'Thumbs.db']);

const problems = [];
let checks = 0;

function check(cond, why) {
  checks += 1;
  if (!cond) problems.push(why);
}

function checkEqual(actual, expected, why) {
  checks += 1;
  if (actual !== expected) problems.push(why + '（实际：' + String(JSON.stringify(actual)) + '）');
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    problems.push(label + ' 无法读取：' + err.message);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    problems.push(label + ' 不是合法 JSON：' + err.message);
    return null;
  }
}

function chars(value) {
  return typeof value === 'string' ? [...value].length : -1;
}

// ---------- manifest.json ----------

function checkManifest() {
  const manifest = readJson(path.join(ROOT, 'manifest.json'), 'manifest.json');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    problems.push('manifest.json 根节点必须是 JSON 对象');
    return;
  }

  // id / name / version / description / protocol
  check(typeof manifest.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(manifest.id), 'manifest.id 不符合 ^[a-z0-9][a-z0-9_-]{0,31}$');
  checkEqual(manifest.id, PLUGIN_ID, 'manifest.id 应为 ' + PLUGIN_ID);
  check(
    typeof manifest.name === 'string' && manifest.name.trim().length > 0 && chars(manifest.name.trim()) <= 64,
    'manifest.name 去首尾空白后应为 1–64 字符'
  );
  check(typeof manifest.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(manifest.version), 'manifest.version 应形如 X.Y.Z');
  checkEqual(manifest.version, PLUGIN_VERSION, 'manifest.version 应为 ' + PLUGIN_VERSION);
  check(typeof manifest.description === 'string', 'manifest.description 应为字符串');
  check(typeof manifest.description === 'string' && chars(manifest.description) <= 200, 'manifest.description 应 ≤200 字符');
  check(typeof manifest.description === 'string' && manifest.description.trim().length > 0, 'manifest.description 不应为空');
  checkEqual(manifest.protocol, 'gqy-jsonrpc-v1', 'manifest.protocol 应为 gqy-jsonrpc-v1');

  // command / cwd / timeout_ms / concurrency
  check(
    Array.isArray(manifest.command) && manifest.command.length > 0 && manifest.command.every((item) => typeof item === 'string' && item.length > 0),
    'manifest.command 应为非空字符串数组'
  );
  check(
    Array.isArray(manifest.command) && manifest.command.every((item) => typeof item === 'string' && !item.includes('\u0000')),
    'manifest.command 每项都不得含 NUL'
  );
  checkEqual(JSON.stringify(manifest.command), JSON.stringify(['node', 'index.js']), 'manifest.command 应为 ["node","index.js"]');
  check(typeof manifest.cwd === 'string' && manifest.cwd.length > 0, 'manifest.cwd 应为非空字符串');
  check(typeof manifest.cwd === 'string' && !manifest.cwd.split(/[\\/]+/).includes('..'), 'manifest.cwd 不得含 ..');
  const cwdResolved = path.resolve(ROOT, typeof manifest.cwd === 'string' ? manifest.cwd : '.');
  check(
    cwdResolved === ROOT || cwdResolved.startsWith(ROOT + path.sep),
    'manifest.cwd 解析后必须仍在插件目录内：' + cwdResolved
  );
  checkEqual(manifest.cwd, '.', 'manifest.cwd 应为 "."');
  check(Number.isInteger(manifest.timeout_ms) && manifest.timeout_ms >= 1 && manifest.timeout_ms <= 120000, 'manifest.timeout_ms 应为 1–120000 的整数');
  checkEqual(manifest.timeout_ms, 120000, 'manifest.timeout_ms 应为 120000（login-wait 单次 ≤90s 的排队余量）');
  check(['concurrent', 'single-channel', 'exclusive'].includes(manifest.concurrency), 'manifest.concurrency 必须是 concurrent / single-channel / exclusive 之一');
  checkEqual(manifest.concurrency, 'single-channel', 'manifest.concurrency 应为 single-channel');

  // provides / requires
  for (const key of ['provides', 'requires']) {
    const list = manifest[key];
    check(Array.isArray(list), 'manifest.' + key + ' 应为数组');
    if (!Array.isArray(list)) continue;
    check(list.every((item) => typeof item === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(item)), 'manifest.' + key + ' 每项应符合 ^[a-z][a-z0-9_.-]{0,63}$');
    check(new Set(list).size === list.length, 'manifest.' + key + ' 不应有重复项');
    checkEqual(list.length, 0, 'manifest.' + key + ' 应为空数组（本插件不提供也不依赖服务）');
  }

  // actions
  const actions = Array.isArray(manifest.actions) ? manifest.actions : [];
  check(Array.isArray(manifest.actions), 'manifest.actions 应为数组');
  checkEqual(actions.length, REQUIRED_ACTIONS.length, 'manifest.actions 应恰好 ' + REQUIRED_ACTIONS.length + ' 个动作');
  const nameList = actions.map((action) => (action && typeof action === 'object' ? action.name : undefined));
  check(nameList.every((name) => typeof name === 'string'), 'manifest.actions 每项都应有字符串 name');
  checkEqual(
    JSON.stringify(nameList.slice().sort()),
    JSON.stringify(REQUIRED_ACTIONS.slice().sort()),
    'manifest.actions 的动作集合必须恰为 ' + REQUIRED_ACTIONS.join('/')
  );
  check(new Set(nameList).size === nameList.length, 'manifest.actions 的动作名不应重复');

  const actionMap = new Map();
  for (const action of actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      check(false, 'manifest.actions 每项都必须是对象');
      continue;
    }
    check(typeof action.name === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(action.name), '动作名不合法：' + String(action.name));
    check(
      typeof action.description === 'string' && chars(action.description) >= 1 && chars(action.description) <= 200,
      '动作 ' + String(action.name) + ' 的 description 应为 1–200 字符'
    );
    check(Boolean(action.schema) && typeof action.schema === 'object' && !Array.isArray(action.schema), '动作 ' + String(action.name) + ' 的 schema 应为对象');
    check(Boolean(action.schema) && action.schema.type === 'object', '动作 ' + String(action.name) + ' 的 schema 根 type 必须为 object');
    if (typeof action.name === 'string') actionMap.set(action.name, action);
  }

  // 每个动作的 schema 参数形状（契约 §5）
  for (const name of REQUIRED_ACTIONS) {
    const action = actionMap.get(name);
    check(Boolean(action), 'manifest.actions 缺少动作 ' + name);
    if (!action) continue;
    const schema = action.schema || {};
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const spec = ACTION_SCHEMAS[name];
    check(Boolean(schema.properties) && typeof schema.properties === 'object' && !Array.isArray(schema.properties), '动作 ' + name + ' 的 schema.properties 应为对象');
    for (const [key, type] of Object.entries(spec.properties)) {
      check(Boolean(props[key]), '动作 ' + name + ' 的 schema 缺少参数 ' + key);
      if (!props[key]) continue;
      checkEqual(props[key].type, type, '动作 ' + name + ' 的参数 ' + key + ' 类型应为 ' + type);
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    check(required.every((key) => typeof key === 'string'), '动作 ' + name + ' 的 schema.required 应为字符串数组');
    for (const key of spec.required) {
      check(required.includes(key), '动作 ' + name + ' 的 schema.required 应包含 ' + key);
    }
    for (const key of required) {
      check(Object.prototype.hasOwnProperty.call(props, key), '动作 ' + name + ' 的 required 项 ' + key + ' 未在 properties 里定义');
    }
  }

  // 逐动作的取值约束（契约 §5.2 / §5.3 / §5.6）
  const loginSchema = (actionMap.get('login') || {}).schema || {};
  const routeSchema = (loginSchema.properties || {}).route || {};
  check(Array.isArray(routeSchema.enum), 'login.route 应有 enum');
  checkEqual(
    JSON.stringify((routeSchema.enum || []).slice().sort()),
    JSON.stringify(['device', 'gh', 'import', 'token']),
    'login.route 的 enum 应恰为 device/gh/token/import'
  );

  const waitSchema = ((actionMap.get('login-wait') || {}).schema || {}).properties || {};
  const waitParam = waitSchema.wait_s || {};
  checkEqual(waitParam.type, 'integer', 'login-wait.wait_s 应为 integer');
  checkEqual(waitParam.minimum, 1, 'login-wait.wait_s 的 minimum 应为 1');
  checkEqual(waitParam.maximum, 90, 'login-wait.wait_s 的 maximum 应为 90');
  checkEqual(waitParam.default, 20, 'login-wait.wait_s 的 default 应为 20');

  for (const name of ['gh', 'git']) {
    const schema = ((actionMap.get(name) || {}).schema || {}).properties || {};
    const args = schema.args || {};
    checkEqual(args.type, 'array', name + '.args 应为 array');
    checkEqual(args.minItems, 1, name + '.args 的 minItems 应为 1');
    checkEqual((args.items || {}).type, 'string', name + '.args.items 应为 string');
    const timeout = schema.timeout_s || {};
    checkEqual(timeout.type, 'integer', name + '.timeout_s 应为 integer');
    checkEqual(timeout.minimum, 1, name + '.timeout_s 的 minimum 应为 1');
    checkEqual(timeout.maximum, 90, name + '.timeout_s 的 maximum 应为 90');
    checkEqual(timeout.default, 30, name + '.timeout_s 的 default 应为 30');
  }
}

// ---------- 仓库标准文件（STANDARDS.md §1） ----------

function checkRequiredFiles() {
  for (const [rel, minBytes] of REQUIRED_FILES) {
    const abs = path.join(ROOT, rel);
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      problems.push('缺少仓库标准文件：' + rel);
      continue;
    }
    check(stat.isFile(), rel + ' 应是普通文件');
    check(stat.size >= minBytes, rel + ' 内容过短（' + stat.size + ' 字节，至少 ' + minBytes + ' 字节）');
  }

  // 文档四件套必须存在且非空
  for (const rel of ['docs/protocol.md', 'docs/README.md', 'README.md', 'CHANGELOG.md']) {
    const abs = path.join(ROOT, rel);
    const exists = fs.existsSync(abs);
    check(exists, '缺少文档：' + rel);
    if (!exists) continue;
    const text = fs.readFileSync(abs, 'utf8');
    check(text.trim().length > 0, rel + ' 不应为空');
  }

  const changelog = fs.existsSync(path.join(ROOT, 'CHANGELOG.md')) ? fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8') : '';
  check(/1\.0\.0/.test(changelog), 'CHANGELOG.md 应包含 1.0.0 版本条目');

  const protocol = fs.existsSync(path.join(ROOT, 'docs/protocol.md')) ? fs.readFileSync(path.join(ROOT, 'docs/protocol.md'), 'utf8') : '';
  check(protocol.includes('gqy-jsonrpc-v1'), 'docs/protocol.md 应说明 gqy-jsonrpc-v1 协议');
  check(protocol.includes('GH_CONFIG_DIR') && protocol.includes('GIT_CONFIG_GLOBAL'), 'docs/protocol.md 应写明隔离环境变量');
}

// ---------- package.json 与 .gitignore ----------

function checkPackageJson() {
  const pkg = readJson(path.join(ROOT, 'package.json'), 'package.json');
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    problems.push('package.json 根节点必须是 JSON 对象');
    return;
  }
  checkEqual(pkg.private, true, 'package.json.private 应为 true');
  check(typeof pkg.name === 'string' && pkg.name.trim().length > 0, 'package.json.name 应为非空字符串');
  check(typeof pkg.engines === 'object' && pkg.engines !== null, 'package.json.engines 应存在');
  check(
    Boolean(pkg.engines) && typeof pkg.engines.node === 'string' && /(>=|>|\^)\s*1[89]|>=2\d/.test(pkg.engines.node),
    'package.json.engines.node 应声明 Node >= 18'
  );
  const script = pkg.scripts && typeof pkg.scripts.test === 'string' ? pkg.scripts.test : '';
  check(script.length > 0, 'package.json 缺少 scripts.test');
  const expected = ['test/manifest.mjs', 'test/handshake.mjs', 'test/isolation.mjs', 'test/real-upstream.mjs'];
  let cursor = -1;
  for (const file of expected) {
    const index = script.indexOf(file);
    check(index >= 0, 'package.json 的 test 脚本应包含 ' + file);
    check(index > cursor, 'package.json 的 test 脚本里 ' + file + ' 的顺序不对（应依次跑四组）');
    if (index >= 0) cursor = index;
  }
}

function checkGitignore() {
  const abs = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(abs)) return;
  const text = fs.readFileSync(abs, 'utf8');
  check(text.includes('.DS_Store'), '.gitignore 应包含 .DS_Store');
  check(text.includes('node_modules'), '.gitignore 应包含 node_modules');
}

// ---------- 全仓令牌扫描 ----------

function walkFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      walkFiles(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SCAN_SKIP_FILES.has(entry.name)) continue;
    out.push(abs);
  }
}

function checkNoTokens() {
  // 检测器自检（源码里用拼接构造样本，仓库文件本身不含令牌字面量）
  const sampleGh = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0';
  const samplePat = 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0';
  check(TOKEN_PATTERNS[0].test(sampleGh), '令牌检测器自检失败：未识别 ghp_ 形状');
  check(TOKEN_PATTERNS[1].test(samplePat), '令牌检测器自检失败：未识别 github_pat_ 形状');
  check(!TOKEN_PATTERNS[0].test('ghp_short'), '令牌检测器自检失败：不应命中过短的 ghp_ 串');
  check(!TOKEN_PATTERNS[1].test('github_pat_short'), '令牌检测器自检失败：不应命中过短的 github_pat_ 串');

  const files = [];
  walkFiles(ROOT, files);
  check(files.length > 0, '仓库扫描未找到任何文件');
  for (const abs of files) {
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.size > 4 * 1024 * 1024) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      for (const pattern of TOKEN_PATTERNS) {
        if (pattern.test(lines[index])) {
          problems.push(rel + ':' + (index + 1) + ' 出现疑似令牌（' + pattern.source + '）');
        }
      }
    }
  }
}

// ---------- 执行 ----------

test('manifest.json 与仓库基线校验', () => {
  checkManifest();
  checkRequiredFiles();
  checkPackageJson();
  checkGitignore();
  checkNoTokens();

  if (problems.length > 0) {
    for (const problem of problems) console.error('  - ' + problem);
    console.error('FAIL: manifest 与仓库基线校验未通过（' + problems.length + ' 项问题，共 ' + checks + ' 项检查）');
    process.exitCode = 1;
    // 让 node:test 也记录失败
    throw new Error('manifest 与仓库基线校验未通过：' + problems.length + ' 项问题');
  }
  console.log('OK: manifest.json 与仓库基线校验通过（' + checks + ' 项检查，含全仓令牌扫描）');
});
