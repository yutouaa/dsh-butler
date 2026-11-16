// 插件层测试：桩宿主 + 临时 DSH_HOME 夹具，不碰真实 ~/.dsh。  npm test
import "./stub-host.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

const plugin = await import("../lib/index.mjs");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const ID = {
  me: "session-eeee0000-0000-0000-0000-000000000000",
  tests: "session-aaaa1111-1111-1111-1111-111111111111",
  logsA: "session-bbbb1111-1111-1111-1111-111111111111",
  logsB: "session-cccc1111-1111-1111-1111-111111111111",
  archived: "session-dddd1111-1111-1111-1111-111111111111",
  child: "ffff1111-1111-1111-1111-111111111111",
  other: "session-9999aaaa-1111-1111-1111-111111111111", // 另一个工作区的会话
};

function record(cwd, title) {
  return {
    version: 7,
    record: {
      identity: { createdAt: 1700000000000, cwd },
      rows: {
        title: { val: title },
        sessionStats: { val: { turns: 1, steps: 2, openStep: null, lastTurn: 1 } },
        sessionListMetadata: { val: { blank: false, lastPromptAt: Date.now() - 60000 } },
        turnOutline: { val: { turns: [{ turn: 1, seq: 0, prompt: "做点事", response: "好的" }] } },
      },
    },
  };
}

/**
 * 仿 cordis 4 的上下文：没在 inject 里声明就读服务会抛（宿主的真实行为），
 * ctx.inject(deps, cb) 只在依赖齐全时回调，并给回调一个声明了这些依赖的子上下文。
 */
function makeCtx(services, tools) {
  const scope = (allowed) => new Proxy({}, {
    get(_target, key) {
      if (key === "tools") return { register: (t) => tools.push(t) };
      if (key === "inject") return (deps, cb) => { if (deps.every((d) => d in services)) cb(scope(deps)); };
      if (key === "get") return (name) => services[name]; // ctx.get 不做 inject 检查
      if (typeof key !== "string") return undefined;
      if (allowed.includes(key)) return services[key];
      throw new Error(`cannot get property "${key}" without inject`);
    },
  });
  return scope([]);
}

