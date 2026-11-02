#!/usr/bin/env node
// GQY「GitHub 账号」插件（github-account-default）：stdio 换行 JSON-RPC 2.0（gqy-jsonrpc-v1）。
//
// 两种用法（行为契约见 docs/protocol.md）：
//   1. 远程 GitHub 授权、本地登录：login route=device 拿 user_code + verification_uri，
//      使用者在任意设备打开链接输入码授权，本机 login-wait 轮询令牌后落盘——本机全程不用交互。
//   2. 隔离 gh / git：账号数据只写 $GQY_HOME/github/<profile>/，gh 与 git 一律通过
//      GH_CONFIG_DIR / GIT_CONFIG_GLOBAL 指向这里，从不读写宿主机的 ~/.config/gh 与 ~/.gitconfig。
//
// 动作：status / login / login-wait / logout / env / gh / git。
// 零依赖，只用 Node 内置模块（fs / os / path / http / https / crypto / child_process / readline），Node >= 18。
// 令牌只在进程内存与 0600 的 gh/hosts.yml 里出现；任何结果、错误与 stderr 都统一脱敏。
// stdin EOF 自退（04 P8 的第一道防线）；single-channel：请求串行处理，login-wait 阻塞期间后续请求排队。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');

const PLUGIN_ID = 'github-account-default';
const VERSION = '1.0.0';
const PROTOCOL = 'gqy-jsonrpc-v1';
// 默认 profile 的显示名；slug 由它规范化得到（Unicode 字母 / 数字 / . / _ / - 保留）。
const DEFAULT_DISPLAY_NAME = '顾清影';
const DEFAULT_HOST = 'github.com';
const DEFAULT_SCOPES = 'repo,read:org,gist,workflow';
const DEFAULT_GH_CONFIG_TEXT = [
  'version: 1',
  'git_protocol: https',
  'editor:',
  'prompt: enabled',
  'prefer_editor_prompt: disabled',
  'pager:',
  'http_unix_socket:',
  'browser:',
  'color_labels: disabled',
  'accessible_colors: disabled',
  'accessible_prompter: disabled',
  'spinner: enabled',
  '',
].join('\n');

const ACTIONS = ['status', 'login', 'login-wait', 'logout', 'env', 'gh', 'git'];
const USER_AGENT = PLUGIN_ID + '/' + VERSION;
const GITHUB_API_VERSION = '2022-11-28';

// 上限与超时（与契约一一对应）。
const MAX_OUTPUT_BYTES = 1024 * 1024; // gh / git 的 stdout、stderr 各截断到 1 MiB
const MAX_PENDING_OUTPUT = 64 * 1024; // route=gh 的 gh 子进程输出各缓存 64 KiB
const MAX_LINE_BYTES = 8 * 1024 * 1024; // 单行 JSON-RPC 上限（蓝图 §4 边角情况）
const MAX_INTERNAL_FILE_BYTES = 4 * 1024 * 1024; // 内部配置文件的读取上限
const TOOL_PROBE_TTL_MS = 60 * 1000; // gh / git 探测结果缓存 60s
const TOOL_PROBE_TIMEOUT_MS = 3 * 1000; // 探测各 3s 上限
const CONNECT_TIMEOUT_MS = 15 * 1000; // 设备码 / 令牌端点 / 令牌校验的 HTTP 超时
const PROBE_TIMEOUT_MS = 10 * 1000; // status probe=true 的 HTTP 超时
const GH_LOGIN_PARSE_TIMEOUT_MS = 15 * 1000; // route=gh 解析设备码的时间窗
const DEFAULT_WAIT_S = 20;
const MAX_WAIT_S = 90;
const DEFAULT_TOOL_TIMEOUT_S = 30;
const MAX_TOOL_TIMEOUT_S = 90;
const DEVICE_POLL_MIN_INTERVAL_S = 5;
const DEVICE_DEFAULT_EXPIRES_IN = 900;
const EOF_GRACE_MS = 5000; // stdin EOF 后最多再等这么久把在途响应写完
const MAX_PROFILE_SCAN = 100;

// ---------- 错误分层：参数形状错（-32602）与业务错误（-32000）分开 ----------

class ParamError extends Error {}

class BizError extends Error {}

// ---------- 环境与根目录 ----------

const GQY_HOME = (() => {
  const raw = typeof process.env.GQY_HOME === 'string' ? process.env.GQY_HOME.trim() : '';
  if (raw) return path.resolve(raw);
  let home = '';
  try {
    home = os.homedir();
  } catch {
    home = '';
  }
  if (!home) home = process.env.HOME || process.env.USERPROFILE || '.';
  return path.resolve(home, '.gqy');
})();
const GQY_ROOT = path.join(GQY_HOME, 'github');
const CLIENT_FILE = path.join(GQY_ROOT, 'client.json');

// ---------- 通用小工具 ----------

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  const delay = Math.max(0, Math.floor(ms));
  return new Promise((resolve) => setTimeout(resolve, delay));
}

// RFC3339（带本机时区偏移），给 checked_at / created_at / expires_at 用。
function rfc3339(value) {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    'T' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds()) +
    sign +
    pad(Math.floor(abs / 60)) +
    ':' +
    pad(abs % 60)
  );
}

function truncate(text, max) {
  const value = String(text === undefined || text === null ? '' : text);
  const limit = max > 0 ? max : 200;
  if (value.length <= limit) return value;
  return value.slice(0, limit - 1) + '…';
}

// 令牌脱敏：gh[pousr]_* / github_pat_* → gh*_…末 4 位；同时压掉 Authorization 与 oauth_token 行。
function maskToken(match) {
  const tail = match.slice(-4);
  return 'gh*_…' + tail;
}

function redact(value) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  try {
    out = out.replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, maskToken);
    out = out.replace(/github_pat_[A-Za-z0-9_]{16,}/g, maskToken);
    out = out.replace(/(Authorization\s*:\s*)([^\s,}]+)/gi, '$1[已隐藏]');
    out = out.replace(/(oauth_token\s*:\s*)(\S+)/gi, '$1[已隐藏]');
  } catch {
    return '[已隐藏]';
  }
  return out;
}

// stderr 只写元信息：`[github-account] <action> ok|fail <duration>ms`，绝不写请求正文与令牌。
function logMeta(text) {
  try {
    process.stderr.write('[github-account] ' + truncate(redact(String(text)), 300) + '\n');
  } catch {
    // 日志写不进去也绝不影响主流程。
  }
}

function stderrTail(text, max) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const cleaned = redact(text).replace(/\r/g, '').trim();
  const lines = cleaned.split('\n').filter((line) => line.trim());
  return truncate(lines.slice(-5).join('\n'), max || 300);
}

// ---------- 参数校验小工具 ----------

function paramError(field, reason) {
  return new ParamError('参数非法：' + field + ' ' + reason);
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function requireOptionalString(args, field, options) {
  const opts = options || {};
  const raw = args[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw paramError(field, '必须是字符串');
  const value = opts.raw ? raw : raw.trim();
  if (!opts.allowEmpty && !value) throw paramError(field, '不能为空');
  if (CONTROL_CHARS.test(value)) throw paramError(field, '不能含控制字符');
  if (typeof opts.max === 'number' && value.length > opts.max) throw paramError(field, '长度超过 ' + opts.max + ' 字符');
  return value;
}

// profile 参数：默认显示名；输入必须是能规范化成非空 slug 的字符串，且不得是 . / ..、不得含路径分隔符或 NUL。
function slugifyProfile(name) {
  let out = '';
  for (const ch of String(name)) {
    out += /[\p{L}\p{Nd}._-]/u.test(ch) ? ch : '-';
  }
  out = out.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (!out) return 'default';
  return out;
}

const DEFAULT_SLUG = slugifyProfile(DEFAULT_DISPLAY_NAME);

function resolveProfile(raw) {
  if (raw === undefined) return { slug: DEFAULT_SLUG, display: DEFAULT_DISPLAY_NAME, explicit: false };
  if (typeof raw !== 'string') throw paramError('profile', '必须是字符串');
  const trimmed = raw.trim();
  if (!trimmed) throw paramError('profile', '不能为空');
  if (trimmed.includes('\0')) throw paramError('profile', '不能含 NUL 字符');
  if (CONTROL_CHARS.test(trimmed)) throw paramError('profile', '不能含控制字符');
  if (trimmed.includes('/') || trimmed.includes('\\')) throw paramError('profile', '不能含路径分隔符');
  if (trimmed === '.' || trimmed === '..') throw paramError('profile', '不能是 . 或 ..');
  const slug = slugifyProfile(trimmed);
  if (!slug || slug === '.' || slug === '..') throw paramError('profile', '规范化后为空');
  return { slug, display: trimmed, explicit: true };
}

function normalizeHost(raw) {
  if (raw === undefined) return DEFAULT_HOST;
  if (typeof raw !== 'string') throw paramError('host', '必须是字符串');
  let host = raw.trim().toLowerCase();
  if (!host) throw paramError('host', '不能为空');
  host = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!host || /[\s\\/]/.test(host) || CONTROL_CHARS.test(host)) {
    throw paramError('host', '格式不合法：' + truncate(raw, 64));
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(host)) {
    throw paramError('host', '格式不合法：' + truncate(raw, 64));
  }
  return host;
}

// gh / git 的 argv：1–64 个非空字符串、单个 <=4096 字符、不含 NUL；直接 spawn，不过 shell。
function validateArgv(raw, field) {
  if (!Array.isArray(raw)) throw paramError(field, '必须是字符串数组');
  if (raw.length < 1 || raw.length > 64) {
    throw paramError(field, '需要 1–64 个参数，当前 ' + raw.length + ' 个');
  }
  return raw.map((item, index) => {
    if (typeof item !== 'string') throw paramError(field + '[' + index + ']', '必须是字符串');
    if (!item) throw paramError(field + '[' + index + ']', '不能是空字符串');
    if (item.includes('\0')) throw paramError(field + '[' + index + ']', '不能含 NUL 字符');
    if (item.length > 4096) throw paramError(field + '[' + index + ']', '超过 4096 字符');
    return item;
  });
}

function validateTimeout(raw) {
  if (raw === undefined) return DEFAULT_TOOL_TIMEOUT_S;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_TOOL_TIMEOUT_S) {
    throw paramError('timeout_s', '必须是 1–90 的整数');
  }
  return raw;
}

// ---------- 路径安全：先 resolve 校验在根内，再校验软链解析后的目标也在根内 ----------

function isInside(base, target) {
  return target === base || target.startsWith(base + path.sep);
}

function assertLexicalInsideRoot(target) {
  const resolved = path.resolve(target);
  if (!isInside(GQY_ROOT, resolved)) {
    throw new BizError('路径越界：' + resolved + ' 不在 $GQY_HOME/github 之内');
  }
  return resolved;
}

// 根目录自身的 realpath。根可能还没创建（例如只是 status），此时用最近的已存在祖先解析后再拼回
// 缺失段，避免 macOS 上 /var → /private/var 这类软链让「根内」比较永远失败。
function realRootPath() {
  let current = GQY_ROOT;
  const missing = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = fs.realpathSync(current);
      return missing.length ? path.join(real, ...missing) : real;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') return GQY_ROOT;
      const parent = path.dirname(current);
      if (parent === current) return GQY_ROOT;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
  return GQY_ROOT;
}

