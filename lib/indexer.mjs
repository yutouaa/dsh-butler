#!/usr/bin/env node
/**
 * butler/lib/indexer.mjs — DSH 会话索引 + 摘要数据层（纯 Node，零第三方依赖）
 *
 * 硬性约束：
 *   1. 只读：绝不写入 DSH_HOME（~/.dsh）。CLI 的 --out 会拒绝落在 DSH_HOME 下面。
 *   2. 会话缓存可能正被宿主写入：Node 的 fs.readFile 在 Windows 上以
 *      FILE_SHARE_READ|WRITE|DELETE 打开（libuv 走 _SH_DENYNO），不锁文件；
 *      另外对 EBUSY/EPERM/EACCES 做短退避重试，半写入 JSON 重读一次再判损坏。
 *   3. 坏文件跳过并计数，绝不中断整轮索引。
 *   4. 渲染有硬字节预算（默认 8 KiB / 每会话 ≤8 行），超预算按优先级退化而非截半行。
 *
 * 主 API：
 *   listSessions(options) -> SessionIndex
 *   buildDigest(options)  -> Digest
 *   renderMarkdown(index, options) -> string
 *   renderDigestMarkdown(digest, options) -> string
 *
 * @module butler/lib/indexer
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 反引号。用转义写法，使本文件源码不出现裸反引号，便于被外部脚本整体拼装。 */
const BT = '\u0060';

/* ────────────────────────────── 常量 ────────────────────────────── */

export const VERSION = 1;

export const DEFAULTS = Object.freeze({
  activeWindowMs: 15 * 60 * 1000,
  recentTurns: 3,
  digestTurns: 4,
  snippetChars: 120,
  maxBytes: 8 * 1024,
  maxLinesPerSession: 8,
  maxSessions: 20,
  readConcurrency: 48,
  readRetries: 3,
});

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);
const IS_WINDOWS = process.platform === 'win32';

/* ────────────────────────────── 小工具 ────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

/** 压成单行并截断（按码点，不切坏代理对）。 */
export function clip(value, max = 120) {
  if (value == null) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(1, max - 1)).join('') + '…';
}

/** 清理会破坏 markdown 行结构的字符。 */
function inlineSafe(s) {
  return String(s == null ? '' : s)
    .replace(/\r?\n/g, ' ')
    .replace(/\u0060/g, "'")
    .trim();
}

export function formatStamp(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function formatAge(ms, now = Date.now()) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const d = Math.max(0, now - ms);
  if (d < 60000) return Math.max(1, Math.round(d / 1000)) + 's前';
  if (d < 3600000) return Math.round(d / 60000) + 'm前';
  if (d < 86400000) return Math.round(d / 3600000) + 'h前';
  return Math.round(d / 86400000) + 'd前';
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '0B';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

function normPath(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/[\\/]+/g, path.sep);
  while (s.length > 1 && s.endsWith(path.sep)) s = s.slice(0, -1);
  return IS_WINDOWS ? s.toLowerCase() : s;
}