async function setup({ services = {}, config = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "butler-test-"));
  const ws = path.join(home, "ws");
  const wsOther = path.join(home, "ws-other");
  const dir = path.join(home, "storages", "session_projcache", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(wsOther, { recursive: true });
  const put = (id, title, cwd = ws) => fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(record(cwd, title)));
  put(ID.me, "管家自己");
  put(ID.tests, "跑测试");
  put(ID.logsA, "查日志 alpha");
  put(ID.logsB, "查日志 beta");
  put(ID.archived, "旧会话");
  put(ID.child, "子代理任务");
  put(ID.other, "别处的会话", wsOther);
  fs.writeFileSync(path.join(home, "storages", "workspace.json"), JSON.stringify({
    global: { archivedSessionIds: [ID.archived] },
    tables: { workspaces: { w1: { path: ws, title: "WS" }, w2: { path: wsOther, title: "Other" } } },
  }));

  const tools = [];
  await plugin.apply(makeCtx(services, tools), { dshHome: home, ...config });
  const execIn = (id, cwd) => ({ agent: { session: { id, cwd } } });
  const call = (name, args = {}, exec = execIn(ID.me, ws)) => tools.find((t) => t.name === name).execute(args, exec);
  /** 以另一个工作区里那个会话的身份调用 */
  const callOther = (name, args = {}) => call(name, args, execIn(ID.other, wsOther));
  const audit = () => {
    try {
      return fs.readFileSync(path.join(home, "butler", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { home, tools, call, callOther, audit };
}

/** 假的 HTTP 请求/响应：调 handler，返回 { status, body } */
function http(handler, method, body) {
  return new Promise((resolve) => {
    const request = new EventEmitter();
    request.method = method;
    let status = 0;
    handler(request, { writeHead: (s) => { status = s; }, end: (payload) => resolve({ status, body: JSON.parse(payload) }) });
    if (method === "POST") {
      request.emit("data", typeof body === "string" ? body : JSON.stringify(body));
      request.emit("end");
    }
  });
}

/** webServer 桩：收集插件注册的路由 */
function webServer(authenticated) {
  const routes = [];
  return {
    routes,
    services: {
      webServer: { protocol: "http:", register: (r) => routes.push(r) },
      ...(authenticated === undefined ? {} : { connection: { browserAuth: { isAuthenticated: () => authenticated } } }),
    },
  };
}

/** 进程内通道的桩：记录 followup / flush */
function inProcess() {
  const sent = [];
  const flushed = [];
  const agent = { session: { id: "target" }, followup: (m) => sent.push(m) };
  return {
    sent,
    flushed,
    services: {
      sessionController: { resolveAgent: async (id) => (id === ID.tests ? { agent } : { error: { code: "session/not-found" } }) },
      sessions: { flush: async (s) => { flushed.push(s); return true; } },
    },
  };
}

test("注册四个工具，并写下带版本号的加载标记", async () => {
  const { tools, home } = await setup();
  assert.deepEqual(tools.map((t) => t.name), ["butler_sessions", "butler_digest", "butler_roles", "butler_dispatch"]);
  const mark = JSON.parse(fs.readFileSync(path.join(home, "butler", "last-load.json"), "utf8"));
  assert.equal(mark.version, pkg.version);
});

test("skills 服务就绪时注册随包技能", async () => {
  const providers = [];
  await setup({ services: { skills: { registerProvider: (create) => providers.push(create()) } } });
  assert.equal(providers.length, 1);
  const [candidate] = await providers[0].list();
  assert.equal(candidate.name, "butler");
  assert.ok(candidate.description.includes("管家"));
  const full = await providers[0].get({ name: "butler" });
  assert.ok(full.content.includes("butler_dispatch"));
  assert.equal(await providers[0].get({ name: "other" }), undefined);
});

test("butler_sessions 默认隐藏子代理会话", async () => {
  const { call } = await setup();
  const out = (await call("butler_sessions")).text;
  assert.ok(out.includes("跑测试"));
  assert.ok(!out.includes("子代理任务"));
  assert.ok(out.includes("已隐藏子代理会话 1"));
  assert.ok((await call("butler_sessions", { includeSubagents: true })).text.includes("子代理任务"));
});

test("butler_digest 能出摘要", async () => {
  const { call } = await setup();
  assert.ok((await call("butler_digest")).text.includes("会话要点"));
});

test("岗位表：只收顶层会话，岗位名唯一", async () => {
  const { call } = await setup();
  await assert.rejects(call("butler_roles", { action: "set", sessionId: ID.child, role: "偷渡" }), /顶层会话/);
  await call("butler_roles", { action: "set", sessionId: ID.tests, role: "测试岗", job: "回归测试" });
  await assert.rejects(call("butler_roles", { action: "set", sessionId: ID.logsA, role: "测试岗" }), /已被/);
  assert.ok((await call("butler_roles", { action: "list" })).text.includes("测试岗"));
  const dry = await call("butler_dispatch", { target: "测试岗", message: "跑一遍", dryRun: true });
  assert.ok(dry.text.includes(ID.tests));
  assert.ok((await call("butler_roles", { action: "remove", sessionId: ID.tests })).text.includes("已删除"));
});

test("目标解析：标题、歧义、归档、子代理、自己", async () => {
  const { call } = await setup();
  const dry = (target) => call("butler_dispatch", { target, message: "x", dryRun: true });
  assert.ok((await dry("跑测试")).text.includes(ID.tests));
  await assert.rejects(dry("查日志"), /匹配到 2 个会话/);
  await assert.rejects(dry("旧会话"), /找不到目标/); // 归档会话不参与标题匹配
  await assert.rejects(dry(ID.archived), /已归档/);
  await assert.rejects(dry(ID.child), /子代理/);
  await assert.rejects(dry(ID.me), /自己/);
  await assert.rejects(dry("不存在的会话"), /找不到目标/);
});

test("派活走进程内通道：带来源标记、等持久化确认、写审计", async () => {
  const ch = inProcess();
  const { call, audit } = await setup({ services: ch.services });
  const out = await call("butler_dispatch", { target: "跑测试", message: "跑一遍回归" });
  assert.ok(out.text.includes("进程内投递"));
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.flushed.length, 1);
  assert.equal(ch.sent[0].source.kind, "user");
  assert.match(ch.sent[0].content[0].text, /^【管家派活 · 来自会话 eeee0000】\n跑一遍回归$/);
  const last = audit().at(-1);
  assert.equal(last.result, "scheduled");
  assert.equal(last.channel, "in-process");
  assert.equal(last.sessionId, ID.tests);
});

test("拿不到 sessionController 时回退到调度服务", async () => {
  const created = [];
  const schedule = { create: async (req, actor) => { created.push({ req, actor }); return { id: "schedule-1", scheduledAt: "soon" }; } };
  const { call, audit } = await setup({ services: { schedule } });
  const out = await call("butler_dispatch", { target: ID.tests, message: "跑一遍回归" });
  assert.ok(out.text.includes("schedule-1"));
  assert.deepEqual(created[0].req.target, { kind: "session", sessionId: ID.tests });
  assert.deepEqual(created[0].req.timing, { kind: "after", afterSeconds: 3 });
  assert.equal(created[0].actor, ID.me);
  assert.equal(audit().at(-1).channel, "schedule");
});

test("两个通道都没有时报错并记失败审计", async () => {
  const { call, audit } = await setup();
  await assert.rejects(call("butler_dispatch", { target: "跑测试", message: "x" }), /无法派活/);
  assert.equal(audit().at(-1).result, "failed");
});

test("宿主拒绝目标时把错误码带出来并记失败审计", async () => {
  const ch = inProcess();
  const { call, audit } = await setup({ services: ch.services });
  await assert.rejects(call("butler_dispatch", { target: ID.logsA, message: "x" }), /session\/not-found/);
  assert.equal(audit().at(-1).result, "failed");
});

test("每小时限流只计真正投递成功的次数", async () => {
  const ch = inProcess();
  const { call } = await setup({ services: ch.services, config: { maxDispatchesPerHour: 1 } });
  await call("butler_dispatch", { target: "跑测试", message: "演练不计数", dryRun: true });
  await call("butler_dispatch", { target: "跑测试", message: "第一次" });
  await assert.rejects(call("butler_dispatch", { target: "跑测试", message: "第二次" }), /限流/);
  assert.equal(ch.sent.length, 1);
});

test("管家只管自己的工作区：看不到、也派不到别的工作区", async () => {
  const { call, callOther } = await setup();
  const mine = (await call("butler_sessions")).text;
  assert.ok(mine.startsWith("工作区：WS"));
  assert.ok(!mine.includes("别处的会话"));
  const theirs = (await callOther("butler_sessions")).text;
  assert.ok(theirs.includes("别处的会话"));
  assert.ok(!theirs.includes("跑测试"));
  await assert.rejects(call("butler_dispatch", { target: ID.other, message: "x", dryRun: true }), /不在当前工作区/);
  await assert.rejects(call("butler_dispatch", { target: "别处的会话", message: "x", dryRun: true }), /找不到目标/);
  await assert.rejects(call("butler_roles", { action: "set", sessionId: ID.other, role: "越界" }), /本工作区/);
});

test("岗位名只在工作区内唯一，各工作区的岗位表互不可见", async () => {
  const { call, callOther } = await setup();
  await call("butler_roles", { action: "set", sessionId: ID.tests, role: "测试岗" });
  await callOther("butler_roles", { action: "set", sessionId: ID.other, role: "测试岗" });
  assert.ok((await call("butler_roles", { action: "list" })).text.includes(ID.tests));
  assert.ok(!(await call("butler_roles", { action: "list" })).text.includes(ID.other));
  // 同名岗位各自解析到本工作区的会话；对方工作区里只有它自己，所以是「派给自己」
  assert.ok((await call("butler_dispatch", { target: "测试岗", message: "x", dryRun: true })).text.includes(ID.tests));
  await assert.rejects(callOther("butler_dispatch", { target: "测试岗", message: "x", dryRun: true }), /自己/);
});

test("按工作区启停：停用后四个工具都拒绝，别的工作区不受影响", async () => {
  const web = webServer(true);
  const { call, callOther } = await setup({ services: web.services });
  assert.equal(web.routes.length, 1);
  assert.equal(web.routes[0].path, "/dsh-butler/workspaces");
  const { handler } = web.routes[0];

  assert.deepEqual((await http(handler, "GET")).body, { defaultEnabled: true, workspaces: {} });
  assert.equal((await http(handler, "POST", { workspaceId: "w1", enabled: false })).status, 200);
  assert.deepEqual((await http(handler, "GET")).body.workspaces, { w1: false });

  for (const [name, args] of [["butler_sessions", {}], ["butler_digest", {}], ["butler_roles", { action: "list" }], ["butler_dispatch", { target: "跑测试", message: "x", dryRun: true }]]) {
    await assert.rejects(call(name, args), /没有启用管家/, name);
  }
  assert.ok((await callOther("butler_sessions")).text.includes("别处的会话"));

  await http(handler, "POST", { workspaceId: "w1", enabled: true });
  assert.ok((await call("butler_sessions")).text.includes("跑测试"));
});

test("defaultEnabled=false 时要先在工作区菜单里启用", async () => {
  const web = webServer(true);
  const { call } = await setup({ services: web.services, config: { defaultEnabled: false } });
  await assert.rejects(call("butler_sessions"), /没有启用管家/);
  await http(web.routes[0].handler, "POST", { workspaceId: "w1", enabled: true });
  assert.ok((await call("butler_sessions")).text.includes("跑测试"));
});

test("开关路由：没带窗口会话 cookie 的修改被拒，坏请求 400", async () => {
  const outside = webServer(false);
  await setup({ services: outside.services });
  assert.equal((await http(outside.routes[0].handler, "POST", { workspaceId: "w1", enabled: false })).status, 401);
  assert.deepEqual((await http(outside.routes[0].handler, "GET")).body.workspaces, {}); // 读不受限，且上面的修改没生效

  const unknown = webServer(undefined); // 宿主没有 connection 服务：无法判断，放行
  await setup({ services: unknown.services });
  const { handler } = unknown.routes[0];
  assert.equal((await http(handler, "POST", { workspaceId: "w1", enabled: false })).status, 200);
  assert.equal((await http(handler, "POST", { workspaceId: "w1" })).status, 400);
  assert.equal((await http(handler, "POST", "not json")).status, 400);
  assert.equal((await http(handler, "DELETE")).status, 405);
});

test("界面端：往工作区菜单注册一项启停开关", async () => {
  let loaded;
  const calls = [];
  let state = { defaultEnabled: true, workspaces: {} };
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m; } } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === "POST") {
      const b = JSON.parse(init.body);
      state = { ...state, workspaces: { ...state.workspaces, [b.workspaceId]: b.enabled } };
    }
    return { ok: true, json: async () => state };
  };
  try {
    await import("../lib/client.js");
    assert.equal(loaded.id, "dsh-butler");
    const client = loaded.factory();
    assert.deepEqual(client.inject, ["contextMenus"]);

    const registered = [];
    const notices = [];
    client.apply({
      effect: (fn) => fn(),
      contextMenus: { register: (c) => { registered.push(c); return () => {}; }, notify: (text) => notices.push(text) },
    });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].target, "workspace");

    const target = { workspaceId: "w1", displayTitle: "WS" };
    const [off] = await registered[0].resolve(target);
    // 默认启用，所以给的是「停用」；文案随运行环境的语言在中英文之间切换
    assert.ok(["停用管家", "Disable butler"].includes(off.label), off.label);
    await off.run();
    assert.deepEqual(JSON.parse(calls.at(-1).body), { workspaceId: "w1", enabled: false });
    assert.equal(calls.at(-1).url, "/dsh-butler/workspaces");
    assert.ok(notices[0].includes("WS"));
    const [on] = await registered[0].resolve(target);
    assert.ok(["启用管家", "Enable butler"].includes(on.label), on.label);

    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.deepEqual(await registered[0].resolve(target), []); // 取不到状态就不显示菜单项
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});