// 软链解析后必须是根内：逐级向上找最近的已存在祖先做 realpath，再把缺失段拼回去比较。
function assertRealPathInsideRoot(target) {
  const resolved = assertLexicalInsideRoot(target);
  const rootReal = realRootPath();
  let current = resolved;
  const missing = [];
  for (let depth = 0; depth < 64; depth += 1) {
    let real;
    try {
      real = fs.realpathSync(current);
    } catch (err) {
      const code = err && err.code ? err.code : '';
      if (code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) break;
        missing.unshift(path.basename(current));
        current = parent;
        continue;
      }
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        throw new BizError('路径不可解析（软链环或非目录）：' + truncate(redact(current), 200));
      }
      throw new BizError('路径解析失败：' + truncate(redact(err && err.message ? err.message : String(err)), 200));
    }
    const full = missing.length ? path.join(real, ...missing) : real;
    if (!isInside(rootReal, full)) {
      throw new BizError('路径越界：软链解析后的目标在 $GQY_HOME/github 之外（' + truncate(redact(full), 200) + '）');
    }
    return full;
  }
  throw new BizError('路径层级过深，拒绝处理：' + truncate(redact(resolved), 200));
}

// 内部文件路径的统一入口：词法在根内 + 软链目标在根内。
function guardInternalPath(target) {
  const resolved = assertLexicalInsideRoot(target);
  assertRealPathInsideRoot(resolved);
  return resolved;
}

function profilePaths(slug) {
  const dir = assertLexicalInsideRoot(path.join(GQY_ROOT, slug));
  if (dir === GQY_ROOT) throw new BizError('profile 非法：解析到根目录');
  return {
    dir,
    ghDir: path.join(dir, 'gh'),
    stateDir: path.join(dir, 'gh-state'),
    dataDir: path.join(dir, 'gh-data'),
    account: path.join(dir, 'account.json'),
    profileJson: path.join(dir, 'profile.json'),
    pending: path.join(dir, 'pending.json'),
    hosts: path.join(dir, 'gh', 'hosts.yml'),
    ghConfig: path.join(dir, 'gh', 'config.yml'),
    gitconfig: path.join(dir, 'gitconfig'),
  };
}

function ensureRoot() {
  try {
    fs.mkdirSync(GQY_ROOT, { recursive: true, mode: 0o700 });
    fs.chmodSync(GQY_ROOT, 0o700);
  } catch (err) {
    throw new BizError('无法创建 $GQY_HOME/github：' + truncate(redact(err && err.message ? err.message : String(err)), 200));
  }
}

function ensureDir0700(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    throw new BizError('无法创建目录 ' + dir + '：' + truncate(redact(err && err.message ? err.message : String(err)), 200));
  }
  return dir;
}

// 登录落盘前统一走这里：根、profile 目录、gh/ 目录都建好并收紧到 0700。
function ensureProfileDir(slug) {
  const p = profilePaths(slug);
  ensureRoot();
  assertRealPathInsideRoot(p.dir);
  ensureDir0700(p.dir);
  assertRealPathInsideRoot(p.ghDir);
  ensureDir0700(p.ghDir);
  return p;
}

// ---------- 文件读写：目录 0700、文件 0600、临时文件 + rename 原子落盘 ----------

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readTextFileStrict(file, maxBytes) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw new BizError('读取文件失败：' + file + '（' + truncate(redact(err && err.message ? err.message : String(err)), 160) + '）');
  }
  if (!stat.isFile()) throw new BizError('不是普通文件：' + file);
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : MAX_INTERNAL_FILE_BYTES;
  if (stat.size > limit) throw new BizError('文件过大，拒绝读取：' + file);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new BizError('读取文件失败：' + file + '（' + truncate(redact(err && err.message ? err.message : String(err)), 160) + '）');
  }
}

// 根内文件的只读入口：不存在返回 null；软链越界抛 -32000。
function readInternalTextFileOrNull(file) {
  const resolved = guardInternalPath(file);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new BizError('读取文件失败：' + resolved + '（' + truncate(redact(err && err.message ? err.message : String(err)), 160) + '）');
  }
  if (!stat.isFile()) return null;
  return readTextFileStrict(resolved);
}

function writeFileAtomic(file, text, mode) {
  const resolved = assertLexicalInsideRoot(file);
  assertRealPathInsideRoot(resolved);
  const dir = path.dirname(resolved);
  ensureDir0700(dir);
  const fileMode = mode === 0o600 || mode === 0o644 ? mode : 0o600;
  const tmp = path.join(
    dir,
    '.' + path.basename(resolved) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'
  );
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', fileMode);
    fs.writeFileSync(fd, text, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      // 有些文件系统不支持 fsync，忽略即可（rename 仍是原子的）。
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, resolved);
    try {
      fs.chmodSync(resolved, fileMode);
    } catch {
      // 权限位收紧失败不影响内容正确性，下一次写入会再试。
    }
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 忽略关闭失败。
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能没建成，忽略。
    }
    throw new BizError('写入文件失败：' + resolved + '（' + truncate(redact(err && err.message ? err.message : String(err)), 160) + '）');
  }
  return resolved;
}

function writeJsonAtomic(file, value) {
  return writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', 0o600);
}

function removeFileQuietly(file) {
  try {
    const resolved = assertLexicalInsideRoot(file);
    fs.unlinkSync(resolved);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    if (err instanceof BizError) return false;
    return false;
  }
}

// ---------- 极简 YAML 子集：只认 key: value 与纯缩进映射（gh 的 config.yml / hosts.yml） ----------

function yamlLineError(where, reason, lineNo) {
  return new BizError(where + ' 结构不合法（第 ' + lineNo + ' 行）：' + reason);
}

function splitYamlKeyValue(content, where, lineNo) {
  let idx = -1;
  if (content[0] === '"' || content[0] === "'") {
    const quote = content[0];
    let end = -1;
    for (let i = 1; i < content.length; i += 1) {
      if (quote === '"' && content[i] === '\\') {
        i += 1;
        continue;
      }
      if (content[i] === quote) {
        if (quote === "'" && content[i + 1] === "'") {
          i += 1;
          continue;
        }
        end = i;
        break;
      }
    }
    if (end < 0) throw yamlLineError(where, '键的引号没有闭合', lineNo);
    const after = content.slice(end + 1);
    const colonAt = after.indexOf(':');
    if (colonAt < 0) throw yamlLineError(where, '缺少 key: value 结构', lineNo);
    if (after.slice(colonAt + 1).trim() !== '' && !/^\s/.test(after.slice(colonAt + 1))) {
      throw yamlLineError(where, '缺少 key: value 结构', lineNo);
    }
    idx = end + 1 + colonAt;
  } else {
    for (let i = 0; i < content.length; i += 1) {
      if (content[i] !== ':') continue;
      const next = content[i + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) throw yamlLineError(where, '缺少 key: value 结构', lineNo);
  const rawKey = content.slice(0, idx).trim();
  if (!rawKey) throw yamlLineError(where, '键为空', lineNo);
  return { key: unquoteYamlScalar(rawKey), value: stripYamlComment(content.slice(idx + 1).trim()) };
}

function unquoteYamlScalar(raw) {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function stripYamlComment(raw) {
  if (!raw) return '';
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    let end = -1;
    for (let i = 1; i < raw.length; i += 1) {
      if (quote === '"' && raw[i] === '\\') {
        i += 1;
        continue;
      }
      if (raw[i] === quote) {
        if (quote === "'" && raw[i + 1] === "'") {
          i += 1;
          continue;
        }
        end = i;
        break;
      }
    }
    if (end < 0) return unquoteYamlScalar(raw);
    return unquoteYamlScalar(raw.slice(0, end + 1));
  }
  const commentAt = raw.indexOf(' #');
  const cut = commentAt >= 0 ? raw.slice(0, commentAt) : raw;
  return cut.trim();
}

function parseYamlMapping(text, where) {
  const label = where || 'YAML';
  const root = {};
  const stack = [{ indent: -1, node: root, lineNo: 0 }];
  const lines = String(text === undefined || text === null ? '' : text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    if (!rawLine.trim()) continue;
    const lead = rawLine.match(/^[ \t]*/);
    if (lead[0].includes('\t')) throw yamlLineError(label, '缩进不能含制表符', lineNo);
    const trimmedStart = rawLine.slice(lead[0].length);
    if (trimmedStart.startsWith('#')) continue;
    const indent = lead[0].length;
    const content = trimmedStart.replace(/\s+$/, '');
    const pair = splitYamlKeyValue(content, label, lineNo);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (stack.length === 1 && indent > 0 && parent.indent < 0) {
      // 首行缩进：仍然挂到根上，宽松兼容 hand-written 文件。
    }
    if (Object.prototype.hasOwnProperty.call(parent.node, pair.key)) {
      throw yamlLineError(label, '键重复：' + pair.key, lineNo);
    }
    if (pair.value === '') {
      const child = {};
      parent.node[pair.key] = child;
      stack.push({ indent, node: child, lineNo });
      continue;
    }
    if (pair.value === '{}') {
      parent.node[pair.key] = {};
      continue;
    }
    if (pair.value === '[]') {
      throw yamlLineError(label, '不支持列表结构：' + pair.key, lineNo);
    }
    parent.node[pair.key] = pair.value;
  }
  return root;
}

function yamlScalarText(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (!text) return "''";
  if (/^[A-Za-z0-9_.@+/:-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function serializeYamlMapping(node, indent) {
  const pad = ' '.repeat(indent || 0);
  let out = '';
  for (const key of Object.keys(node)) {
    const value = node[key];
    const keyText = /^[A-Za-z0-9_.@:-]+$/.test(key) ? key : JSON.stringify(key);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).length === 0) {
        out += pad + keyText + ': {}\n';
      } else {
        out += pad + keyText + ':\n' + serializeYamlMapping(value, (indent || 0) + 4);
      }
    } else if (Array.isArray(value)) {
      throw new BizError('YAML 结构不支持列表：' + truncate(key, 64));
    } else {
      out += pad + keyText + ': ' + yamlScalarText(value) + '\n';
    }
  }
  return out;
}

function ensureHostSection(tree, host) {
  let section = tree[host];
  if (section === undefined) {
    section = {};
    tree[host] = section;
  } else if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw new BizError('gh/hosts.yml 结构不合法：' + host + ' 不是映射');
  }
  return section;
}

function ensureUsersMapping(section) {
  if (section.users === undefined) {
    section.users = {};
  } else if (!section.users || typeof section.users !== 'object' || Array.isArray(section.users)) {
    throw new BizError('gh/hosts.yml 结构不合法：users 不是映射');
  }
  return section.users;
}

// 取令牌：优先顶层 oauth_token，其次 users.<user>.oauth_token；user 取顶层 user，缺失时取 users 里的唯一键。
function readHostsToken(tree, host) {
  if (!tree || typeof tree !== 'object') return null;
  const section = tree[host];
  if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
  const users = section.users && typeof section.users === 'object' && !Array.isArray(section.users) ? section.users : {};
  const userKeys = Object.keys(users);
  const declaredUser = typeof section.user === 'string' ? section.user.trim() : '';
  const fallbackUser = !declaredUser && userKeys.length === 1 ? userKeys[0] : declaredUser;
  const topToken = typeof section.oauth_token === 'string' ? section.oauth_token.trim() : '';
  if (topToken) return { token: topToken, login: declaredUser || fallbackUser || null };
  if (declaredUser) {
    const entry = users[declaredUser];
    if (entry && typeof entry === 'object' && typeof entry.oauth_token === 'string' && entry.oauth_token.trim()) {
      return { token: entry.oauth_token.trim(), login: declaredUser };
    }
  }
  for (const key of userKeys) {
    const entry = users[key];
    if (entry && typeof entry === 'object' && typeof entry.oauth_token === 'string' && entry.oauth_token.trim()) {
      return { token: entry.oauth_token.trim(), login: declaredUser || key };
    }
  }
  return null;
}

// ---------- 内部状态读取（status 用 safe 版本，永不让异常冒出去） ----------

function readProfileJsonSafe(file) {
  try {
    const text = readInternalTextFileOrNull(file);
    if (text === null) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readAccountSafe(file) {
  try {
    const text = readInternalTextFileOrNull(file);
    if (text === null) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const login = typeof parsed.login === 'string' ? parsed.login.trim() : '';
    const id = parsed.id;
    if (!login || !Number.isFinite(id)) return null;
    return { login, id: Number(id) };
  } catch {
    return null;
  }
}

function readHostsSafe(file) {
  try {
    const text = readInternalTextFileOrNull(file);
    if (text === null) return null;
    return parseYamlMapping(text, 'gh/hosts.yml');
  } catch {
    return null;
  }
}

function hostOf(profileJson) {
  if (profileJson && typeof profileJson.host === 'string' && profileJson.host.trim()) {
    return profileJson.host.trim().toLowerCase();
  }
  return DEFAULT_HOST;
}

function profileGitValue(profileJson) {
  if (!profileJson || !profileJson.git || typeof profileJson.git !== 'object' || Array.isArray(profileJson.git)) return {};
  const out = {};
  if (typeof profileJson.git.name === 'string') out.name = profileJson.git.name;
  if (typeof profileJson.git.email === 'string') out.email = profileJson.git.email;
  return out;
}

// 收集一个 profile 的当前状态：account.json + gh/hosts.yml 同时成立才算已登录。
function readLoginState(p) {
  const profJson = readProfileJsonSafe(p.profileJson);
  const host = hostOf(profJson);
  const account = readAccountSafe(p.account);
  const hosts = readHostsSafe(p.hosts);
  const tokenInfo = hosts ? readHostsToken(hosts, host) : null;
  return {
    profJson,
    host,
    account,
    hosts,
    tokenInfo,
    loggedIn: !!(account && tokenInfo && tokenInfo.token),
  };
}

function readPendingJsonSafe(file) {
  try {
    const text = readInternalTextFileOrNull(file);
    if (text === null) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.route !== 'device' && parsed.route !== 'gh') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------- gh / git 子进程：argv 数组不过 shell，独立进程组，超时整组回收 ----------

const liveChildren = new Set();

function killProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch (err) {
    if (err && err.code === 'ESRCH') return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // 进程已经结束，忽略。
  }
}

// SIGTERM，2s 不退再 SIGKILL；只用于「我们自己拉起的」子进程。
function terminateChild(child, graceMs) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  killProcessGroup(child.pid, 'SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && !child.signalCode) killProcessGroup(child.pid, 'SIGKILL');
  }, typeof graceMs === 'number' ? graceMs : 2000);
  if (timer.unref) timer.unref();
}

function killAllChildrenSync() {
  for (const child of liveChildren) {
    killProcessGroup(child.pid, 'SIGKILL');
  }
  liveChildren.clear();
}

function appendLimited(current, chunk, maxBytes, state) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  const remaining = maxBytes - current.length;
  if (remaining <= 0) {
    if (state) state.truncated = true;
    return current;
  }
  if (buffer.length <= remaining) return Buffer.concat([current, buffer]);
  if (state) state.truncated = true;
  return Buffer.concat([current, buffer.subarray(0, remaining)]);
}

