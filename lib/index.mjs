import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { listSessions, buildDigest, renderMarkdown, renderDigestMarkdown, defaultDshHome, findWorkspace } from "./indexer.mjs";
import { loadRoles, setRole, removeRole } from "./roles.mjs";
import { resolveTarget } from "./resolve.mjs";
import { dispatchToSession } from "./dispatch.mjs";
import { skillProvider } from "./skill.mjs";
import { getWorkspaceState } from "./state.mjs";
import { setWorkspaceEnabled } from "./enable.mjs";
import { WORKSPACES_ROUTE, workspacesHandler } from "./route.mjs";

/**
 * DSH 管家（butler）插件。每个工作区一个专门的管家会话：
 * 在侧栏工作区菜单里点「启用管家」会在该工作区新建（或复用）一个管家会话，
 * 四个工具只有这个会话能用，并且只看、只派本工作区的会话（界面端见 lib/client.js）。
 * 1) 让管家会话「看得见」本工作区每个会话的标题、状态、最近在做什么；
 * 2) 聚合记忆与技能清单，不必逐个会话翻；
 * 3) 按岗位名/标题/sessionId 把活派给本工作区的另一个顶层会话。
 */
const { version: VERSION } = createRequire(import.meta.url)("../package.json");
const TOOL_NAMES = ["butler_sessions", "butler_digest", "butler_roles", "butler_dispatch"];

export const name = "butler";
// 只硬依赖 tools。sessionController / sessions / schedule / skills / webServer 按 scope 惰性解析：
// 写进顶层 inject 会让整个插件挂起等待；不声明就直接读 ctx.xxx 则会被 cordis 抛
// `cannot get property "xxx" without inject`。所以统一在 apply 里用 ctx.inject(deps, cb) 取。
export const inject = ["tools"];

export const Config = z.object({
  maxDispatchesPerHour: z.number().default(20).description("每小时派活上限（防止会话之间互相刷活）。"),
  dispatchDelaySeconds: z.number().default(3).description("走调度服务回退通道时的投递延迟（秒）。"),
  dryRun: z.boolean().default(false).description("全局演练：只解析目标、写审计，不真正投递。"),
  dshHome: z.string().description("覆盖 DSH 家目录；留空取 $DSH_HOME 或 ~/.dsh。"),
});

const TEXT = {
  schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
  render: (_args, value) => [{ type: "text", text: value.text }],
};

/** 会话索引缓存：3 秒 TTL，避免同一轮里重复全量扫描 */
let cache = { at: 0, key: "", index: null };
async function cachedIndex(options) {
  const key = JSON.stringify(options);
  const now = Date.now();
  if (cache.index && cache.key === key && now - cache.at < 3000) return cache.index;
  const index = await listSessions(options);
  cache = { at: now, key, index };
  return index;
}

const roleLine = ([id, v]) => `- **${v.role}** → \`${id}\`${v.job ? `：${v.job}` : ""}`;