function pathIsUnder(child, base) {
  const c = normPath(child);
  const b = normPath(base);
  if (!c || !b) return false;
  if (c === b) return true;
  return c.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** 并发受限 map（保序）。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

/** 共享读；对 Windows 共享冲突做短退避重试。 */
async function readTextShared(file) {
  let lastErr;
  for (let attempt = 0; attempt < DEFAULTS.readRetries; attempt++) {
    try {
      return await fsp.readFile(file, 'utf8');
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_CODES.has(err && err.code)) throw err;
      await sleep(12 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function readJsonShared(file) {
  const text = await readTextShared(file);
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

async function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      const st = await fsp.stat(c);
      if (st.isFile()) return c;
    } catch (_) { /* 试下一个 */ }
  }
  return null;
}

/* ────────────────────────────── 路径解析 ────────────────────────────── */

/**
 * 解析全部数据源位置，全部可覆盖（便于迁移与测试）。
 * @returns {{dshHome:string,mnemonHome:string,projcacheDir:string,workspaceJson:string,skillsDir:string,memoryCandidates:string[],userCandidates:string[]}}
 */
export function defaultDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 顶层会话 id 带 session- 前缀；裸 uuid 是子代理会话，不能作为派活目标。 */
export function isTopLevelSession(id) {
  return String(id || '').startsWith('session-');
}

export function resolvePaths(options = {}) {
  const dshHome = options.dshHome || defaultDshHome();
  const mnemonHome = options.mnemonHome || process.env.MNEMON_HOME || path.join(os.homedir(), '.mnemon');
  return {
    dshHome: dshHome,
    mnemonHome: mnemonHome,
    projcacheDir: options.projcacheDir || path.join(dshHome, 'storages', 'session_projcache', 'sessions'),
    workspaceJson: options.workspaceJson || path.join(dshHome, 'storages', 'workspace.json'),
    skillsDir: options.skillsDir || path.join(dshHome, 'skills'),
    memoryCandidates: options.memoryCandidates || [
      path.join(dshHome, 'MEMORY.md'),
      path.join(mnemonHome, 'runtime', 'MEMORY.md'),
    ],
    userCandidates: options.userCandidates || [
      path.join(dshHome, 'USER.md'),
      path.join(mnemonHome, 'runtime', 'USER.md'),
    ],
  };
}

/* ────────────────────────────── 工作区表 ────────────────────────────── */

async function loadWorkspaceTable(paths) {
  const table = { ok: false, error: null, byPath: [], byId: new Map(), archived: new Set() };
  let json;
  try {
    json = await readJsonShared(paths.workspaceJson);
  } catch (err) {
    table.error = (err && err.code) || String((err && err.message) || err);
    return table;
  }
  const rows = json && json.tables && json.tables.workspaces;
  if (rows && typeof rows === 'object') {
    for (const id of Object.keys(rows)) {
      const ws = rows[id];
      if (!ws || typeof ws !== 'object') continue;
      const entry = {
        id: id,
        path: ws.path || '',
        title: ws.title || (ws.path ? path.basename(ws.path) : id),
        sessionIds: Array.isArray(ws.sessionIds) ? ws.sessionIds : [],
      };
      table.byId.set(id, entry);
      if (entry.path) table.byPath.push(Object.assign({ norm: normPath(entry.path) }, entry));
    }
    table.byPath.sort((a, b) => b.norm.length - a.norm.length);
  }
  const archived = json && json.global && json.global.archivedSessionIds;
  if (Array.isArray(archived)) for (const s of archived) table.archived.add(String(s));
  table.ok = true;
  return table;
}

function matchWorkspace(table, cwd) {
  if (!cwd) return null;
  for (const ws of table.byPath) if (pathIsUnder(cwd, ws.path)) return ws;
  return null;
}

/**
 * 某个目录属于哪个已登记的工作区（最长路径匹配）。
 * @returns {Promise<{id:string,title:string,path:string}|null>} 不属于任何工作区时为 null
 */
export async function findWorkspace(cwd, options = {}) {
  const ws = matchWorkspace(await loadWorkspaceTable(resolvePaths(options)), cwd);
  return ws ? { id: ws.id, title: ws.title, path: ws.path } : null;
}

/**
 * 某个会话属于哪个已登记的工作区（按 workspace.json 里各工作区的 sessionIds 反查）。
 * 用于 cwd 取不到或格式对不上时的兜底；不属于任何工作区时为 null。
 */
export async function findWorkspaceBySession(sessionId, options = {}) {
  if (!sessionId) return null;
  const table = await loadWorkspaceTable(resolvePaths(options));
  for (const ws of table.byId.values()) {
    if (ws.sessionIds.includes(String(sessionId))) return { id: ws.id, title: ws.title, path: ws.path };
  }
  return null;
}

/** 按 id 取已登记的工作区；不存在为 null。 */
export async function getWorkspace(id, options = {}) {
  const ws = (await loadWorkspaceTable(resolvePaths(options))).byId.get(id);
  return ws ? { id: ws.id, title: ws.title, path: ws.path } : null;
}

/* ────────────────────────────── 技能 ────────────────────────────── */

/** 极简 YAML frontmatter 解析：顶层标量 + 简单块标量。 */
export function parseFrontmatter(text) {
  const out = { data: {}, body: text };
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let value = kv[2].trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const folded = value.charAt(0) === '>';
      const collected = [];
      i++;
      while (i < lines.length && (/^\s+\S/.test(lines[i]) || lines[i].trim() === '')) {
        collected.push(lines[i].replace(/^\s{1,4}/, ''));
        i++;
      }
      value = (folded ? collected.join(' ') : collected.join('\n')).trim();
    } else {
      if ((value.charAt(0) === '"' && value.endsWith('"')) || (value.charAt(0) === "'" && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      i++;
    }
    out.data[key] = value;
  }
  out.body = src.slice(m[0].length);
  return out;
}

function firstParagraph(body) {
  const lines = String(body || '').split(/\r?\n/);
  const buf = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (buf.length) break; else continue; }
    if (/^#{1,6}\s/.test(line) || line.indexOf('<!--') === 0) { if (buf.length) break; else continue; }
    buf.push(line.replace(/^[-*+]\s+/, ''));
    if (buf.join(' ').length > 200) break;
  }
  return buf.join(' ');
}

export async function loadSkills(paths, extraDirs = []) {
  const dirs = [paths.skillsDir].concat(extraDirs).filter(Boolean);
  const seen = new Set();
  const skills = [];
  const warnings = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (!err || err.code !== 'ENOENT') warnings.push('skills: ' + dir + ' → ' + ((err && err.code) || err));
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      let text;
      try { text = await readTextShared(file); } catch (_) { continue; }
      const fm = parseFrontmatter(text);
      const name = String((fm.data && fm.data.name) || entry.name).trim() || entry.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const description = clip(String((fm.data && fm.data.description) || firstParagraph(fm.body) || '').trim(), 400);
      skills.push({ name: name, description: description, dir: dir, path: file, bytes: byteLen(text) });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills: skills, dirs: dirs, warnings: warnings };
}

/* ────────────────────────────── 记忆 ────────────────────────────── */

/** 按独占一行的 § 切分记忆条目。 */
export function countMemoryEntries(text) {
  const src = String(text == null ? '' : text).trim();
  if (!src) return 0;
  const blocks = src.split(/^[ \t]*§[ \t]*$/m).map((s) => s.trim()).filter(Boolean);
  return Math.max(1, blocks.length);
}

async function loadMemoryFile(kind, candidates) {
  const file = await firstExisting(candidates);
  if (!file) return null;
  let text = '';
  try {
    text = await readTextShared(file);
  } catch (err) {
    return { kind: kind, path: file, error: (err && err.code) || String(err), entries: 0, bytes: 0, chars: 0 };
  }
  return { kind: kind, path: file, entries: countMemoryEntries(text), bytes: byteLen(text), chars: text.length };
}

