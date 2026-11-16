import { appendAudit, recentDispatches } from "./audit.mjs";
import { shortId } from "./indexer.mjs";

/**
 * 跨会话派活。两级通道：
 *  1) 首选：sessionController.resolveAgent → agent.followup(createUserMessage) → sessions.flush
 *     （宿主自己的 schedule 投递就是这套原语；零延迟、不占调度任务表、冷会话自动 resume）
 *  2) 回退：schedule.create({timing:{kind:"after"}, target:{kind:"session"}})
 *     （拿不到 sessionController 时用；调用方是子代理会话时会被宿主拒绝）
 *
 * services 由插件入口用 ctx.inject 惰性取得：{ controller, sessions, schedule }，缺哪个就是 undefined。
 * 每次尝试都写审计（限流 / 演练 / 成功 / 失败）。
 */
export async function dispatchToSession({
  services = {},
  sessionId,
  message,
  title,
  actorSessionId,
  delaySeconds = 3,
  dryRun = false,
  dshHome,
  maxPerHour = 20,
}) {
  const text = String(message ?? "").trim();
  if (!text) throw new Error("butler: 派活内容为空");
  if (sessionId === actorSessionId) throw new Error("butler: 不能把活派给自己所在的会话。");

  const audit = (entry) => appendAudit({ kind: "dispatch", sessionId, actorSessionId, title, ...entry }, dshHome);
  const used = recentDispatches(dshHome);
  if (used >= maxPerHour) {
    audit({ result: "rate-limited", count: used });
    throw new Error(`butler 派活限流：最近一小时内已派 ${used} 次，上限 ${maxPerHour}。`);
  }
  if (dryRun) {
    audit({ result: "dry-run", message: text });
    return { dryRun: true, channel: "none" };
  }

  // 目标会话看到的是一条 user 消息；带上来源，免得它（和之后翻记录的人）以为是用户亲手输入
  const prompt = `【管家派活 · 来自会话 ${shortId(actorSessionId)}】\n${text}`;
  try {
    if (services.controller?.resolveAgent) {
      const messageId = await deliverInProcess(services, sessionId, prompt);
      audit({ result: "scheduled", channel: "in-process", messageId });
      return { dryRun: false, channel: "in-process", messageId };
    }
    if (services.schedule?.create) {
      const task = await services.schedule.create(
        {
          title: title || `[管家] 派活 → ${shortId(sessionId)}`,
          prompt,
          timing: { kind: "after", afterSeconds: Math.max(1, Math.floor(delaySeconds)) },
          target: { kind: "session", sessionId },
        },
        actorSessionId,
        AbortSignal.timeout(15000),
      );
      audit({ result: "scheduled", channel: "schedule", taskId: task?.id, scheduledAt: task?.scheduledAt });
      return { dryRun: false, channel: "schedule", task };
    }
    throw new Error("butler: 无法派活——宿主既没有 sessionController 也没有 schedule 服务。");
  } catch (err) {
    audit({ result: "failed", error: String(err?.message ?? err) });
    throw err;
  }
}

/** 进程内投递：把消息塞进目标会话 inbox 并唤醒它 */
export async function deliverInProcess(services, sessionId, text) {
  const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
  const found = await services.controller.resolveAgent(sessionId);
  if (found?.error) {
    const code = found.error.code ?? "unknown";
    const hint = code === "session/not-found" ? "：会话不存在" : code === "session/writer-held" ? "：该会话正被其它进程占用" : "";
    throw new Error(`butler: 目标会话 ${sessionId} 不可投递（${code}）${hint}`);
  }
  const agent = found?.agent ?? found; // 宿主有 {agent} 与裸 agent 两种返回形态
  if (!agent?.followup) throw new Error(`butler: 无法取得会话 ${sessionId} 的 live agent`);
  const msg = createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
  agent.followup(msg);
  if ((await services.sessions?.flush?.(agent.session)) === false) throw new Error("butler: 会话持久化未确认投递");
  return msg.id;
}