// 通用子进程执行：捕获 stdout / stderr（各自截断），超时 SIGTERM → 2s → SIGKILL，返回已收到的输出。
function runProcess(options) {
  const command = options.command;
  const args = options.args || [];
  const maxOutput = options.maxOutput || MAX_OUTPUT_BYTES;
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TOOL_TIMEOUT_S * 1000;
  return new Promise((resolve) => {
    const startedAt = nowMs();
    const stdout = Buffer.alloc(0);
    const stderr = Buffer.alloc(0);
    const stdoutState = { truncated: false };
    const stderrState = { truncated: false };
    let stdoutBuffer = stdout;
    let stderrBuffer = stderr;
    let child = null;
    let settled = false;
    let timedOut = false;
    let spawnError = null;
    let killTimer = null;
    let forceTimer = null;
    let hardTimer = null;
    let timer = null;

    const settle = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (child) liveChildren.delete(child);
      const decode = (buffer, truncFlag) => {
        const text = buffer.toString('utf8');
        const marked = truncFlag ? text + '\n…（截断）' : text;
        return redact(marked);
      };
      resolve({
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal || null,
        stdout: decode(stdoutBuffer, stdoutState.truncated),
        stderr: decode(stderrBuffer, stderrState.truncated),
        truncated: { stdout: stdoutState.truncated, stderr: stderrState.truncated },
        timedOut,
        durationMs: nowMs() - startedAt,
        spawnError,
      });
    };

    try {
      child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      spawnError = err;
      settle(null, null);
      return;
    }

    liveChildren.add(child);
    if (child.stdout) child.stdout.on('data', (chunk) => {
      stdoutBuffer = appendLimited(stdoutBuffer, chunk, maxOutput, stdoutState);
    });
    if (child.stderr) child.stderr.on('data', (chunk) => {
      stderrBuffer = appendLimited(stderrBuffer, chunk, maxOutput, stderrState);
    });
    if (child.stdin) {
      child.stdin.on('error', () => {
        // 子进程提前关掉 stdin（例如已经失败退出），忽略 EPIPE。
      });
      try {
        if (typeof options.stdinText === 'string') child.stdin.write(options.stdinText);
        child.stdin.end();
      } catch {
        // 写不进去时子进程多半已经退出，交给 close 事件收口。
      }
    }

    timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killProcessGroup(child.pid, 'SIGKILL');
      }, 2000);
      if (killTimer.unref) killTimer.unref();
      // 兜底：连 SIGKILL 都没让 close 事件发生时，也要把结果交出去。
      forceTimer = setTimeout(() => settle(null, null), 4000);
      if (forceTimer.unref) forceTimer.unref();
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.on('error', (err) => {
      spawnError = err;
      killProcessGroup(child.pid, 'SIGKILL');
      settle(null, null);
    });
    child.on('close', (code, signal) => {
      // 结束时也回收整组：子进程自己起的后台进程一并收掉，不留孤儿（§5.6）。
      if (process.platform !== 'win32') killProcessGroup(child.pid, 'SIGTERM');
      settle(code, signal);
    });
  });
}

// 根内的子目录（gh/、gh-state/、gh-data/）按需创建，权限一律 0700，且软链目标必须在根内。
function ensureSubdir(target) {
  assertRealPathInsideRoot(target);
  return ensureDir0700(target);
}

// gh / git 子进程的隔离环境：GH_CONFIG_DIR、XDG_STATE_HOME、XDG_DATA_HOME、GIT_CONFIG_GLOBAL
// 全部强制指向 profile，且不继承宿主同名变量。gh 连 --version 都会把 device-id 写进
// $XDG_STATE_HOME/gh/，所以 state / data 目录必须一起隔离（§3.2）。
function buildToolEnv(p, tool) {
  ensureSubdir(p.ghDir);
  ensureSubdir(p.stateDir);
  ensureSubdir(path.join(p.stateDir, 'gh'));
  ensureSubdir(p.dataDir);
  ensureSubdir(path.join(p.dataDir, 'gh'));
  const env = Object.assign({}, process.env);
  delete env.GH_CONFIG_DIR;
  delete env.XDG_STATE_HOME;
  delete env.XDG_DATA_HOME;
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_SYSTEM;
  env.GH_CONFIG_DIR = p.ghDir;
  env.XDG_STATE_HOME = p.stateDir;
  env.XDG_DATA_HOME = p.dataDir;
  env.GIT_CONFIG_GLOBAL = p.gitconfig;
  env.GIT_CONFIG_NOSYSTEM = '1';
  if (tool === 'gh') {
    env.GH_PROMPT_DISABLED = '1';
    env.GH_NO_UPDATE_NOTIFIER = '1';
    env.GH_PAGER = 'cat';
    env.NO_COLOR = '1';
    env.CLICOLOR = '0';
    // §3.5 不弹窗、不落浏览器：把 gh 的浏览器打开动作换成一个无害命令。
    env.GH_BROWSER = 'true';
  } else {
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_PAGER = 'cat';
  }
  return env;
}

// ---------- HTTP：原生 https，超时即断开；错误消息只给原因与状态码 ----------

function httpRequest(options) {
  const method = options.method || 'GET';
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(options.url);
    } catch {
      reject(new BizError('请求地址不合法'));
      return;
    }
    const transport = parsed.protocol === 'http:' ? http : https;
    const bodyBuffer =
      options.body === undefined || options.body === null ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const headers = Object.assign({}, options.headers || {});
    headers['User-Agent'] = headers['User-Agent'] || USER_AGENT;
    if (bodyBuffer) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = String(bodyBuffer.length);
    }
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    let req = null;
    try {
      req = transport.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: parsed.pathname + parsed.search,
          method,
          headers,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size <= 2 * 1024 * 1024) chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            if (text) {
              try {
                json = JSON.parse(text);
              } catch {
                json = null;
              }
            }
            finish(resolve, { status: res.statusCode || 0, headers: res.headers || {}, text, json });
          });
          res.on('error', (err) => {
            finish(reject, new BizError('读取 GitHub 响应失败：' + truncate(redact(err && err.message ? err.message : String(err)), 160)));
          });
        }
      );
    } catch (err) {
      reject(new BizError('请求 GitHub 失败：' + truncate(redact(err && err.message ? err.message : String(err)), 160)));
      return;
    }
    req.on('error', (err) => {
      finish(reject, new BizError('请求 GitHub 失败：' + truncate(redact(err && err.message ? err.message : String(err)), 160)));
    });
    timer = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        // 已断开。
      }
      finish(reject, new BizError('请求 GitHub 超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function apiBase(host) {
  return host === DEFAULT_HOST ? 'https://api.github.com' : 'https://' + host + '/api/v3';
}

function webBase(host) {
  return 'https://' + host;
}

function parseScopesHeader(headers) {
  const raw = headers ? headers['x-oauth-scopes'] : undefined;
  if (raw === undefined) return null;
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function apiErrorMessage(res) {
  if (res && res.json && typeof res.json.message === 'string' && res.json.message.trim()) {
    return truncate(redact(res.json.message.trim()), 160);
  }
  return '';
}

function githubApiHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': USER_AGENT,
    Authorization: 'Bearer ' + token,
  };
}