async function loadMemory(paths) {
  const pair = await Promise.all([loadMemoryFile('memory', paths.memoryCandidates), loadMemoryFile('user', paths.userCandidates)]);
  const memory = pair[0];
  const user = pair[1];
  const files = [memory, user].filter(Boolean);
  return {
    files: files,
    memory: memory,
    user: user,
    entries: (memory ? memory.entries : 0) + (user ? user.entries : 0),
    bytes: (memory ? memory.bytes : 0) + (user ? user.bytes : 0),
  };
}

/* ────────────────────────────── 会话规范化 ────────────────────────────── */

function pickRow(record, key) {
  const row = record && record.rows ? record.rows[key] : undefined;
  if (row == null) return undefined;
  return Object.prototype.hasOwnProperty.call(row, 'val') ? row.val : row;
}

function asArray(v) { return Array.isArray(v) ? v : []; }

function countOpenTodos(todos) {
  const items = asArray((todos && (todos.items || todos.list)) || (Array.isArray(todos) ? todos : []));
  let open = 0;
  for (const it of items) {
    const s = String((it && it.status) || '').toLowerCase();
    if (s === 'completed' || s === 'done' || s === 'cancelled') continue;
    open++;
  }
  return open;
}

/**
 * 把一份 projection record 规范化成会话对象。
 * @returns {{ok:true,session:object}|{ok:false,reason:string}}
 */
export function normalizeSession(record, meta, options = {}) {
  const snippetChars = Number.isFinite(options.snippetChars) ? options.snippetChars : DEFAULTS.snippetChars;
  const recentTurns = Number.isFinite(options.recentTurns) ? options.recentTurns : DEFAULTS.recentTurns;
  if (!record || typeof record !== 'object') return { ok: false, reason: 'no-record' };
  const identity = record.identity;
  if (!identity || typeof identity !== 'object') return { ok: false, reason: 'no-identity' };

  const title = pickRow(record, 'title');
  const workingDirectory = pickRow(record, 'workingDirectory');
  const stats = pickRow(record, 'sessionStats') || {};
  const listMeta = pickRow(record, 'sessionListMetadata') || {};
  const outline = pickRow(record, 'turnOutline') || {};
  const goal = pickRow(record, 'goal');
  const todos = pickRow(record, 'todos');

  const turns = Number.isFinite(stats.turns) ? stats.turns : 0;
  const steps = Number.isFinite(stats.steps) ? stats.steps : 0;
  const openStep = stats.openStep == null ? null : stats.openStep;
  const lastPromptAt = Number.isFinite(listMeta.lastPromptAt) ? listMeta.lastPromptAt : null;

  const rawTurns = asArray(outline.turns);
  const recent = rawTurns.slice(-Math.max(0, recentTurns)).map((t) => ({
    turn: Number.isFinite(t && t.turn) ? t.turn : null,
    prompt: clip(t && t.prompt, snippetChars),
    response: clip(t && t.response, snippetChars),
  }));
  const prompts = rawTurns.map((t) => String((t && t.prompt) || ''));

  return {
    ok: true,
    session: {
      id: meta.id,
      file: meta.file,
      size: meta.size == null ? null : meta.size,
      title: title ? String(title) : null,
      cwd: String(identity.cwd || workingDirectory || ''),
      workspace: null,
      blank: Boolean(listMeta.blank) || (turns === 0 && !title),
      archived: false,
      status: 'idle',
      turns: turns,
      steps: steps,
      lastTurn: Number.isFinite(stats.lastTurn) ? stats.lastTurn : null,
      openStep: openStep && typeof openStep === 'object' ? { turn: openStep.turn == null ? null : openStep.turn, step: openStep.step == null ? null : openStep.step } : null,
      lastPromptAt: lastPromptAt,
      lastActiveAt: lastPromptAt,
      createdAt: Number.isFinite(identity.createdAt) ? identity.createdAt : null,
      goals: { active: Boolean(goal && goal.current && !goal.failure) },
      todos: { open: countOpenTodos(todos) },
      recentTurns: recent,
      outlineTurns: rawTurns.length,
      totalPromptChars: prompts.reduce((n, p) => n + p.length, 0),
      _prompts: prompts,
    },
  };
}

function inferStatus(session, ctx) {
  if (session.blank) return 'blank';
  if (session.openStep) return 'running';
  if (session.lastActiveAt != null && ctx.now - session.lastActiveAt <= ctx.activeWindowMs) return 'active';
  return 'idle';
}

async function readSessionFile(file, id, size, parseOptions) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await readJsonShared(file);
      const norm = normalizeSession(json && json.record, { id: id, file: file, size: size }, parseOptions);
      if (!norm.ok) {
        if (attempt === 0) { await sleep(20); continue; }
        return { ok: false, id: id, file: file, error: norm.reason };
      }
      return { ok: true, session: Object.assign({ id: id, file: file, size: size }, norm.session) };
    } catch (err) {
      if (attempt === 1) return { ok: false, id: id, file: file, error: (err && (err.code || err.name)) || 'parse-error' };
      await sleep(25);
    }
  }
  return { ok: false, id: id, file: file, error: 'unknown' };
}