export async function apply(ctx, config = {}) {
  const dshHome = config.dshHome || defaultDshHome();

  /**
   * 调用方所在的工作区就是管辖范围；只有该工作区指定的管家会话能通过，
   * 工作区没启用管家、或调用方不是那个会话，都直接拒绝。
   */
  async function scopeOf(exec) {
    const cwd = exec?.agent?.session?.cwd;
    const ws = cwd ? await findWorkspace(cwd, { dshHome }) : null;
    if (!ws) throw new Error("butler: 当前会话不在任何已登记的工作区里，没有管家可用。");
    const state = getWorkspaceState(dshHome, ws.id);
    if (!state.enabled) {
      throw new Error(`butler: 工作区「${ws.title}」没有启用管家。请让用户在侧栏该工作区的「…」菜单里点「启用管家」。`);
    }
    if (exec.agent.session.id !== state.sessionId) {
      throw new Error(`butler: 只有工作区「${ws.title}」的管家会话（${state.sessionId}）能使用管家工具，当前会话不是。请让用户去侧栏里那个「管家」会话里操作。`);
    }
    return { filter: ws.id, label: ws.title };
  }
  /** 本工作区顶层会话的 id 集合 + 属于它们的岗位 */
  async function rolesIn(scope) {
    const index = await cachedIndex({ dshHome, workspace: scope.filter, topLevelOnly: true });
    const peers = new Set(index.sessions.map((s) => s.id));
    return { peers, entries: Object.entries(loadRoles(dshHome)).filter(([id]) => peers.has(id)) };
  }

  // 惰性服务：依赖就绪时拿到声明了 inject 的子上下文；依赖下线后子上下文失活、读取会抛，按「不可用」处理
  const scopes = {};
  ctx.inject(["sessionController", "sessions"], (c) => { scopes.inProcess = c; });
  ctx.inject(["schedule"], (c) => { scopes.schedule = c; });
  ctx.inject(["skills"], (c) => { c.skills.registerProvider(() => skillProvider); });
  const service = (scope, key) => { try { return scope?.[key]; } catch { return undefined; } };
  const liveServices = () => ({
    controller: service(scopes.inProcess, "sessionController"),
    sessions: service(scopes.inProcess, "sessions"),
    schedule: service(scopes.schedule, "schedule"),
  });

  // 给界面端的开关路由。改开关必须带宿主窗口的签名会话 cookie（宿主没有 connection 服务时无法判断，放行）
  ctx.inject(["webServer"], (c) => {
    const fromBrowser = (request) => {
      try {
        const auth = c.get?.("connection")?.browserAuth;
        if (typeof auth?.isAuthenticated !== "function") return null;
        return auth.isAuthenticated(request, c.webServer.protocol === "https:") === true;
      } catch {
        return false;
      }
    };
    const setEnabled = (workspaceId, enabled) => setWorkspaceEnabled({ services: liveServices(), dshHome, workspaceId, enabled });
    c.webServer.register({ kind: "exact", path: WORKSPACES_ROUTE, handler: workspacesHandler({ dshHome, setEnabled, fromBrowser }) });
  });

  // ---- 1. 会话总览 ----
  ctx.tools.register(defineTool({
    name: "butler_sessions",
    description:
      "【仅本工作区的管家会话可用】列出本工作区的顶层会话：标题、状态（running/active/idle）、最近活跃时间、轮数，以及最近几轮在做什么。用来判断该把活派给哪个会话，或了解每个会话的工作内容。看不到别的工作区。",
    parameters: {
      full: { type: "boolean", description: "true 时每个会话展开更多轮次（更占上下文），默认只列最近 3 轮。" },
      includeSubagents: { type: "boolean", description: "true 时把子代理会话也列出来（它们不能作为派活目标，默认隐藏）。" },
      limit: { type: "integer", description: "最多返回多少会话，默认 20（full 时不限）。" },
    },
    output: TEXT,
    async execute(args, exec) {
      const scope = await scopeOf(exec);
      const index = await cachedIndex({ dshHome, workspace: scope.filter, topLevelOnly: !args.includeSubagents });
      const limit = Number.isFinite(args.limit) ? Math.max(1, args.limit) : undefined;
      const md = renderMarkdown(index, { full: Boolean(args.full), maxSessions: limit, maxBytes: args.full ? 120000 : 12000 });
      const roles = (await rolesIn(scope)).entries.map(roleLine).join("\n");
      return { text: [`工作区：${scope.label}`, roles ? "## 岗位表\n" + roles : "", md].filter(Boolean).join("\n\n") };
    },
    presentCall: () => ({ card: "generic", title: "查看工作区会话", kind: "other" }),
  }));

  // ---- 2. 记忆 + 技能摘要 ----
  ctx.tools.register(defineTool({
    name: "butler_digest",
    description:
      "【仅本工作区的管家会话可用】汇总本工作区所有顶层会话在做什么，外加技能清单（名称+说明）与记忆规模。用于「不想一个个会话去翻」时一次看清全貌。",
    parameters: {
      full: { type: "boolean", description: "true 时列出更多会话与要点。" },
      includeSubagents: { type: "boolean", description: "true 时把子代理会话也算进来（默认隐藏）。" },
    },
    output: TEXT,
    async execute(args, exec) {
      const scope = await scopeOf(exec);
      const digest = await buildDigest({ dshHome, workspace: scope.filter, topLevelOnly: !args.includeSubagents });
      return { text: renderDigestMarkdown(digest, { full: Boolean(args.full), maxBytes: args.full ? 120000 : 12000 }) };
    },
    presentCall: () => ({ card: "generic", title: "生成管家摘要", kind: "other" }),
  }));

  // ---- 3. 岗位管理 ----
  ctx.tools.register(defineTool({
    name: "butler_roles",
    description:
      "【仅本工作区的管家会话可用】管理本工作区的「岗位表」：给某个顶层会话起一个岗位名（如 拉代码 / 跑测试 / 查日志），之后派活可直接用岗位名。action=list 查看，set 设置，remove 删除。岗位名在工作区内唯一。",
    parameters: {
      action: { type: "string", required: true, enum: ["list", "set", "remove"], description: "list | set | remove" },
      sessionId: { type: "string", description: "本工作区内的会话 id（session- 开头；set/remove 必填）。" },
      role: { type: "string", description: "岗位短名，例如「拉代码」。set 必填。" },
      job: { type: "string", description: "这个会话负责什么（一句话）。" },
    },
    output: TEXT,
    async execute(args, exec) {
      const { peers, entries } = await rolesIn(await scopeOf(exec));
      if (args.action === "list") {
        if (entries.length === 0) return { text: "本工作区的岗位表为空。用 butler_roles set 给会话起岗位名。" };
        return { text: "## 岗位表\n" + entries.map(roleLine).join("\n") };
      }
      if (!args.sessionId) throw new Error(`butler_roles ${args.action} 需要 sessionId`);
      if (!peers.has(args.sessionId)) throw new Error(`butler: \`${args.sessionId}\` 不是本工作区的顶层会话，管家只管理本工作区。`);
      if (args.action === "set") {
        if (!args.role) throw new Error("butler_roles set 需要 role");
        const saved = setRole({ sessionId: args.sessionId, role: args.role, job: args.job, dshHome, peers });
        return { text: `已设置岗位：${saved.role} → ${args.sessionId}` };
      }
      const had = removeRole({ sessionId: args.sessionId, dshHome });
      return { text: had ? `已删除岗位：${args.sessionId}` : `该会话没有岗位记录：${args.sessionId}` };
    },
    presentCall: () => ({ card: "generic", title: "管家岗位表", kind: "other" }),
  }));

  // ---- 4. 派活 ----
  ctx.tools.register(defineTool({
    name: "butler_dispatch",
    description:
      "【仅本工作区的管家会话可用】把一条任务消息投递给本工作区的另一个顶层会话并唤醒它干活（跨会话派活）。目标可以是 sessionId、岗位名或会话标题片段；别的工作区的会话、归档会话、子代理会话、自己所在的会话都不能作为目标。目标会话会把它当成一条带「管家派活」来源标记的用户消息处理，看不到本会话的上下文，所以 message 必须自包含。",
    parameters: {
      target: { type: "string", required: true, description: "sessionId / 岗位名 / 会话标题片段。" },
      message: { type: "string", required: true, description: "要投递的任务内容：背景、要做什么、什么算完成、产出放哪。" },
      title: { type: "string", description: "走调度通道时的任务标题，便于在任务列表里识别。" },
      dryRun: { type: "boolean", description: "true 时只解析目标并演练，不真正投递。" },
    },
    output: TEXT,
    async execute(args, exec) {
      const actorSessionId = exec?.agent?.session?.id;
      if (!actorSessionId) throw new Error("butler_dispatch 需要在一个 agent 会话里调用");
      const scope = await scopeOf(exec);
      const resolved = await resolveTarget(args.target, { dshHome, workspace: scope.filter });
      const res = await dispatchToSession({
        services: liveServices(),
        sessionId: resolved.sessionId,
        message: args.message,
        title: args.title,
        actorSessionId,
        delaySeconds: config.dispatchDelaySeconds,
        dryRun: args.dryRun ?? config.dryRun,
        dshHome,
        maxPerHour: config.maxDispatchesPerHour,
      });
      const to = `\`${resolved.sessionId}\`${resolved.title ? `「${resolved.title}」` : ""}（按 ${resolved.how} 匹配）`;
      if (res.dryRun) return { text: `[演练] 将派给 ${to}：\n${args.message}` };
      if (res.channel === "in-process") {
        return { text: `已派活 → ${to}\n通道: 进程内投递（已入队并唤醒）· messageId ${res.messageId ?? "?"}` };
      }
      return { text: `已派活 → ${to}\n通道: 调度任务 · ${res.task?.id ?? "?"} · 预定 ${res.task?.scheduledAtLocal ?? res.task?.scheduledAt ?? "?"}` };
    },
    presentCall: (args) => ({ card: "generic", title: "派活给 " + args.target, kind: "other", rawInput: args.message }),
  }));

  // 加载标记（放在最后：存在即证明四个工具都注册完成）
  try {
    fs.mkdirSync(path.join(dshHome, "butler"), { recursive: true });
    fs.writeFileSync(
      path.join(dshHome, "butler", "last-load.json"),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: VERSION, tools: TOOL_NAMES }, null, 2),
      "utf8",
    );
  } catch { /* 标记失败不影响插件 */ }
}