// GET /user 校验令牌：401 / 403 限流 / 网络失败都转成中文业务错误（消息先脱敏）。
async function githubUser(host, token, timeoutMs) {
  const res = await httpRequest({
    method: 'GET',
    url: apiBase(host) + '/user',
    headers: githubApiHeaders(token),
    timeoutMs: timeoutMs || CONNECT_TIMEOUT_MS,
  });
  const scopes = parseScopesHeader(res.headers);
  if (res.status === 401) throw new BizError('令牌无效或已过期（GitHub 返回 401）');
  if (res.status === 403 && String(res.headers['x-ratelimit-remaining'] || '') === '0') {
    throw new BizError('GitHub API 限流（403）：请稍后再试');
  }
  if (res.status !== 200) {
    const hint = apiErrorMessage(res);
    throw new BizError('校验令牌失败：GitHub 返回 ' + res.status + (hint ? '（' + hint + '）' : ''));
  }
  const user = res.json;
  if (!user || typeof user !== 'object' || typeof user.login !== 'string' || !user.login.trim() || !Number.isFinite(user.id)) {
    throw new BizError('GitHub 返回的账号信息不可识别（缺 login / id）');
  }
  return { login: user.login.trim(), id: Number(user.id), scopes };
}

// ---------- gh / git 版本探测：3s 上限，结果缓存 60s ----------

const toolCache = { at: 0, value: null };

function probeRootDir() {
  return path.join(GQY_ROOT, '.probe');
}

// 探测专用隔离目录（§2 / §3 第 3 条）：gh --version 也会落 device-id，只能写进 <root>/.probe/。
function ensureProbeDirs() {
  const root = probeRootDir();
  ensureRoot();
  for (const rel of ['', 'gh', 'state', path.join('state', 'gh'), 'data', path.join('data', 'gh')]) {
    ensureSubdir(rel ? path.join(root, rel) : root);
  }
  return root;
}

// 探测子进程环境：不碰 $HOME、不继承宿主同名变量、不创建任何 profile 目录。
function probeChildEnv() {
  const root = ensureProbeDirs();
  const env = Object.assign({}, process.env);
  delete env.GH_CONFIG_DIR;
  delete env.XDG_STATE_HOME;
  delete env.XDG_DATA_HOME;
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_SYSTEM;
  env.GH_CONFIG_DIR = path.join(root, 'gh');
  env.XDG_STATE_HOME = path.join(root, 'state');
  env.XDG_DATA_HOME = path.join(root, 'data');
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  env.GH_PROMPT_DISABLED = '1';
  env.NO_COLOR = '1';
  env.CLICOLOR = '0';
  return env;
}

async function probeToolVersion(name, env) {
  const res = await runProcess({
    command: name,
    args: ['--version'],
    env,
    timeoutMs: TOOL_PROBE_TIMEOUT_MS,
    maxOutput: 64 * 1024,
  });
  if (res.spawnError || res.timedOut || res.exitCode !== 0) return { available: false, version: null };
  const firstLine = (res.stdout || res.stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0];
  return { available: true, version: firstLine ? truncate(firstLine, 200) : null };
}

async function probeTools() {
  const now = nowMs();
  if (toolCache.value && now - toolCache.at < TOOL_PROBE_TTL_MS) return toolCache.value;
  let results;
  try {
    const env = probeChildEnv();
    results = await Promise.all([probeToolVersion('gh', env), probeToolVersion('git', env)]);
  } catch {
    // 探测环境建不起来时降级为「都不可用」：status 永远不因为探测失败而报错。
    results = [
      { available: false, version: null },
      { available: false, version: null },
    ];
  }
  const value = { gh: results[0], git: results[1] };
  toolCache.at = nowMs();
  toolCache.value = value;
  return value;
}

// ---------- 设备码流程（GitHub OAuth Device Flow，原生 HTTP） ----------

function resolveClientId(explicit) {
  if (explicit !== undefined) return explicit;
  const fromEnv = typeof process.env.GQY_GITHUB_CLIENT_ID === 'string' ? process.env.GQY_GITHUB_CLIENT_ID.trim() : '';
  if (fromEnv) return fromEnv;
  let text = null;
  try {
    text = readInternalTextFileOrNull(CLIENT_FILE);
  } catch (err) {
    throw new BizError('读取 $GQY_HOME/github/client.json 失败：' + truncate(redact(err && err.message ? err.message : String(err)), 160));
  }
  if (text !== null) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BizError('$GQY_HOME/github/client.json 不是合法 JSON');
    }
    if (parsed && typeof parsed.client_id === 'string' && parsed.client_id.trim()) return parsed.client_id.trim();
  }
  throw new BizError('device 路径需要 client_id：注册 OAuth App / GitHub App 后设置 GQY_GITHUB_CLIENT_ID');
}

function deviceFlowError(res) {
  const body = res && res.json;
  if (body && typeof body === 'object') {
    const err = typeof body.error === 'string' ? body.error : '';
    const desc =
      typeof body.error_description === 'string'
        ? body.error_description
        : typeof body.message === 'string'
          ? body.message
          : '';
    if (err || desc) {
      return 'GitHub 设备码申请失败：' + truncate(redact((err ? err + '：' : '') + desc), 200);
    }
  }
  return 'GitHub 设备码申请失败：返回 HTTP ' + (res ? res.status : 0);
}

async function requestDeviceCode(host, clientId, scopes) {
  const res = await httpRequest({
    method: 'POST',
    url: webBase(host) + '/login/device/code',
    headers: { Accept: 'application/json' },
    body: { client_id: clientId, scope: scopes },
    timeoutMs: CONNECT_TIMEOUT_MS,
  });
  const body = res.json;
  if (res.status !== 200 || !body || typeof body.device_code !== 'string' || !body.device_code) {
    throw new BizError(deviceFlowError(res));
  }
  const expiresIn = Number.isFinite(body.expires_in) && body.expires_in > 0 ? Math.floor(body.expires_in) : DEVICE_DEFAULT_EXPIRES_IN;
  const interval = Number.isFinite(body.interval) && body.interval > 0
    ? Math.max(DEVICE_POLL_MIN_INTERVAL_S, Math.floor(body.interval))
    : DEVICE_POLL_MIN_INTERVAL_S;
  return {
    deviceCode: body.device_code,
    userCode: typeof body.user_code === 'string' ? body.user_code : '',
    verificationUri:
      typeof body.verification_uri === 'string' && body.verification_uri
        ? body.verification_uri
        : webBase(host) + '/login/device',
    expiresIn,
    interval,
  };
}

// ---------- pending 状态：内存优先，其次 pending.json（0600，结束即删） ----------

const pendingMemory = new Map();

function pendingPayload(pending, routeName) {
  return {
    state: 'pending',
    route: routeName || pending.route,
    profile: pending.profile,
    host: pending.host,
    user_code: pending.user_code,
    verification_uri: pending.verification_uri,
    expires_in: typeof pending.expires_in === 'number' ? pending.expires_in : DEVICE_DEFAULT_EXPIRES_IN,
    interval: typeof pending.interval === 'number' ? pending.interval : DEVICE_POLL_MIN_INTERVAL_S,
    expires_at: pending.expires_at,
    next_poll_s: typeof pending.interval === 'number' ? pending.interval : DEVICE_POLL_MIN_INTERVAL_S,
    hint: '用任意设备打开 verification_uri 输入 user_code，完成后调用 login-wait',
  };
}

function devicePendingPayload(pending, interval, lastError) {
  const expiresMs = Date.parse(pending.expires_at || '');
  const out = {
    state: 'pending',
    route: 'device',
    profile: pending.profile,
    host: pending.host,
    remaining_s: Number.isFinite(expiresMs) ? Math.max(0, Math.ceil((expiresMs - nowMs()) / 1000)) : 0,
    next_poll_s: interval,
    user_code: pending.user_code,
    verification_uri: pending.verification_uri,
    expires_at: pending.expires_at,
  };
  if (lastError) out.last_error = lastError;
  return out;
}

function writePendingFile(p, pending) {
  writeJsonAtomic(p.pending, pending);
}

function readPendingFileSafe(p) {
  return readPendingJsonSafe(p.pending);
}

function getPendingState(slug, p) {
  const memory = pendingMemory.get(slug);
  if (memory) return memory;
  const file = readPendingFileSafe(p);
  if (!file) return null;
  const state = Object.assign({}, file);
  state.profile = slug;
  pendingMemory.set(slug, state);
  return state;
}

function clearPendingForProfile(slug, p) {
  const memory = pendingMemory.get(slug);
  if (memory && memory.child) terminateChild(memory.child, 1000);
  pendingMemory.delete(slug);
  removeFileQuietly(p.pending);
}

// ---------- gitconfig / hosts.yml / config.yml / profile.json 落盘 ----------

function gitConfigValue(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) return "''";
  if (/^[A-Za-z0-9._+@/-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function gitconfigTextFor(name, email) {
  const lines = [
    '# Managed by gqy plugin `github-account-default` (`login`). Rewritten on every login.',
    '[user]',
    '\tname = ' + gitConfigValue(name),
  ];
  if (email) lines.push('\temail = ' + gitConfigValue(email));
  lines.push(
    '[credential]',
    '\thelper =',
    '[credential "https://github.com"]',
    '\thelper =',
    '\thelper = !gh auth git-credential',
    '[credential "https://gist.github.com"]',
    '\thelper =',
    '\thelper = !gh auth git-credential'
  );
  return lines.join('\n') + '\n';
}

// 解析 gitconfig 里的 [user] name / email（import 收养参考布局时要用）。
function parseGitconfigIdentity(text) {
  const out = {};
  let section = '';
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    if (section !== 'user') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === 'name') out.name = value;
    if (key === 'email') out.email = value;
  }
  return out;
}

// 在已复制的 gitconfig 上就地改 [user] 段，保留其它段（import 显式传 git_name / git_email 时用）。
function applyGitIdentityToGitconfig(text, name, email) {
  const lines = String(text || '').split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\[([^\]]+)\]$/.exec(lines[i].trim());
    if (!match) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (match[1].trim().toLowerCase() === 'user') start = i;
  }
  const userLines = ['\tname = ' + gitConfigValue(name)];
  if (email) userLines.push('\temail = ' + gitConfigValue(email));
  if (start < 0) return '[user]\n' + userLines.join('\n') + '\n' + String(text || '');
  return lines.slice(0, start + 1).concat(userLines, lines.slice(end)).join('\n');
}

function writeHostsForLogin(p, host, login, token, baseTree) {
  let tree = baseTree;
  if (!tree) {
    const text = readInternalTextFileOrNull(p.hosts);
    tree = text === null ? {} : parseYamlMapping(text, 'gh/hosts.yml');
  }
  const section = ensureHostSection(tree, host);
  const users = ensureUsersMapping(section);
  const previous = users[login] && typeof users[login] === 'object' && !Array.isArray(users[login]) ? users[login] : {};
  users[login] = Object.assign({}, previous, { oauth_token: token });
  section.git_protocol = 'https';
  section.oauth_token = token;
  section.user = login;
  writeFileAtomic(p.hosts, serializeYamlMapping(tree, 0), 0o600);
}