export function shortId(id) {
  const s = String(id || '');
  const m = /([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(s);
  return m ? m[1] : s.slice(-8);
}

async function listSessionDir(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const warnings = err && err.code === 'ENOENT'
      ? ['会话缓存目录不存在: ' + dir]
      : ['会话缓存目录不可读: ' + dir + ' (' + ((err && err.code) || err) + ')'];
    return { files: [], warnings: warnings };
  }
  const names = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json')).map((e) => e.name).sort();
  const files = await mapLimit(names, DEFAULTS.readConcurrency, async (name) => {
    let size = null;
    try { size = (await fsp.stat(path.join(dir, name))).size; } catch (_) { size = null; }
    return { name: name, size: size };
  });
  return { files: files, warnings: [] };
}

/* ────────────────────────────── 主 API：listSessions ────────────────────────────── */

function normalizeFilter(filter) {
  if (filter == null) return null;
  const s = String(filter).trim();
  return s ? s : null;
}

function matchesFilter(session, filter, table) {
  if (!filter) return true;
  const needle = normPath(filter);
  const cwd = normPath(session.cwd);
  if (cwd && (cwd === needle || pathIsUnder(cwd, needle))) return true;
  const low = filter.toLowerCase();
  if (String((session.workspace && session.workspace.title) || '').toLowerCase() === low) return true;
  if (String(session.id).toLowerCase() === low) return true;
  if (shortId(session.id).toLowerCase() === low) return true;
  if (table.byId.has(filter)) return (session.workspace && session.workspace.id) === filter;
  return false;
}

/**
 * 扫全部会话投影缓存并规范化。
 * @param {object} [options]
 * @param {string} [options.workspace] 工作区绝对路径 / 标题 / id / session id
 * @param {number} [options.limit=0]   最多返回（0=全部）
 * @param {number} [options.now]       时间基准
 * @param {number} [options.activeWindowMs]
 * @param {number} [options.recentTurns]
 * @param {number} [options.snippetChars]
 * @param {boolean}[options.includeArchived=true]
 * @param {boolean}[options.topLevelOnly=false] 只保留顶层会话（隐藏子代理会话）
 * @returns {Promise<object>} SessionIndex
 */
export async function listSessions(options = {}) {
  const t0 = performance.now();
  const paths = resolvePaths(options);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const activeWindowMs = Number.isFinite(options.activeWindowMs) ? options.activeWindowMs : DEFAULTS.activeWindowMs;
  const recentTurns = Number.isFinite(options.recentTurns) ? options.recentTurns : DEFAULTS.recentTurns;
  const snippetChars = Number.isFinite(options.snippetChars) ? options.snippetChars : DEFAULTS.snippetChars;
  const includeArchived = options.includeArchived !== false;
  const filter = normalizeFilter(options.workspace);
  const parseOptions = { snippetChars: snippetChars, recentTurns: recentTurns };

  const pair = await Promise.all([listSessionDir(paths.projcacheDir), loadWorkspaceTable(paths)]);
  const dirResult = pair[0];
  const table = pair[1];

  const results = await mapLimit(dirResult.files, options.readConcurrency || DEFAULTS.readConcurrency, (f) =>
    readSessionFile(path.join(paths.projcacheDir, f.name), f.name.replace(/\.json$/i, ''), f.size, parseOptions),
  );

  const warnings = dirResult.warnings.concat(table.error ? ['workspace.json: ' + table.error] : []);
  const corrupt = [];
  const sessions = [];
  let totalBytes = 0;

  for (const r of results) {
    if (!r) continue;
    if (!r.ok) { corrupt.push({ id: r.id, file: r.file, error: r.error }); continue; }
    const s = r.session;
    totalBytes += s.size || 0;
    const ws = matchWorkspace(table, s.cwd);
    s.workspace = ws
      ? { id: ws.id, title: ws.title, path: ws.path, registered: true }
      : { id: null, title: s.cwd ? path.basename(s.cwd) : '未登记', path: s.cwd || '', registered: false };
    s.archived = table.archived.has(s.id) || table.archived.has('session-' + s.id);
    s.status = inferStatus(s, { now: now, activeWindowMs: activeWindowMs });
    sessions.push(s);
  }

  sessions.sort((a, b) => {
    const ax = a.lastActiveAt == null ? -1 : a.lastActiveAt;
    const bx = b.lastActiveAt == null ? -1 : b.lastActiveAt;
    if (ax !== bx) return bx - ax;
    if (a.turns !== b.turns) return b.turns - a.turns;
    return String(a.id).localeCompare(String(b.id));
  });

  const scoped = sessions.filter((s) => (includeArchived || !s.archived) && matchesFilter(s, filter, table));
  const filtered = options.topLevelOnly === true ? scoped.filter((s) => isTopLevelSession(s.id)) : scoped;

  const rollup = new Map();
  for (const s of filtered) {
    const key = (s.workspace && s.workspace.path) || (s.workspace && s.workspace.title) || '(未登记)';
    let cur = rollup.get(key);
    if (!cur) {
      cur = {
        path: s.workspace ? s.workspace.path : '',
        title: (s.workspace && s.workspace.title) || '(未登记)',
        registered: Boolean(s.workspace && s.workspace.registered),
        sessions: 0, blank: 0, turns: 0, lastActiveAt: null,
      };
      rollup.set(key, cur);
    }
    cur.sessions++;
    if (s.blank) cur.blank++;
    cur.turns += s.turns;
    if (s.lastActiveAt != null && (cur.lastActiveAt == null || s.lastActiveAt > cur.lastActiveAt)) cur.lastActiveAt = s.lastActiveAt;
  }
  const workspaces = Array.from(rollup.values()).sort((a, b) => b.sessions - a.sessions);

  const counts = { sessions: filtered.length, blank: 0, running: 0, active: 0, idle: 0, archived: 0, turns: 0 };
  for (const s of filtered) {
    counts[s.status] = (counts[s.status] || 0) + 1;
    if (s.archived) counts.archived++;
    counts.turns += s.turns;
  }

  const limited = Number.isFinite(options.limit) && options.limit > 0 ? filtered.slice(0, options.limit) : filtered;

  return {
    version: VERSION,
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    durationMs: Math.round(performance.now() - t0),
    paths: {
      dshHome: paths.dshHome,
      projcacheDir: paths.projcacheDir,
      workspaceJson: paths.workspaceJson,
      skillsDir: paths.skillsDir,
    },
    workspaceFilter: filter,
    corruptCount: corrupt.length,
    corrupt: corrupt,
    warnings: warnings,
    totals: {
      files: dirResult.files.length,
      sessions: counts.sessions,
      turns: counts.turns,
      bytes: totalBytes,
      workspaces: workspaces.length,
      blank: counts.blank,
      running: counts.running,
      active: counts.active,
      idle: counts.idle,
      archived: counts.archived,
      hiddenSubagents: scoped.length - filtered.length,
    },
    workspaces: workspaces,
    sessions: limited,
    truncated: limited.length < filtered.length,
  };
}

/* ────────────────────────────── 主 API：buildDigest ────────────────────────────── */

/**
 * 会话要点 + 记忆 + 技能的摘要。
 * @param {object} [options] 同 listSessions，另加 digestTurns / skillDirs
 * @returns {Promise<object>} Digest
 */
export async function buildDigest(options = {}) {
  const t0 = performance.now();
  const paths = resolvePaths(options);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const digestTurns = Number.isFinite(options.digestTurns) ? options.digestTurns : DEFAULTS.digestTurns;
  const snippetChars = Number.isFinite(options.snippetChars) ? options.snippetChars : DEFAULTS.snippetChars;

  const index = await listSessions(Object.assign({}, options, {
    now: now,
    recentTurns: Math.max(digestTurns, DEFAULTS.recentTurns),
    snippetChars: snippetChars,
  }));

  const extraSkillDirs = (options.skillDirs || []).slice();
  if (options.workspace && path.isAbsolute(String(options.workspace))) {
    extraSkillDirs.push(path.join(String(options.workspace), '.dsh', 'skills'));
  }

  const pair = await Promise.all([loadMemory(paths), loadSkills(paths, extraSkillDirs)]);
  const memory = pair[0];
  const skillResult = pair[1];

  const entries = [];
  for (const s of index.sessions) {
    if (s.blank) continue;
    const prompts = (s._prompts || []).filter(Boolean);
    const bullets = [];
    const seen = new Set();
    for (let i = prompts.length - 1; i >= 0 && bullets.length < digestTurns; i--) {
      const text = clip(prompts[i], snippetChars);
      if (!text) continue;
      const key = text.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      bullets.unshift(text);
    }
    entries.push({
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      workspace: (s.workspace && s.workspace.title) || null,
      status: s.status,
      turns: s.turns,
      steps: s.steps,
      lastActiveAt: s.lastActiveAt,
      lastActiveStamp: formatStamp(s.lastActiveAt),
      bullets: bullets,
      goalsActive: s.goals.active,
      todosOpen: s.todos.open,
    });
  }

  return {
    version: VERSION,
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    durationMs: Math.round(performance.now() - t0),
    indexDurationMs: index.durationMs,
    workspaceFilter: index.workspaceFilter,
    totals: index.totals,
    workspaces: index.workspaces,
    corruptCount: index.corruptCount,
    sessions: entries,
    memory: {
      entries: memory.entries,
      bytes: memory.bytes,
      files: memory.files,
      memory: memory.memory,
      user: memory.user,
    },
    skills: skillResult.skills,
    skillDirs: skillResult.dirs,
    warnings: index.warnings.concat(skillResult.warnings),
  };
}

/* ────────────────────────────── 渲染：会话块 ────────────────────────────── */

const STATUS_TAG = { running: ' ⚡running', active: ' ●active', blank: ' ·blank', idle: '' };

/**
 * 单个会话 → 行数组（默认 ≤8 行）。
 * @returns {string[]}
 */
export function sessionLines(session, options = {}) {
  const full = Boolean(options.full);
  const maxLines = Number.isFinite(options.maxLines) ? options.maxLines : DEFAULTS.maxLinesPerSession;
  const snippetChars = Number.isFinite(options.snippetChars) ? options.snippetChars : DEFAULTS.snippetChars;
  const recentTurns = Number.isFinite(options.recentTurns) ? options.recentTurns : DEFAULTS.recentTurns;
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const lines = [];
  const id = shortId(session.id);
  lines.push('### ' + inlineSafe(session.title || '(无标题)') + ' ' + BT + id + BT + (STATUS_TAG[session.status] || ''));

  const ws = session.workspace || {};
  const wsName = ws.registered === false ? ws.title + '(未登记)' : ws.title || '—';
  const activity = session.lastActiveAt == null ? '无活动' : formatStamp(session.lastActiveAt) + ' (' + formatAge(session.lastActiveAt, now) + ')';
  lines.push('- ' + inlineSafe(wsName) + ' · ' + session.turns + ' turns / ' + session.steps + ' steps · 上次 ' + activity + (session.archived ? ' · archived' : ''));

  const turns = (session.recentTurns || []).slice(-(full ? Math.max(recentTurns, 6) : recentTurns));
  if (full) {
    if (session.openStep) lines.push('- running: turn ' + (session.openStep.turn == null ? '?' : session.openStep.turn) + ' step ' + (session.openStep.step == null ? '?' : session.openStep.step));
    if (session.goals && session.goals.active) lines.push('- goal: active');
    if (session.todos && session.todos.open) lines.push('- todos: ' + session.todos.open + ' open');
    for (const t of turns) {
      lines.push('- T' + (t.turn == null ? '?' : t.turn) + ' prompt: ' + (inlineSafe(clip(t.prompt, snippetChars)) || '—'));
      lines.push('  └ response: ' + (inlineSafe(clip(t.response, snippetChars)) || '—'));
    }
  } else {
    for (const t of turns) {
      const r = t.response ? ' ⇒ ' + inlineSafe(clip(t.response, Math.min(60, snippetChars))) : '';
      lines.push('- T' + (t.turn == null ? '?' : t.turn) + ' ' + (inlineSafe(clip(t.prompt, snippetChars)) || '(空)') + r);
    }
  }
  if (!turns.length && !session.blank) lines.push('- (无 turn 大纲)');

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines - 1);
    kept.push('- …(截断 ' + (lines.length - (maxLines - 1)) + ' 行，用 --full 展开)');
    return kept;
  }
  return lines;
}

