#!/usr/bin/env node
/**
 * test/indexer.selftest.mjs — lib/indexer.mjs 的自检（零依赖，夹具在临时目录；末尾对真实 ~/.dsh 只读测一次性能）
 *
 *   node test/indexer.selftest.mjs
 *
 * 覆盖：坏 JSON 跳过并计数、每会话行数上限、字节预算、工作区过滤、
 *       § 记忆条目计数、SKILL.md frontmatter、--out 拒绝写入 DSH_HOME、
 *       真实数据全量扫描性能。
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as idx from '../lib/indexer.mjs';

let pass = 0;
const fails = [];
const lines = [];

function check(name, cond, detail) {
  if (cond) { pass++; lines.push('PASS ' + name); }
  else { fails.push(name + (detail ? ' → ' + detail : '')); lines.push('FAIL ' + name + (detail ? ' → ' + detail : '')); }
}

function rec(cwd, title, turns, promptAt) {
  const list = [];
  for (let i = 0; i < turns; i++) list.push({ turn: i + 1, seq: i, prompt: 'prompt-' + (i + 1) + ' 测试输入', response: 'response-' + (i + 1) });
  return {
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt: 1700000000000, cwd: cwd, isSeeded: false },
      rows: {
        title: { ver: 1, seq: 1, val: title },
        workingDirectory: { ver: 1, seq: 1, val: cwd },
        sessionStats: { ver: 1, seq: 1, val: { turns: turns, steps: turns * 2, openStep: null, lastTurn: turns || null } },
        sessionListMetadata: { ver: 1, seq: 1, val: { blank: turns === 0 && !title, lastPromptAt: promptAt } },
        turnOutline: { ver: 1, seq: 1, val: { turns: list } },
        goal: { ver: 1, seq: 1, val: { current: null, failure: null } },
        todos: { ver: 1, seq: 1, val: null },
      },
    },
  };
}

async function writeJson(file, obj) { await fsp.writeFile(file, JSON.stringify(obj), 'utf8'); }

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler-idx-'));
  const sessDir = path.join(root, 'storages', 'session_projcache', 'sessions');
  const skillsDir = path.join(root, 'skills');
  const wsA = path.join(root, 'ws', 'alpha');
  const wsB = path.join(root, 'ws', 'beta');
  await fsp.mkdir(sessDir, { recursive: true });
  await fsp.mkdir(path.join(skillsDir, 'skill-a'), { recursive: true });
  await fsp.mkdir(wsA, { recursive: true });
  await fsp.mkdir(wsB, { recursive: true });

  const now = 1800000000000;
  // 6 个健康会话：4 个 alpha（含 1 个 12 轮的、1 个空白），2 个 beta
  await writeJson(path.join(sessDir, 'session-aaaa1111-1111-1111-1111-111111111111.json'), rec(wsA, 'alpha one', 3, now - 60000));
  await writeJson(path.join(sessDir, 'session-aaaa2222-2222-2222-2222-222222222222.json'), rec(wsA, 'alpha long', 12, now - 120000));
  await writeJson(path.join(sessDir, 'session-aaaa3333-3333-3333-3333-333333333333.json'), rec(wsA, null, 0, null));
  await writeJson(path.join(sessDir, 'session-aaaa4444-4444-4444-4444-444444444444.json'), rec(wsA, 'alpha old', 2, now - 86400000 * 3));
  await writeJson(path.join(sessDir, 'session-bbbb1111-1111-1111-1111-111111111111.json'), rec(wsB, 'beta one', 1, now - 300000));
  await writeJson(path.join(sessDir, 'cccc1111-1111-1111-1111-111111111111.json'), rec(wsB, 'beta legacy', 2, now - 30 * 60000));
  // 2 个坏文件
  await fsp.writeFile(path.join(sessDir, 'session-dead0001-0000-0000-0000-000000000001.json'), '{"version":7,"record":{"identity":{"cwd":"x"}', 'utf8');
  await fsp.writeFile(path.join(sessDir, 'session-dead0002-0000-0000-0000-000000000002.json'), 'not json at all', 'utf8');
  // 1 个结构不合法（无 identity）
  await writeJson(path.join(sessDir, 'session-dead0003-0000-0000-0000-000000000003.json'), { version: 7, record: { rows: {} } });
  // 非 json 文件应被忽略
  await fsp.writeFile(path.join(sessDir, 'notes.txt'), 'ignore me', 'utf8');

  await writeJson(path.join(root, 'storages', 'workspace.json'), {
    version: 2,
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, archivedSessionIds: ['session-aaaa4444-4444-4444-4444-444444444444'] },
    tables: {
      workspaces: {
        w1: { path: wsA, title: 'Alpha', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        w2: { path: wsB, title: 'Beta', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    },
  });

  await fsp.writeFile(path.join(root, 'MEMORY.md'), '条目一\n§\n条目二\n§\n条目三\n', 'utf8');
  await fsp.writeFile(path.join(root, 'USER.md'), '用户画像\n', 'utf8');

  await fsp.writeFile(path.join(skillsDir, 'skill-a', 'SKILL.md'), [
    '---',
    'name: skill-a',
    'description: 用于测试的技能描述',
    '---',
    '',
    '# Skill A',
    '',
    '正文第一段。',
    '',
  ].join('\n'), 'utf8');

  const opts = { dshHome: root, mnemonHome: path.join(root, 'nope'), now: now };

  // ── 1. 扫描：坏文件跳过并计数 ──
  const index = await idx.listSessions(opts);
  check('corrupt 计数 = 3', index.corruptCount === 3, 'actual ' + index.corruptCount);
  check('有效会话 = 6', index.totals.sessions === 6, 'actual ' + index.totals.sessions);
  check('忽略非 .json', index.totals.files === 9, 'actual ' + index.totals.files);
  check('不中断整轮扫描', typeof index.durationMs === 'number');

  // ── 2. 工作区归类 ──
  const alpha = index.sessions.filter((s) => s.workspace.id === 'w1');
  check('workspace 归类 alpha = 4', alpha.length === 4, 'actual ' + alpha.length);
  check('workspace 归类 beta = 2', index.sessions.filter((s) => s.workspace.id === 'w2').length === 2);
  check('空白统计 = 1', index.totals.blank === 1, 'actual ' + index.totals.blank);
  check('archived 标记', index.sessions.some((s) => s.archived === true));

  // ── 3. 状态推断 ──
  const one = index.sessions.find((s) => s.id === 'session-aaaa1111-1111-1111-1111-111111111111');
  check('1 分钟内活跃 → active', one.status === 'active', one.status);
  const old = index.sessions.find((s) => s.id === 'session-aaaa4444-4444-4444-4444-444444444444');
  check('3 天前 → idle', old.status === 'idle', old.status);
  const blank = index.sessions.find((s) => s.id === 'session-aaaa3333-3333-3333-3333-333333333333');
  check('0 轮 → blank', blank.status === 'blank', blank.status);

  // ── 4. 排序：最近活跃在前，空白最后 ──
  const order = index.sessions.map((s) => s.id);
  check('按最近活跃排序', order[0] === 'session-aaaa1111-1111-1111-1111-111111111111', order[0]);
  check('空白排最后', order[order.length - 1] === 'session-aaaa3333-3333-3333-3333-333333333333', order[order.length - 1]);

  // ── 5. 每会话行数上限 ──
  const longOne = index.sessions.find((s) => s.title === 'alpha long');
  const ls = idx.sessionLines(longOne, { now: now, maxLines: 8 });
  check('每会话 ≤8 行（默认）', ls.length <= 8, 'actual ' + ls.length);
  const lsUncapped = idx.sessionLines(longOne, { now: now, full: true, maxLines: 100 });
  check('--full 展开更多内容', lsUncapped.length > ls.length);

  // ── 6. 字节预算 ──
  for (const budget of [512, 1024, 2048, 4096, 8192]) {
    const md = idx.renderMarkdown(index, { maxBytes: budget, now: now });
    check('预算 ' + budget + 'B 内', Buffer.byteLength(md, 'utf8') <= budget, 'actual ' + Buffer.byteLength(md, 'utf8'));
  }
  const mdDefault = idx.renderMarkdown(index, { now: now });
  check('默认输出 ≤8KB', Buffer.byteLength(mdDefault, 'utf8') <= 8192, 'actual ' + Buffer.byteLength(mdDefault, 'utf8'));
  const mdFullWide = idx.renderMarkdown(index, { now: now, full: true, maxBytes: 65536 });
  check('--full 展开行数 > 默认', mdFullWide.split('\n').length > mdDefault.split('\n').length, mdFullWide.split('\n').length + ' vs ' + mdDefault.split('\n').length);

  // ── 7. 工作区过滤 ──
  const onlyBeta = await idx.listSessions({ ...opts, workspace: wsB });
  check('--workspace 路径过滤 = 2', onlyBeta.totals.sessions === 2, 'actual ' + onlyBeta.totals.sessions);
  const byTitle = await idx.listSessions({ ...opts, workspace: 'Beta' });
  check('--workspace 标题过滤 = 2', byTitle.totals.sessions === 2, 'actual ' + byTitle.totals.sessions);
  const byId = await idx.listSessions({ ...opts, workspace: 'w1' });
  check('--workspace id 过滤 = 4', byId.totals.sessions === 4, 'actual ' + byId.totals.sessions);

  // ── 8. limit / includeArchived ──
  const lim = await idx.listSessions({ ...opts, limit: 2 });
  check('limit=2', lim.sessions.length === 2 && lim.truncated === true);
  const noArch = await idx.listSessions({ ...opts, includeArchived: false });
  check('--no-archived 排除 1 个', noArch.totals.sessions === 5, 'actual ' + noArch.totals.sessions);
  const top = await idx.listSessions({ ...opts, topLevelOnly: true });
  check('topLevelOnly 隐藏 1 个子代理会话', top.totals.sessions === 5 && top.totals.hiddenSubagents === 1, top.totals.sessions + ' / ' + top.totals.hiddenSubagents);

  // ── 9. 记忆 / 技能 ──
  check('§ 条目计数 = 3', idx.countMemoryEntries('a\n§\nb\n§\nc') === 3);
  const fm = idx.parseFrontmatter('---\nname: x\ndescription: yy\n---\n\n# T\n');
  check('frontmatter name', fm.data.name === 'x', JSON.stringify(fm.data));
  check('frontmatter description', fm.data.description === 'yy');
  const digest = await idx.buildDigest(opts);
  check('digest 记忆条目 = 4', digest.memory.entries === 4, 'actual ' + digest.memory.entries);
  check('digest 技能 = 1', digest.skills.length === 1, 'actual ' + digest.skills.length);
  check('digest 技能描述', digest.skills[0].description === '用于测试的技能描述');
  const dmd = idx.renderDigestMarkdown(digest, { now: now });
  check('digest ≤8KB', Buffer.byteLength(dmd, 'utf8') <= 8192, 'actual ' + Buffer.byteLength(dmd, 'utf8'));
  const dmdTiny = idx.renderDigestMarkdown(digest, { now: now, maxBytes: 700 });
  check('digest 700B 预算内', Buffer.byteLength(dmdTiny, 'utf8') <= 700, 'actual ' + Buffer.byteLength(dmdTiny, 'utf8'));

  // ── 10. 不写 DSH_HOME ──
  let refused = false;
  try {
    await idx.main(['list', '--dsh-home', root, '--out', path.join(root, 'hack.md')]);
  } catch (err) {
    refused = true;
  }
  check('--out 拒绝写入 DSH_HOME', refused);
  const exists = await fsp.stat(path.join(root, 'hack.md')).then(() => true, () => false);
  check('拒绝后没有生成文件', exists === false);

  // ── 11. 目录不存在也不炸 ──
  const empty = await idx.listSessions({ dshHome: path.join(root, 'ghost'), now: now });
  check('缺失数据目录 → 0 会话 + 警告', empty.totals.sessions === 0 && empty.warnings.length > 0);

  // ── 12. 真实数据全量性能 ──
  const real = idx.resolvePaths({});
  const realExists = await fsp.stat(real.projcacheDir).then(() => true, () => false);
  if (realExists) {
    const times = [];
    let realIndex = null;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      realIndex = await idx.listSessions({});
      times.push(performance.now() - t0);
    }
    const sorted = times.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    lines.push('INFO 真实数据: ' + realIndex.totals.files + ' 文件 / ' + realIndex.totals.sessions + ' 会话 / ' + idx.formatBytes(realIndex.totals.bytes));
    lines.push('INFO 真实数据耗时(ms): [' + times.map((t) => t.toFixed(1)).join(', ') + '] median=' + median.toFixed(1));
    check('全量扫描 < 2000ms', median < 2000, median.toFixed(1) + 'ms');
    // 宿主可能正在写缓存，损坏数只报告不断言
    lines.push('INFO 真实数据损坏文件: ' + realIndex.corruptCount);
  } else {
    lines.push('SKIP 真实数据性能（未找到 ' + real.projcacheDir + '）');
  }

  // ── 输出 ──
  for (const l of lines) console.log(l);
  console.log('');
  console.log('selftest: ' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exitCode = 1;
  }
  return pass;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