function removeHostsTokenFromTree(tree, host, login) {
  const section = tree ? tree[host] : null;
  if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(section, 'oauth_token')) {
    delete section.oauth_token;
    changed = true;
  }
  const users = section.users;
  if (users && typeof users === 'object' && !Array.isArray(users)) {
    const declared = typeof section.user === 'string' ? section.user : '';
    const target = login || declared;
    if (target && users[target]) {
      delete users[target];
      changed = true;
    } else {
      for (const key of Object.keys(users)) {
        const entry = users[key];
        if (entry && typeof entry === 'object' && typeof entry.oauth_token === 'string') {
          delete users[key];
          changed = true;
        }
      }
    }
  }
  return changed;
}

// config.yml：已存在不覆盖（保留使用者在 gh config set 里改的值）。
function ensureGhConfigFile(p, sourceText) {
  if (isFile(p.ghConfig)) return;
  const text = typeof sourceText === 'string' ? sourceText : DEFAULT_GH_CONFIG_TEXT;
  writeFileAtomic(p.ghConfig, text, 0o600);
}

function writeAccountJson(p, login, id) {
  writeJsonAtomic(p.account, { login, id });
}

function writeProfileJson(p, data) {
  const stamp = rfc3339(new Date());
  const created =
    data.existing && typeof data.existing.created_at === 'string' && data.existing.created_at
      ? data.existing.created_at
      : stamp;
  const payload = {
    schema: 1,
    plugin: PLUGIN_ID,
    version: VERSION,
    profile: data.prof.display,
    slug: data.prof.slug,
    host: data.host,
    login: data.login,
    id: data.id,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    source: data.source,
    token_kind: data.tokenKind === undefined ? null : data.tokenKind,
    git: { name: data.git.name, email: data.git.email },
    created_at: created,
    updated_at: stamp,
    logged_in: true,
  };
  writeJsonAtomic(p.profileJson, payload);
}

function defaultGitEmail(host, login, id) {
  if (host === DEFAULT_HOST) return String(id) + '+' + login + '@users.noreply.github.com';
  return '';
}

// 登录收口：所有路径（device / gh / token / import）最后都走这里统一落盘并返回 ready。
function finishLogin(options) {
  const p = ensureProfileDir(options.prof.slug);
  const existing = readProfileJsonSafe(p.profileJson);
  const previousGit = profileGitValue(existing);
  let gitName = options.gitName;
  let gitEmail = options.gitEmail;
  if (gitName === undefined && previousGit.name) gitName = previousGit.name;
  if (gitEmail === undefined && typeof previousGit.email === 'string') gitEmail = previousGit.email;
  if (gitName === undefined || gitName === '') gitName = options.login;
  if (gitEmail === undefined) gitEmail = defaultGitEmail(options.host, options.login, options.id);
  let hint = '';
  if (!gitEmail) hint = '当前 host 不是 github.com：git_email 留空，需要时用 login 的 git_email 参数补上';

  writeAccountJson(p, options.login, options.id);
  if (!options.keepHosts) {
    writeHostsForLogin(p, options.host, options.login, options.token, options.hostsTree);
  }
  ensureGhConfigFile(p, options.ghConfigText);
  if (typeof options.gitconfigText === 'string') {
    writeFileAtomic(p.gitconfig, options.gitconfigText, 0o600);
  } else {
    writeFileAtomic(p.gitconfig, gitconfigTextFor(gitName, gitEmail), 0o600);
  }
  writeProfileJson(p, {
    existing,
    prof: options.prof,
    host: options.host,
    login: options.login,
    id: options.id,
    scopes: options.scopes,
    source: options.route,
    tokenKind: options.tokenKind,
    git: { name: gitName, email: gitEmail },
  });
  clearPendingForProfile(options.prof.slug, p);

  const ready = {
    state: 'ready',
    route: options.route,
    profile: options.prof.slug,
    host: options.host,
    login: options.login,
    id: options.id,
    scopes: Array.isArray(options.scopes) ? options.scopes : [],
    source: options.route,
    config: {
      profile_dir: p.dir,
      gh_config_dir: p.ghDir,
      gitconfig: p.gitconfig,
      account_json: p.account,
    },
  };
  if (hint) ready.hint = hint;
  return ready;
}

// ---------- 动作：status ----------

function scanProfiles() {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(GQY_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_PROFILE_SCAN) break;
    if (!entry.isDirectory()) continue;
    const dir = path.join(GQY_ROOT, entry.name);
    const profJson = readProfileJsonSafe(path.join(dir, 'profile.json'));
    if (!profJson) continue;
    const host = hostOf(profJson);
    const account = readAccountSafe(path.join(dir, 'account.json'));
    let loggedIn = false;
    if (account) {
      const hosts = readHostsSafe(path.join(dir, 'gh', 'hosts.yml'));
      const tokenInfo = hosts ? readHostsToken(hosts, host) : null;
      loggedIn = !!(tokenInfo && tokenInfo.token);
    }
    out.push({
      profile: entry.name,
      display_name: typeof profJson.profile === 'string' && profJson.profile ? profJson.profile : entry.name,
      login: account ? account.login : null,
      logged_in: loggedIn,
      host,
    });
  }
  out.sort((a, b) => (a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0));
  return out;
}

