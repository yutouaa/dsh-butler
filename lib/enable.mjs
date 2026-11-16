import { getWorkspace, listSessions } from "./indexer.mjs";
import { deliverInProcess } from "./dispatch.mjs";
import { getWorkspaceState, saveWorkspaceState } from "./state.mjs";

const BUTLER_TITLE = "管家";

const intro = (workspaceTitle) =>
  `你是工作区「${workspaceTitle}」的管家会话。只有这个会话能使用 butler_sessions / butler_digest / butler_roles / butler_dispatch 这四个工具。` +
  "请先加载 butler 技能，再用 butler_sessions 向用户简要汇报本工作区各会话在做什么，然后等用户吩咐。";

/** 记下的管家会话还能用吗：缓存里有就看有没有归档；缓存里没有（刚建、还没落盘）就问宿主。 */
async function stillUsable({ services, dshHome, workspaceId, sessionId }) {
  if (!sessionId) return false;
  const known = (await listSessions({ dshHome, workspace: workspaceId })).sessions.find((s) => s.id === sessionId);
  if (known) return !known.archived;
  const found = await services.controller?.resolveAgent?.(sessionId);
  return Boolean(found && !found.error);
}

/**
 * 启用 / 停用某个工作区的管家。
 * 启用：已有可用的管家会话就复用，否则在该工作区里新建一个并发一条开场白唤醒它；
 * 停用：只改开关，管家会话原样保留（它是普通会话，用户想删可以自己删）。
 */
export async function setWorkspaceEnabled({ services, dshHome, workspaceId, enabled }) {
  const ws = await getWorkspace(workspaceId, { dshHome });
  if (!ws) throw Object.assign(new Error(`butler: 找不到工作区 ${workspaceId}`), { status: 404 });
  const state = getWorkspaceState(dshHome, workspaceId);

  if (!enabled) {
    saveWorkspaceState(dshHome, workspaceId, { ...state, enabled: false });
    return { enabled: false, sessionId: state.sessionId };
  }
  if (await stillUsable({ services, dshHome, workspaceId, sessionId: state.sessionId })) {
    saveWorkspaceState(dshHome, workspaceId, { enabled: true, sessionId: state.sessionId });
    return { enabled: true, sessionId: state.sessionId, created: false };
  }

  if (!services.controller?.create) throw new Error("butler: 宿主没有 sessionController，创建不了管家会话。");
  const { sessionId } = await services.controller.create({ workspaceId });
  // 先落盘再做收尾：重命名或开场白失败也不会丢掉这个会话
  saveWorkspaceState(dshHome, workspaceId, { enabled: true, sessionId });
  try { await services.controller.rename({ sessionId, title: BUTLER_TITLE }); } catch { /* 标题只是好看 */ }
  try { await deliverInProcess(services, sessionId, intro(ws.title)); } catch { /* 开场白只是引导，用户之后自己说话也行 */ }
  return { enabled: true, sessionId, created: true };
}