/* ────────────────────────────── 渲染：Markdown ────────────────────────────── */

function assemble(head, blocks, foot) {
  const parts = [];
  for (const h of head) parts.push(h);
  if (blocks.length) parts.push('');
  for (const b of blocks) {
    for (const l of b.lines) parts.push(l);
    parts.push('');
  }
  for (const f of foot) parts.push(f);
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function listFooter(shown, total, ctx) {
  const out = [];
  if (shown < total) out.push('> 省略 ' + (total - shown) + ' 个会话（已显示最近活跃的 ' + shown + ' 个；用 --limit N / --full 展开）。');
  out.push('<!-- butler-indexer v' + VERSION + ' · 预算 ' + formatBytes(ctx.maxBytes) + (ctx.full ? ' · full' : '') + ' -->');
  return out;
}

/**
 * 生成给模型读的紧凑 Markdown（默认总长 ≤8 KiB、每会话 ≤8 行）。
 * @param {object} index listSessions() 的返回值
 * @param {object} [options]
 * @param {boolean}[options.full=false]
 * @param {number} [options.maxBytes=8192] 硬字节预算
 * @param {number} [options.maxSessions]   最多几个会话块（默认 full ? 全部 : 20）
 * @param {number} [options.maxLinesPerSession=8]
 * @param {boolean}[options.includeBlank=false]
 * @returns {string}
 */
export function renderMarkdown(index, options = {}) {
  const full = Boolean(options.full);
  const now = Number.isFinite(options.now) ? options.now : (index && index.generatedAt) || Date.now();
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULTS.maxBytes;
  // 默认模式每会话 ≤8 行；--full 是为展开用的，放宽到 40 行，仍受 maxBytes 硬约束
  const maxLinesPerSession = Number.isFinite(options.maxLinesPerSession)
    ? options.maxLinesPerSession
    : full
      ? 40
      : DEFAULTS.maxLinesPerSession;
  const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : (full ? Number.POSITIVE_INFINITY : DEFAULTS.maxSessions);
  const includeBlank = options.includeBlank === true;
  const snippetChars = Number.isFinite(options.snippetChars) ? options.snippetChars : DEFAULTS.snippetChars;

  if (!index || !Array.isArray(index.sessions)) return '> 无索引数据（先用 listSessions() 生成）。\n';

  const t = index.totals || {};
  const head = [
    '# DSH 会话总览' + (index.workspaceFilter ? ' · 过滤: ' + inlineSafe(index.workspaceFilter) : ''),
    '',
    '- 生成 ' + formatStamp(now) + ' · 会话 ' + (t.sessions || 0) + '（有内容 ' + ((t.sessions || 0) - (t.blank || 0)) + ' / 空白 ' + (t.blank || 0) + '）· turns ' + (t.turns || 0),
    '- 状态 running ' + (t.running || 0) + ' · active ' + (t.active || 0) + ' · idle ' + (t.idle || 0) +
      (index.corruptCount ? ' · ⚠ 跳过损坏 ' + index.corruptCount : '') +
      (t.archived ? ' · 已归档 ' + t.archived : '') +
      (t.hiddenSubagents ? ' · 已隐藏子代理会话 ' + t.hiddenSubagents : ''),
    '- 工作区 ' + (t.workspaces || 0) + ' · 扫描 ' + (t.files || 0) + ' 个缓存文件 (' + formatBytes(t.bytes || 0) + ') · 用时 ' + (index.durationMs || 0) + 'ms',
  ];

  if (Array.isArray(index.workspaces) && index.workspaces.length) {
    head.push('', '## 工作区');
    for (const w of index.workspaces) {
      head.push('- **' + inlineSafe(w.title) + '** · ' + w.sessions + ' 会话 · ' + w.turns + ' turns · 最近 ' + (w.lastActiveAt ? formatStamp(w.lastActiveAt) : '—'));
    }
  }
  if (index.warnings && index.warnings.length) head.push('', ...index.warnings.map((w) => '> ⚠ ' + inlineSafe(w)));

  const pool = (index.sessions || []).filter((s) => includeBlank || !s.blank);
  head.push('', '## 会话（按最近活跃排序）');

  const ctx = { maxBytes: maxBytes, full: full };
  const blocks = [];
  for (const s of pool) {
    if (blocks.length >= maxSessions) break;
    const lines = sessionLines(s, { full: full, maxLines: maxLinesPerSession, snippetChars: snippetChars, recentTurns: full ? 6 : DEFAULTS.recentTurns, now: now });
    const candidate = assemble(head, blocks.concat([{ lines: lines }]), listFooter(blocks.length + 1, pool.length, ctx));
    if (byteLen(candidate) > maxBytes) break;
    blocks.push({ lines: lines });
  }

  const out = assemble(head, blocks, listFooter(blocks.length, pool.length, ctx));
  if (byteLen(out) <= maxBytes) return out;
  return assemble(head.slice(0, 3), [], ['<!-- 预算 ' + formatBytes(maxBytes) + ' 不足，已截断 -->']);
}

/** Digest → Markdown（同样受 maxBytes 约束，按优先级退化）。 */
export function renderDigestMarkdown(digest, options = {}) {
  const full = Boolean(options.full);
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULTS.maxBytes;
  const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : (full ? 40 : 12);
  const bulletLimit = Number.isFinite(options.bulletLimit) ? options.bulletLimit : (full ? 4 : 2);
  const now = Number.isFinite(options.now) ? options.now : (digest && digest.generatedAt) || Date.now();
  if (!digest) return '> 无摘要数据（先调用 buildDigest()）。\n';

  const t = digest.totals || {};
  const head = [
    '# DSH 摘要' + (digest.workspaceFilter ? ' · 过滤: ' + inlineSafe(digest.workspaceFilter) : ''),
    '',
    '- 生成 ' + formatStamp(now) + ' · 会话 ' + (t.sessions || 0) + '（空白 ' + (t.blank || 0) + '）· turns ' + (t.turns || 0) + ' · running ' + (t.running || 0),
    '- 记忆 ' + (digest.memory ? digest.memory.entries : 0) + ' 条 (' + formatBytes((digest.memory && digest.memory.bytes) || 0) + ') · 技能 ' + ((digest.skills && digest.skills.length) || 0) + ' 个 · 用时 ' + (digest.durationMs || 0) + 'ms',
  ];

  if (Array.isArray(digest.skills) && digest.skills.length) {
    head.push('', '## 技能');
    for (const s of digest.skills) head.push('- **' + inlineSafe(s.name) + '** — ' + (inlineSafe(clip(s.description, full ? 200 : 90)) || '(无描述)'));
  }

  const memFiles = ((digest.memory && digest.memory.files) || []).map((f) => f.kind + ':' + f.entries + '条/' + formatBytes(f.bytes || 0));
  head.push('', '## 记忆 · ' + ((digest.memory && digest.memory.entries) || 0) + ' 条', '- ' + (memFiles.length ? memFiles.join(' · ') : '未找到 MEMORY.md / USER.md'));

  const pool = (digest.sessions || []).filter((s) => Array.isArray(s.bullets) && s.bullets.length);
  head.push('', '## 会话要点');

  const blocks = [];
  for (const s of pool) {
    if (blocks.length >= maxSessions) break;
    const lines = ['### ' + inlineSafe(s.title || '(无标题)') + ' ' + BT + shortId(s.id) + BT + (STATUS_TAG[s.status] || '')];
    lines.push('- ' + inlineSafe(s.workspace || '—') + ' · ' + s.turns + ' turns · 上次 ' + s.lastActiveStamp + (s.todosOpen ? ' · todo ' + s.todosOpen : ''));
    for (const b of s.bullets.slice(-bulletLimit)) lines.push('- ' + inlineSafe(b));
    const candidate = assemble(head, blocks.concat([{ lines: lines }]), []);
    if (byteLen(candidate) > maxBytes) break;
    blocks.push({ lines: lines });
  }

  const tail = (n) => {
    const out = [];
    const left = pool.length - n;
    if (left > 0) out.push('> 省略 ' + left + ' 个会话要点（用 --full 或 --workspace <path> 收窄）。');
    out.push('<!-- butler-indexer v' + VERSION + ' · digest · 预算 ' + formatBytes(maxBytes) + ' -->');
    return out;
  };

  let out = assemble(head, blocks, tail(blocks.length));
  while (byteLen(out) > maxBytes && blocks.length) {
    blocks.pop();
    out = assemble(head, blocks, tail(blocks.length));
  }
  return out;
}

/** 一行统计（给插件 / 日志）。 */
export function summarize(index) {
  const t = (index && index.totals) || {};
  return {
    sessions: t.sessions || 0,
    blank: t.blank || 0,
    running: t.running || 0,
    active: t.active || 0,
    idle: t.idle || 0,
    turns: t.turns || 0,
    workspaces: t.workspaces || 0,
    corrupt: (index && index.corruptCount) || 0,
    durationMs: (index && index.durationMs) || 0,
  };
}

/** 便捷工厂：固化常用选项。 */
export function createIndexer(options = {}) {
  return {
    options: options,
    paths: resolvePaths(options),
    list: (o) => listSessions(Object.assign({}, options, o)),
    digest: (o) => buildDigest(Object.assign({}, options, o)),
    render: (index, o) => renderMarkdown(index, o),
    renderDigest: (digest, o) => renderDigestMarkdown(digest, o),
  };
}

/* ────────────────────────────── CLI ────────────────────────────── */

const HELP = [
  'dsh-butler indexer — DSH 会话索引 + 摘要（只读，零依赖，Node>=22）',
  '',
  '用法:',
  '  node lib/indexer.mjs list    [选项]    工作区会话总览（Markdown）',
  '  node lib/indexer.mjs digest  [选项]    会话要点 + 记忆 + 技能摘要（Markdown）',
  '  node lib/indexer.mjs stats   [选项]    一行 JSON 统计',
  '  node lib/indexer.mjs json    [选项]    listSessions() 完整 JSON',
  '',
  '选项:',
  '  --workspace <path|title|id>   只看某个工作区（绝对路径 / 工作区标题 / 工作区 id）',
  '  --full                        展开：更多轮次、prompt/response 分行、goal/todos',
  '  --limit <n>                   最多渲染 n 个会话块（默认 20；--full 不限）',
  '  --max-bytes <n>               输出字节预算（默认 8192）',
  '  --recent <n>                  每会话带最近 n 轮（默认 3）',
  '  --snippet <n>                 prompt/response 截断字符数（默认 120）',
  '  --json                        以 JSON 输出',
  '  --out <file>                  写入文件（拒绝写入 DSH_HOME）',
  '  --dsh-home <path>             覆盖 DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）',
  '  --mnemon-home <path>          覆盖 Mnemon 目录（默认 ~/.mnemon）',
  '  --no-archived                 排除已归档会话',
  '  --top-level                   只看顶层会话（隐藏子代理会话）',
  '  --include-blank               渲染空白会话（默认省略）',
  '  -h, --help                    显示本帮助',
  '',
].join('\n');

function parseArgv(argv) {
  const out = { _: [], flags: {} };
  const BOOL = new Set(['help', 'full', 'json', 'no-archived', 'top-level', 'include-blank', 'verbose']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { out.flags.help = true; continue; }
    if (a.indexOf('--') !== 0) { out._.push(a); continue; }
    const key = a.slice(2);
    if (BOOL.has(key)) { out.flags[key] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || (next.indexOf('--') === 0 && next.length > 2)) { out.flags[key] = true; continue; }
    out.flags[key] = next;
    i++;
  }
  return out;
}

function num(v, fallback) {
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function assertWritableTarget(target, paths) {
  const abs = path.resolve(target);
  if (pathIsUnder(abs, paths.dshHome) || pathIsUnder(abs, paths.mnemonHome)) {
    throw new Error('拒绝写入 DSH 数据目录（本模块只读）: ' + target);
  }
}

async function emit(text, flags, paths) {
  if (typeof flags.out === 'string') {
    const abs = path.resolve(flags.out);
    assertWritableTarget(abs, paths);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text, 'utf8');
    process.stderr.write('写入 ' + abs + ' (' + byteLen(text) + ' bytes)\n');
    return;
  }
  process.stdout.write(text);
}

function stripInternal(index) {
  return Object.assign({}, index, { sessions: index.sessions.map((s) => {
    const o = Object.assign({}, s);
    delete o._prompts;
    return o;
  }) });
}

export async function main(argv) {
  const args = argv || process.argv.slice(2);
  const parsed = parseArgv(args);
  const flags = parsed.flags;
  if (flags.help || !parsed._.length) { process.stdout.write(HELP); return 0; }

  const cmd = parsed._[0];
  const common = {
    workspace: typeof flags.workspace === 'string' ? flags.workspace : undefined,
    includeArchived: flags['no-archived'] ? false : true,
    topLevelOnly: Boolean(flags['top-level']),
    dshHome: typeof flags['dsh-home'] === 'string' ? flags['dsh-home'] : undefined,
    mnemonHome: typeof flags['mnemon-home'] === 'string' ? flags['mnemon-home'] : undefined,
  };
  const renderOpts = {
    full: Boolean(flags.full),
    maxBytes: num(flags['max-bytes'], DEFAULTS.maxBytes),
    maxSessions: num(flags.limit, undefined),
    includeBlank: Boolean(flags['include-blank']),
    snippetChars: num(flags.snippet, DEFAULTS.snippetChars),
  };
  const listOpts = Object.assign({}, common, {
    recentTurns: num(flags.recent, DEFAULTS.recentTurns),
    snippetChars: num(flags.snippet, DEFAULTS.snippetChars),
    limit: num(flags.limit, 0), // --limit 同时约束 JSON 返回条数
  });
  const paths = resolvePaths(common);

  if (cmd === 'list' || cmd === 'sessions') {
    const index = await listSessions(listOpts);
    await emit(flags.json ? JSON.stringify(stripInternal(index), null, 2) + '\n' : renderMarkdown(index, renderOpts), flags, paths);
    return 0;
  }
  if (cmd === 'digest') {
    const digest = await buildDigest(Object.assign({}, listOpts, { digestTurns: num(flags.recent, DEFAULTS.digestTurns) }));
    await emit(flags.json ? JSON.stringify(digest, null, 2) + '\n' : renderDigestMarkdown(digest, renderOpts), flags, paths);
    return 0;
  }
  if (cmd === 'stats') {
    const index = await listSessions(listOpts);
    await emit(JSON.stringify(Object.assign(summarize(index), { corrupt: index.corruptCount, warnings: index.warnings }), null, 2) + '\n', flags, paths);
    return 0;
  }
  if (cmd === 'json') {
    const index = await listSessions(listOpts);
    await emit(JSON.stringify(stripInternal(index), null, 2) + '\n', flags, paths);
    return 0;
  }
  process.stderr.write('未知子命令: ' + cmd + '\n\n' + HELP);
  return 2;
}

let DIRECT = false;
try {
  DIRECT = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
} catch (_) { DIRECT = false; }

if (DIRECT) {
  main().then((code) => { if (code) process.exitCode = code; }, (err) => {
    process.stderr.write('error: ' + ((err && err.stack) || err) + '\n');
    process.exitCode = 1;
  });
}