// probe=true：用现令牌复核身份，任何错误都装进 verified.ok=false，绝不抛。
async function probeIdentity(host, token) {
  if (!token) {
    return { ok: false, status: null, message: '没有可用于复核的令牌（未登录或 gh/hosts.yml 缺少 oauth_token）' };
  }
  try {
    const res = await httpRequest({
      method: 'GET',
      url: apiBase(host) + '/user',
      headers: githubApiHeaders(token),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (res.status === 200 && res.json && typeof res.json.login === 'string') {
      const scopes = parseScopesHeader(res.headers);
      return {
        ok: true,
        login: res.json.login,
        id: Number.isFinite(res.json.id) ? Number(res.json.id) : null,
        scopes: scopes || [],
        checked_at: rfc3339(new Date()),
      };
    }
    const hint = apiErrorMessage(res);
    return {
      ok: false,
      status: res.status,
      message: hint || 'GitHub API 返回 ' + res.status,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      message: truncate(redact(err && err.message ? err.message : '复核失败'), 200),
    };
  }
}

async function actionStatus(args) {
  const prof = resolveProfile(args.profile);
  let probe = false;
  if (args.probe !== undefined) {
    if (typeof args.probe !== 'boolean') throw paramError('probe', '必须是布尔值');
    probe = args.probe;
  }
  const p = profilePaths(prof.slug);
  const out = {
    plugin: PLUGIN_ID,
    version: VERSION,
    default_profile: DEFAULT_SLUG,
    default_display_name: DEFAULT_DISPLAY_NAME,
    root: GQY_ROOT,
    profile: prof.slug,
    display_name: prof.display,
    profile_dir: p.dir,
    gh_config_dir: p.ghDir,
    gitconfig: p.gitconfig,
    host: DEFAULT_HOST,
    logged_in: false,
    account: null,
    source: null,
    scopes: [],
    git: {},
    has_pending: false,
    pending: null,
    tools: { gh: { available: false, version: null }, git: { available: false, version: null } },
    profiles: [],
    isolated: { root: GQY_ROOT, outside_writes: false },
    verified: probe ? { ok: false, status: null, message: '尚未复核' } : null,
  };
  try {
    const state = readLoginState(p);
    out.host = state.host;
    if (state.profJson && typeof state.profJson.profile === 'string' && state.profJson.profile.trim()) {
      out.display_name = state.profJson.profile.trim();
    }
    out.logged_in = state.loggedIn;
    out.account = state.account ? { login: state.account.login, id: state.account.id } : null;
    out.source = state.profJson && typeof state.profJson.source === 'string' ? state.profJson.source : null;
    out.scopes =
      state.profJson && Array.isArray(state.profJson.scopes)
        ? state.profJson.scopes.filter((item) => typeof item === 'string')
        : [];
    out.git = profileGitValue(state.profJson);
    const pending = getPendingState(prof.slug, p);
    out.has_pending = !!pending;
    out.pending = pending
      ? {
          route: pending.route,
          user_code: pending.user_code,
          verification_uri: pending.verification_uri,
          expires_at: pending.expires_at,
        }
      : null;
    out.tools = await probeTools();
    out.profiles = scanProfiles();
    if (probe) out.verified = await probeIdentity(state.host, state.tokenInfo ? state.tokenInfo.token : null);
  } catch (err) {
    // status 永不抛错：任何内部异常都降级为字段缺省，只记元信息到 stderr。
    logMeta('status degraded ' + truncate(redact(err && err.message ? err.message : String(err)), 120));
  }
  return out;
}

// ---------- 动作：login ----------

function validateLoginArgs(args) {
  const rawRoute = args.route;
  if (typeof rawRoute !== 'string' || !rawRoute.trim()) {
    throw paramError('route', '缺少（device / gh / token / import）');
  }
  const route = rawRoute.trim();
  if (['device', 'gh', 'token', 'import'].indexOf(route) === -1) {
    throw paramError('route', '必须是 device / gh / token / import 之一');
  }
  const prof = resolveProfile(args.profile);
  const host = normalizeHost(args.host);
  let scopes = DEFAULT_SCOPES;
  if (args.scopes !== undefined) {
    const value = requireOptionalString(args, 'scopes', { max: 1024 });
    scopes = value;
  }
  let clientId;
  if (args.client_id !== undefined) clientId = requireOptionalString(args, 'client_id', { max: 256 });
  let token;
  if (args.token !== undefined) {
    if (typeof args.token !== 'string') throw paramError('token', '必须是字符串');
    if (!args.token.trim()) throw paramError('token', '不能为空');
    if (args.token.length > 4096) throw paramError('token', '长度超过 4096 字符');
    if (CONTROL_CHARS.test(args.token)) throw paramError('token', '不能含控制字符');
    token = args.token.trim();
  }
  let importPath;
  if (args.path !== undefined) {
    if (typeof args.path !== 'string') throw paramError('path', '必须是字符串');
    if (!args.path.trim()) throw paramError('path', '不能为空');
    if (args.path.includes('\0')) throw paramError('path', '不能含 NUL 字符');
    if (args.path.length > 4096) throw paramError('path', '长度超过 4096 字符');
    importPath = path.resolve(args.path.trim());
  }
  let gitName;
  if (args.git_name !== undefined) gitName = requireOptionalString(args, 'git_name', { max: 256 });
  let gitEmail;
  if (args.git_email !== undefined) {
    if (typeof args.git_email !== 'string') throw paramError('git_email', '必须是字符串');
    if (CONTROL_CHARS.test(args.git_email)) throw paramError('git_email', '不能含控制字符');
    if (args.git_email.length > 256) throw paramError('git_email', '长度超过 256 字符');
    gitEmail = args.git_email.trim();
  }
  let force = false;
  if (args.force !== undefined) {
    if (typeof args.force !== 'boolean') throw paramError('force', '必须是布尔值');
    force = args.force;
  }
  if (route === 'token') {
    if (token === undefined) throw paramError('token', 'route=token 时必填');
  }
  if (route === 'import') {
    if (importPath === undefined) throw paramError('path', 'route=import 时必填');
    let stat = null;
    try {
      stat = fs.statSync(importPath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) throw paramError('path', '必须存在且是目录：' + truncate(args.path, 200));
  }
  return { route, prof, host, scopes, clientId, token, importPath, gitName, gitEmail, force };
}

function resolveGitIdentityForLogin(options) {
  const p = profilePaths(options.prof.slug);
  const existing = readProfileJsonSafe(p.profileJson);
  const previousGit = profileGitValue(existing);
  let gitName = options.gitName;
  let gitEmail = options.gitEmail;
  if (gitName === undefined && previousGit.name) gitName = previousGit.name;
  if (gitEmail === undefined && typeof previousGit.email === 'string') gitEmail = previousGit.email;
  if (gitName === undefined) gitName = options.login;
  if (gitEmail === undefined) gitEmail = defaultGitEmail(options.host, options.login, options.id);
  return { name: gitName, email: gitEmail };
}

async function loginWithToken(ctx) {
  const user = await githubUser(ctx.host, ctx.token, CONNECT_TIMEOUT_MS);
  return finishLogin({
    prof: ctx.prof,
    route: 'token',
    host: ctx.host,
    login: user.login,
    id: user.id,
    token: ctx.token,
    scopes: user.scopes || [],
    tokenKind: user.scopes === null ? 'fine-grained' : 'oauth',
    gitName: ctx.gitName,
    gitEmail: ctx.gitEmail,
  });
}

async function loginWithImport(ctx) {
  const source = ctx.importPath;
  const accountPath = path.join(source, 'account.json');
  const hostsPath = path.join(source, 'gh', 'hosts.yml');
  const configPath = path.join(source, 'gh', 'config.yml');
  const gitconfigPath = path.join(source, 'gitconfig');
  const hasAccount = isFile(accountPath);
  const hasHosts = isFile(hostsPath);
  if (!hasAccount && !hasHosts) {
    throw new BizError('不是 github 账号布局目录：' + truncate(source, 200) + '（缺少 account.json 与 gh/hosts.yml）');
  }

  let account = null;
  if (hasAccount) {
    let parsed = null;
    try {
      parsed = JSON.parse(readTextFileStrict(accountPath));
    } catch (err) {
      if (err instanceof BizError) throw err;
      throw new BizError('account.json 不是合法 JSON（' + truncate(redact(err && err.message ? err.message : String(err)), 160) + '）');
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const login = typeof parsed.login === 'string' ? parsed.login.trim() : '';
      if (login && Number.isFinite(parsed.id)) account = { login, id: Number(parsed.id) };
    }
    if (!account) throw new BizError('account.json 缺少 login / id');
  }

  let hostsTree = {};
  if (hasHosts) {
    const hostsText = readTextFileStrict(hostsPath);
    hostsTree = parseYamlMapping(hostsText, 'gh/hosts.yml');
  }
  const tokenInfo = readHostsToken(hostsTree, ctx.host);
  if (!tokenInfo || !tokenInfo.token) {
    throw new BizError('源目录里没有可用令牌（gh/hosts.yml 缺少 ' + ctx.host + ' 的 oauth_token）');
  }

  const user = await githubUser(ctx.host, tokenInfo.token, CONNECT_TIMEOUT_MS);
  if (account && (account.login !== user.login || account.id !== user.id) && !ctx.force) {
    throw new BizError(
      '账号不一致：account.json 是 ' + account.login + '/' + account.id + '，令牌属于 ' + user.login + '/' + user.id + '（force:true 以令牌为准继续）'
    );
  }

  // 先读后写：源目录全程只读，不移动、不修改。
  const configText = isFile(configPath) ? readTextFileStrict(configPath) : null;
  let gitconfigText = isFile(gitconfigPath) ? readTextFileStrict(gitconfigPath) : null;
  const sourceIdentity = gitconfigText ? parseGitconfigIdentity(gitconfigText) : {};
  let gitName = ctx.gitName;
  let gitEmail = ctx.gitEmail;
  if (gitName === undefined && sourceIdentity.name) gitName = sourceIdentity.name;
  if (gitEmail === undefined && typeof sourceIdentity.email === 'string') gitEmail = sourceIdentity.email;
  if (gitName === undefined) gitName = user.login;
  if (gitEmail === undefined) gitEmail = defaultGitEmail(ctx.host, user.login, user.id);
  if (gitconfigText && (ctx.gitName !== undefined || ctx.gitEmail !== undefined)) {
    gitconfigText = applyGitIdentityToGitconfig(gitconfigText, gitName, gitEmail);
  }

  return finishLogin({
    prof: ctx.prof,
    route: 'import',
    host: ctx.host,
    login: user.login,
    id: user.id,
    token: tokenInfo.token,
    scopes: user.scopes || [],
    tokenKind: user.scopes === null ? 'fine-grained' : 'oauth',
    gitName,
    gitEmail,
    hostsTree,
    ghConfigText: configText,
    gitconfigText: gitconfigText || undefined,
  });
}

async function loginWithDevice(ctx) {
  const clientId = resolveClientId(ctx.clientId);
  const code = await requestDeviceCode(ctx.host, clientId, ctx.scopes);
  const startedAt = nowMs();
  const pending = {
    schema: 1,
    route: 'device',
    host: ctx.host,
    profile: ctx.prof.slug,
    display_name: ctx.prof.display,
    client_id: clientId,
    device_code: code.deviceCode,
    user_code: code.userCode,
    verification_uri: code.verificationUri,
    interval: code.interval,
    expires_in: code.expiresIn,
    expires_at: rfc3339(new Date(startedAt + code.expiresIn * 1000)),
    scopes: ctx.scopes,
    git_name: ctx.gitName,
    git_email: ctx.gitEmail,
    created_at: rfc3339(new Date(startedAt)),
  };
  const p = ensureProfileDir(ctx.prof.slug);
  clearPendingForProfile(ctx.prof.slug, p);
  writePendingFile(p, pending);
  pendingMemory.set(ctx.prof.slug, pending);
  return pendingPayload(pending, 'device');
}

function defaultDeviceUri(host) {
  return webBase(host) + '/login/device';
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimUrlTail(url) {
  return String(url).replace(/[.,;:!?)\]}>'"`]+$/, '');
}

// route=gh：从 gh 子进程输出里等设备码与授权 URL（15s 窗口），期间保持子进程存活。
function waitForGhDeviceCode(state, host, timeoutMs) {
  return new Promise((resolve) => {
    const codeRe = /one[\s-]*time\s+code[^A-Za-z0-9]*([A-Za-z0-9]{4}-[A-Za-z0-9]{4})/i;
    const urlRe = new RegExp('https://' + escapeRegExp(host) + '/login/device[^\\s]*', 'i');
    const anyDeviceUrlRe = /https?:\/\/[^\s]*\/login\/device[^\s]*/i;
    let settled = false;
    let poller = null;
    let hardTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (poller) clearInterval(poller);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    };
    const inspect = () => {
      const text = (state.stdout || '') + '\n' + (state.stderr || '');
      const codeMatch = codeRe.exec(text);
      if (codeMatch) {
        const urlMatch = urlRe.exec(text) || anyDeviceUrlRe.exec(text);
        finish({
          ok: true,
          userCode: codeMatch[1].toUpperCase(),
          verificationUri: urlMatch ? trimUrlTail(urlMatch[0]) : defaultDeviceUri(host),
        });
        return;
      }
      if (state.closed) {
        const exitCode = state.exited ? state.exited.code : null;
        const tail = stderrTail(state.stderr, 200);
        finish({
          ok: false,
          reason: 'gh 提前退出（exit ' + (exitCode === null ? 'null' : exitCode) + '）' + (tail ? '：' + tail : ''),
        });
      }
    };
    poller = setInterval(inspect, 100);
    if (poller.unref) poller.unref();
    hardTimer = setTimeout(() => finish({ ok: false, reason: '15 秒内没有解析到 One-time code' }), timeoutMs);
    if (hardTimer.unref) hardTimer.unref();
    inspect();
  });
}

async function loginWithGh(ctx) {
  const tools = await probeTools();
  if (!tools.gh || !tools.gh.available) {
    throw new BizError('gh 不可用，改用 device 或 token 路径');
  }
  const p = ensureProfileDir(ctx.prof.slug);
  // 幂等：同一 profile 已有进行中的 gh 登录时，先杀掉旧子进程再重开。
  clearPendingForProfile(ctx.prof.slug, p);

  const env = buildToolEnv(p, 'gh');
  let child;
  try {
    child = spawn('gh', ['auth', 'login', '--hostname', ctx.host, '--git-protocol', 'https', '--web'], {
      cwd: process.cwd(),
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new BizError('拉起 gh 失败：' + truncate(redact(err && err.message ? err.message : String(err)), 160));
  }

  const state = { child, stdout: '', stderr: '', closed: false, exited: null };
  liveChildren.add(child);
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      let buffer = Buffer.from(state.stdout, 'utf8');
      const holder = { truncated: false };
      buffer = appendLimited(buffer, Buffer.from(String(chunk), 'utf8'), MAX_PENDING_OUTPUT, holder);
      state.stdout = buffer.toString('utf8');
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      let buffer = Buffer.from(state.stderr, 'utf8');
      const holder = { truncated: false };
      buffer = appendLimited(buffer, Buffer.from(String(chunk), 'utf8'), MAX_PENDING_OUTPUT, holder);
      state.stderr = buffer.toString('utf8');
    });
  }
  if (child.stdin) {
    child.stdin.on('error', () => {
      // gh 已退出时写 stdin 会 EPIPE，忽略。
    });
  }
  child.on('error', (err) => {
    state.closed = true;
    state.exited = { code: null, signal: null, error: err };
    liveChildren.delete(child);
  });
  child.on('close', (code, signal) => {
    state.closed = true;
    state.exited = { code, signal };
    liveChildren.delete(child);
  });

  const parsed = await waitForGhDeviceCode(state, ctx.host, GH_LOGIN_PARSE_TIMEOUT_MS);
  if (!parsed.ok) {
    terminateChild(child, 1000);
    throw new BizError('gh 未给出设备码：' + truncate(parsed.reason || '15 秒内没有解析到设备码', 200));
  }
  // 解析到了：等价于使用者在终端按一次回车让 gh 继续；stdin 保持打开，不关闭、不杀进程。
  try {
    child.stdin.write('\n');
  } catch {
    // 写不进去说明 gh 已经自行继续，忽略。
  }

  const startedAt = nowMs();
  const pending = {
    schema: 1,
    route: 'gh',
    host: ctx.host,
    profile: ctx.prof.slug,
    display_name: ctx.prof.display,
    user_code: parsed.userCode,
    verification_uri: parsed.verificationUri,
    interval: DEVICE_POLL_MIN_INTERVAL_S,
    expires_in: DEVICE_DEFAULT_EXPIRES_IN,
    expires_at: rfc3339(new Date(startedAt + DEVICE_DEFAULT_EXPIRES_IN * 1000)),
    gh_pid: child.pid || null,
    git_name: ctx.gitName,
    git_email: ctx.gitEmail,
    created_at: rfc3339(new Date(startedAt)),
  };
  try {
    writePendingFile(p, pending);
  } catch (err) {
    terminateChild(child, 1000);
    throw err;
  }
  pendingMemory.set(ctx.prof.slug, Object.assign({}, pending, { child, state }));
  return pendingPayload(pending, 'gh');
}

async function actionLogin(args) {
  const ctx = validateLoginArgs(args);
  if (ctx.route === 'token') return loginWithToken(ctx);
  if (ctx.route === 'import') return loginWithImport(ctx);
  if (ctx.route === 'device') return loginWithDevice(ctx);
  return loginWithGh(ctx);
}

// ---------- 动作：login-wait ----------

async function finishGhLogin(pending, prof, p, tokenInfo) {
  const user = await githubUser(pending.host, tokenInfo.token, CONNECT_TIMEOUT_MS);
  return finishLogin({
    prof,
    route: 'gh',
    host: pending.host,
    login: user.login,
    id: user.id,
    token: tokenInfo.token,
    scopes: user.scopes || [],
    tokenKind: 'oauth',
    keepHosts: true,
    gitName: typeof pending.git_name === 'string' ? pending.git_name : undefined,
    gitEmail: typeof pending.git_email === 'string' ? pending.git_email : undefined,
  });
}

async function waitGhLogin(pending, prof, p, waitS) {
  const deadline = nowMs() + waitS * 1000;
  const child = pending.child || null;
  const state = pending.state || null;
  const nextPollS = DEVICE_POLL_MIN_INTERVAL_S;
  for (;;) {
    const expiresMs = Date.parse(pending.expires_at || '');
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs()) {
      clearPendingForProfile(prof.slug, p);
      return {
        state: 'expired',
        route: 'gh',
        profile: prof.slug,
        host: pending.host,
        hint: '设备码已过期，重新发起 login',
      };
    }
    if (!child) {
      // 插件重启过：子进程已不在，看 gh 是否已经把凭据写好了。
      const hosts = readHostsSafe(p.hosts);
      const tokenInfo = hosts ? readHostsToken(hosts, pending.host) : null;
      if (tokenInfo && tokenInfo.token) return finishGhLogin(pending, prof, p, tokenInfo);
      clearPendingForProfile(prof.slug, p);
      return {
        state: 'failed',
        route: 'gh',
        profile: prof.slug,
        host: pending.host,
        exit_code: null,
        message: 'gh 登录进程已不在且没有产生凭据，请重新 login',
      };
    }
    if ((state && state.closed) || child.exitCode !== null || child.signalCode) {
      const exited = (state && state.exited) || {
        code: child.exitCode === null ? null : child.exitCode,
        signal: child.signalCode || null,
        error: null,
      };
      if (exited.error) {
        clearPendingForProfile(prof.slug, p);
        return {
          state: 'failed',
          route: 'gh',
          profile: prof.slug,
          host: pending.host,
          exit_code: null,
          message: 'gh 进程启动失败：' + truncate(redact(exited.error.message || String(exited.error)), 200),
        };
      }
      if (exited.code === 0) {
        const hosts = readHostsSafe(p.hosts);
        const tokenInfo = hosts ? readHostsToken(hosts, pending.host) : null;
        if (tokenInfo && tokenInfo.token) return finishGhLogin(pending, prof, p, tokenInfo);
        clearPendingForProfile(prof.slug, p);
        return {
          state: 'failed',
          route: 'gh',
          profile: prof.slug,
          host: pending.host,
          exit_code: 0,
          message: 'gh 正常退出但没有写入 gh/hosts.yml 的 oauth_token',
        };
      }
      const tail = stderrTail(state ? state.stderr : '', 300);
      clearPendingForProfile(prof.slug, p);
      return {
        state: 'failed',
        route: 'gh',
        profile: prof.slug,
        host: pending.host,
        exit_code: exited.code === undefined ? null : exited.code,
        message: tail || 'gh 登录进程异常退出',
      };
    }
    if (nowMs() >= deadline) {
      const remainExpire = Number.isFinite(expiresMs) ? Math.max(0, Math.ceil((expiresMs - nowMs()) / 1000)) : 0;
      return {
        state: 'pending',
        route: 'gh',
        profile: prof.slug,
        host: pending.host,
        remaining_s: remainExpire,
        next_poll_s: nextPollS,
        user_code: pending.user_code,
        verification_uri: pending.verification_uri,
        expires_at: pending.expires_at,
      };
    }
    await sleep(250);
  }
}

async function waitDeviceLogin(pending, prof, p, waitS) {
  const deadline = nowMs() + waitS * 1000;
  let interval = Math.max(DEVICE_POLL_MIN_INTERVAL_S, Number(pending.interval) || DEVICE_POLL_MIN_INTERVAL_S);
  let lastError = '';
  const step = async () => {
    const remaining = deadline - nowMs();
    if (remaining > 0) await sleep(Math.min(interval * 1000, remaining));
  };
  for (;;) {
    const expiresMs = Date.parse(pending.expires_at || '');
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs()) {
      clearPendingForProfile(prof.slug, p);
      return {
        state: 'expired',
        route: 'device',
        profile: prof.slug,
        host: pending.host,
        hint: '设备码已过期，重新发起 login',
      };
    }
    if (nowMs() >= deadline) return devicePendingPayload(pending, interval, lastError);

    let res = null;
    try {
      res = await httpRequest({
        method: 'POST',
        url: webBase(pending.host) + '/login/oauth/access_token',
        headers: { Accept: 'application/json' },
        body: {
          client_id: pending.client_id,
          device_code: pending.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
    } catch (err) {
      lastError = truncate(redact(err && err.message ? err.message : '轮询失败'), 200);
      await step();
      continue;
    }

    const body = res.json && typeof res.json === 'object' ? res.json : {};
    if (typeof body.access_token === 'string' && body.access_token) {
      const token = body.access_token;
      let user;
      try {
        user = await githubUser(pending.host, token, CONNECT_TIMEOUT_MS);
      } catch (err) {
        clearPendingForProfile(prof.slug, p);
        throw err;
      }
      const grantedScopes =
        user.scopes === null
          ? String(body.scope || pending.scopes || '')
              .split(/[ ,]+/)
              .map((item) => item.trim())
              .filter(Boolean)
          : user.scopes;
      return finishLogin({
        prof,
        route: 'device',
        host: pending.host,
        login: user.login,
        id: user.id,
        token,
        scopes: grantedScopes,
        tokenKind: 'oauth',
        gitName: typeof pending.git_name === 'string' ? pending.git_name : undefined,
        gitEmail: typeof pending.git_email === 'string' ? pending.git_email : undefined,
      });
    }

    const errorCode = typeof body.error === 'string' ? body.error : '';
    if (!errorCode) {
      lastError = '令牌端点返回无法识别的内容（HTTP ' + res.status + '）';
      await step();
      continue;
    }
    if (errorCode === 'authorization_pending') {
      await step();
      continue;
    }
    if (errorCode === 'slow_down') {
      interval += 5;
      await step();
      continue;
    }
    if (errorCode === 'expired_token') {
      clearPendingForProfile(prof.slug, p);
      return {
        state: 'expired',
        route: 'device',
        profile: prof.slug,
        host: pending.host,
        hint: '设备码已过期，重新发起 login',
      };
    }
    if (errorCode === 'access_denied') {
      clearPendingForProfile(prof.slug, p);
      return {
        state: 'denied',
        route: 'device',
        profile: prof.slug,
        host: pending.host,
        hint: '授权被拒绝，可重新发起 login',
      };
    }
    const description = typeof body.error_description === 'string' ? body.error_description : '';
    clearPendingForProfile(prof.slug, p);
    return {
      state: 'failed',
      route: 'device',
      profile: prof.slug,
      host: pending.host,
      error: truncate(redact(errorCode), 120),
      message: truncate(redact(description || errorCode), 200),
    };
  }
}

async function actionLoginWait(args) {
  const prof = resolveProfile(args.profile);
  let waitS = DEFAULT_WAIT_S;
  if (args.wait_s !== undefined) {
    if (!Number.isInteger(args.wait_s) || args.wait_s < 1 || args.wait_s > MAX_WAIT_S) {
      throw paramError('wait_s', '必须是 1–90 的整数');
    }
    waitS = args.wait_s;
  }
  const p = profilePaths(prof.slug);
  const pending = getPendingState(prof.slug, p);
  if (!pending) return { state: 'missing', hint: '没有进行中的登录，先调用 login' };
  const expiresMs = Date.parse(pending.expires_at || '');
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs()) {
    clearPendingForProfile(prof.slug, p);
    return {
      state: 'expired',
      route: pending.route,
      profile: prof.slug,
      host: pending.host,
      hint: '设备码已过期，重新发起 login',
    };
  }
  if (pending.route === 'gh') return waitGhLogin(pending, prof, p, waitS);
  return waitDeviceLogin(pending, prof, p, waitS);
}

// ---------- 动作：logout ----------

function listRelativeFiles(dir, limit) {
  const out = [];
  const max = limit || 50;
  const walk = (current, depth) => {
    if (out.length >= max || depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        out.push(path.relative(GQY_ROOT, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(dir, 0);
  return out;
}

async function actionLogout(args) {
  const prof = resolveProfile(args.profile);
  let purge = false;
  if (args.purge !== undefined) {
    if (typeof args.purge !== 'boolean') throw paramError('purge', '必须是布尔值');
    purge = args.purge;
  }
  const p = profilePaths(prof.slug);

  // 内存里的 pending（可能带 gh 子进程）先收掉，避免退出后留孤儿。
  const memoryPending = pendingMemory.get(prof.slug);
  if (memoryPending && memoryPending.child) terminateChild(memoryPending.child, 1000);
  pendingMemory.delete(prof.slug);

  if (!isDirectory(p.dir)) {
    return { state: 'logged-out', profile: prof.slug, removed: [], purged: false };
  }
  ensureRoot();

  if (purge) {
    assertRealPathInsideRoot(p.dir);
    const removed = listRelativeFiles(p.dir);
    try {
      fs.rmSync(p.dir, { recursive: true, force: true });
    } catch (err) {
      throw new BizError('删除 profile 目录失败：' + truncate(redact(err && err.message ? err.message : String(err)), 160));
    }
    return { state: 'logged-out', profile: prof.slug, removed, purged: true };
  }

  const removed = [];
  const profJson = readProfileJsonSafe(p.profileJson);
  const host = hostOf(profJson);
  const account = readAccountSafe(p.account);
  const login =
    (account && account.login) ||
    (profJson && typeof profJson.login === 'string' && profJson.login.trim() ? profJson.login.trim() : null);

  if (isFile(p.hosts)) {
    const hostsText = readInternalTextFileOrNull(p.hosts);
    if (hostsText !== null) {
      // 结构不合法时不能安全清理令牌：明确报错，让使用者选择 purge。
      const tree = parseYamlMapping(hostsText, 'gh/hosts.yml');
      const changed = removeHostsTokenFromTree(tree, host, login);
      if (changed) writeFileAtomic(p.hosts, serializeYamlMapping(tree, 0), 0o600);
    }
  }

  if (isFile(p.account)) {
    if (removeFileQuietly(p.account)) removed.push(prof.slug + '/account.json');
  }
  if (isFile(p.pending)) {
    if (removeFileQuietly(p.pending)) removed.push(prof.slug + '/pending.json');
  }

  if (profJson) {
    const next = Object.assign({}, profJson, { logged_in: false, updated_at: rfc3339(new Date()) });
    writeJsonAtomic(p.profileJson, next);
  }

  return { state: 'logged-out', profile: prof.slug, removed, purged: false };
}

// ---------- 动作：env ----------

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function actionEnv(args) {
  const prof = resolveProfile(args.profile);
  const p = profilePaths(prof.slug);
  const state = readLoginState(p);
  const env = {
    GH_CONFIG_DIR: p.ghDir,
    GIT_CONFIG_GLOBAL: p.gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const exportsText = [
    'export GH_CONFIG_DIR=' + shellQuote(env.GH_CONFIG_DIR),
    'export GIT_CONFIG_GLOBAL=' + shellQuote(env.GIT_CONFIG_GLOBAL),
    'export GIT_CONFIG_NOSYSTEM=' + shellQuote(env.GIT_CONFIG_NOSYSTEM),
    'export GIT_TERMINAL_PROMPT=' + shellQuote(env.GIT_TERMINAL_PROMPT),
  ].join('\n');
  return {
    profile: prof.slug,
    display_name:
      state.profJson && typeof state.profJson.profile === 'string' && state.profJson.profile
        ? state.profJson.profile
        : prof.display,
    host: state.host,
    logged_in: state.loggedIn,
    login: state.account ? state.account.login : null,
    profile_dir: p.dir,
    gh_config_dir: p.ghDir,
    gitconfig: p.gitconfig,
    env,
    exports: exportsText,
    hint: '把 exports 贴进当前 shell，或在子进程环境里直接用 env 的键值；不要用宿主 ~/.config/gh',
  };
}

// ---------- 动作：gh / git ----------

function rejectGhSecretCommands(argv) {
  const lower = argv.map((item) => item.toLowerCase());
  for (let i = 0; i < lower.length - 1; i += 1) {
    if (lower[i] !== 'auth') continue;
    if (lower[i + 1] === 'token') throw new BizError('不通过插件取令牌：gh auth token 被拒绝');
    if (lower[i + 1] === 'login') throw new BizError('登录用 login 动作：gh auth login 被拒绝');
    if (lower[i + 1] === 'logout') throw new BizError('登录用 login 动作：gh auth logout 被拒绝');
  }
  for (const item of lower) {
    if (item.includes('--show-token')) throw new BizError('不通过插件取令牌：--show-token 被拒绝');
  }
}

async function runToolAction(options) {
  const p = profilePaths(options.prof.slug);
  const state = readLoginState(p);
  if (!state.loggedIn) {
    throw new BizError('未登录：先调用 login 动作登录 GitHub 账号（profile: ' + options.prof.slug + '）');
  }
  const env = buildToolEnv(p, options.tool);
  const res = await runProcess({
    command: options.command,
    args: options.argv,
    cwd: options.cwd || process.cwd(),
    env,
    timeoutMs: options.timeoutS * 1000,
    stdinText: options.stdinText,
    maxOutput: MAX_OUTPUT_BYTES,
  });
  if (res.spawnError) {
    const code = res.spawnError.code === 'ENOENT' ? 'PATH 里找不到 ' + options.tool : truncate(redact(res.spawnError.message || String(res.spawnError)), 160);
    throw new BizError(options.tool + ' 不可用：' + code);
  }
  return {
    exit_code: res.timedOut ? null : res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    duration_ms: res.durationMs,
    timed_out: !!res.timedOut,
    truncated: { stdout: !!res.truncated.stdout, stderr: !!res.truncated.stderr },
    tool: options.tool,
  };
}

async function actionGh(args) {
  const prof = resolveProfile(args.profile);
  const argv = validateArgv(args.args, 'args');
  const timeoutS = validateTimeout(args.timeout_s);
  let stdinText;
  if (args.stdin !== undefined) {
    if (typeof args.stdin !== 'string') throw paramError('stdin', '必须是字符串');
    if (args.stdin.length > 1024 * 1024) throw paramError('stdin', '超过 1 MiB 上限');
    stdinText = args.stdin;
  }
  rejectGhSecretCommands(argv);
  return runToolAction({ tool: 'gh', command: 'gh', argv, prof, timeoutS, stdinText });
}

async function actionGit(args) {
  const prof = resolveProfile(args.profile);
  const argv = validateArgv(args.args, 'args');
  const timeoutS = validateTimeout(args.timeout_s);
  let cwd = process.cwd();
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== 'string' || !args.cwd.trim()) throw paramError('cwd', '必须是非空字符串');
    if (args.cwd.includes('\0')) throw paramError('cwd', '不能含 NUL 字符');
    const resolved = path.resolve(args.cwd.trim());
    let stat = null;
    try {
      stat = fs.statSync(resolved);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) throw paramError('cwd', '必须存在且是目录：' + truncate(args.cwd, 200));
    cwd = resolved;
  }
  return runToolAction({ tool: 'git', command: 'git', argv, prof, timeoutS, cwd });
}

const HANDLERS = {
  status: actionStatus,
  login: actionLogin,
  'login-wait': actionLoginWait,
  logout: actionLogout,
  env: actionEnv,
  gh: actionGh,
  git: actionGit,
};

// ---------- JSON-RPC 2.0 服务端（单通道串行） ----------

function errorReply(id, code, message) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message: truncate(redact(String(message || '调用失败')), 1000) },
  };
}

function handleRequestMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { reply: errorReply(null, -32600, '非法请求：消息必须是 JSON 对象') };
  }
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  const idValue = hasId ? msg.id : null;
  const idValid = hasId && (typeof msg.id === 'string' || typeof msg.id === 'number');
  if (typeof msg.method !== 'string' || !msg.method.trim()) {
    return { reply: errorReply(idValid ? idValue : null, -32600, '非法请求：method 缺失或不是字符串') };
  }
  if (!idValid) {
    return { reply: errorReply(null, -32600, '非法请求：id 缺失或类型不合法（必须是字符串或数字）') };
  }
  const method = msg.method.trim();
  switch (method) {
    case 'initialize':
      return { reply: { jsonrpc: '2.0', id: idValue, result: { ok: true, name: PLUGIN_ID, version: VERSION } } };
    case 'call':
      return { kind: 'call', id: idValue, params: msg.params };
    case 'shutdown':
      return { reply: { jsonrpc: '2.0', id: idValue, result: { ok: true } }, shutdown: true };
    default:
      return { reply: errorReply(idValue, -32601, '未知方法: ' + truncate(method, 100)) };
  }
}

async function handleCall(id, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return errorReply(id, -32602, '参数非法：params 必须是对象');
  }
  const action = params.action;
  if (typeof action !== 'string' || !action.trim()) {
    return errorReply(id, -32602, '参数非法：缺少 action');
  }
  const name = action.trim();
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, name)) {
    return errorReply(id, -32601, '未知动作: ' + truncate(name, 100));
  }
  const rawArgs = params.arguments === undefined ? {} : params.arguments;
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return errorReply(id, -32602, '参数非法：arguments 必须是对象');
  }
  const startedAt = nowMs();
  try {
    const payload = await HANDLERS[name](rawArgs);
    let content;
    try {
      content = redact(JSON.stringify(payload));
    } catch (err) {
      throw new BizError('结果序列化失败：' + truncate(redact(err && err.message ? err.message : String(err)), 160));
    }
    logMeta(name + ' ok ' + (nowMs() - startedAt) + 'ms');
    return { jsonrpc: '2.0', id, result: { content } };
  } catch (err) {
    const code = err instanceof ParamError ? -32602 : -32000;
    const message = truncate((err && err.message) || '调用失败', 1000);
    logMeta(name + ' fail ' + (nowMs() - startedAt) + 'ms (' + code + ')');
    return errorReply(id, code, message);
  }
}

// ---------- stdio 主循环：请求按到达顺序串行，EOF 自退 ----------

const queue = [];
let processing = false;
let eofSeen = false;
let shuttingDown = false;
let eofTimer = null;

function writeLine(obj, callback) {
  let text;
  try {
    text = JSON.stringify(obj) + '\n';
  } catch {
    text = '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"响应序列化失败"}}\n';
  }
  try {
    if (callback) {
      process.stdout.write(text, callback);
    } else {
      process.stdout.write(text);
    }
  } catch {
    cleanupAndExit(0);
  }
}

function writeLineAsync(obj) {
  return new Promise((resolve) => {
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      writeLine(obj, settle);
    } catch {
      settle();
    }
    const guard = setTimeout(settle, 2000);
    if (guard.unref) guard.unref();
  });
}

function cleanupAndExit(code) {
  if (eofTimer) {
    clearTimeout(eofTimer);
    eofTimer = null;
  }
  killAllChildrenSync();
  process.exit(code === undefined ? 0 : code);
}

function enqueue(item) {
  queue.push(item);
  void pump();
}

async function pump() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0 && !shuttingDown) {
      const item = queue.shift();
      if (item.shutdown) {
        shuttingDown = true;
        await writeLineAsync(item.reply);
        cleanupAndExit(0);
        return;
      }
      if (item.kind === 'call') {
        let reply;
        try {
          reply = await handleCall(item.id, item.params);
        } catch (err) {
          reply = errorReply(item.id, -32000, (err && err.message) || '内部错误');
        }
        writeLine(reply);
        continue;
      }
      if (item.reply) writeLine(item.reply);
    }
  } finally {
    processing = false;
  }
  if (eofSeen && !shuttingDown) cleanupAndExit(0);
}

function onStdinClosed() {
  if (shuttingDown) return;
  eofSeen = true;
  if (!processing && queue.length === 0) {
    cleanupAndExit(0);
    return;
  }
  // 还有在途请求：最多再给 5s 把响应写完；父进程已关闭 stdin 时不留长等。
  if (!eofTimer) {
    eofTimer = setTimeout(() => cleanupAndExit(0), EOF_GRACE_MS);
    if (eofTimer.unref) eofTimer.unref();
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (shuttingDown) return;
  if (line.length > MAX_LINE_BYTES) {
    enqueue({ reply: errorReply(null, -32600, '请求过大：单行超过 8 MB 上限') });
    return;
  }
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    enqueue({ reply: errorReply(null, -32700, '非法 JSON：无法解析该行') });
    return;
  }
  let handled;
  try {
    handled = handleRequestMessage(msg);
  } catch (err) {
    enqueue({ reply: errorReply(null, -32000, '内部错误：' + truncate(redact(err && err.message ? err.message : String(err)), 160)) });
    return;
  }
  if (!handled) return;
  enqueue(handled);
});

rl.on('close', onStdinClosed);

process.stdin.on('error', () => {
  onStdinClosed();
});

process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') cleanupAndExit(0);
  logMeta('stdout error');
  cleanupAndExit(0);
});

process.on('SIGTERM', () => cleanupAndExit(0));
process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGHUP', () => cleanupAndExit(0));

// 进程退出时确保自己拉起的 gh / git 子进程整组回收，不留孤儿。
process.on('exit', () => {
  killAllChildrenSync();
});

// 最后防线：任何意外都只记元信息到 stderr，绝不让常驻进程崩掉。
process.on('uncaughtException', (err) => {
  logMeta('uncaught exception ' + truncate(redact(err && err.message ? err.message : String(err)), 160));
});

process.on('unhandledRejection', (reason) => {
  logMeta('unhandled rejection ' + truncate(redact(reason && reason.message ? reason.message : String(reason)), 160));
});

