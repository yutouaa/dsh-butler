import { listSessions } from "./indexer.mjs";
import { loadRoles } from "./roles.mjs";

/**
 * 把「目标」解析成本工作区内一个可派活的顶层会话。按序尝试：
 * - sessionId（session- 开头）
 * - 岗位名（本工作区会话的 role，或与 job 完全一致）
 * - 会话标题（先精确，再唯一的模糊匹配）
 * 管家只管自己所在的工作区：别的工作区的会话、子代理会话、归档会话一律拒绝；
 * 有歧义时列出候选让调用方改用 sessionId。
 *
 * @param workspace 工作区过滤条件（工作区 id，或未登记目录的路径）
 */
export async function resolveTarget(target, { dshHome, workspace } = {}) {
  const t = String(target ?? "").trim();
  if (!t) throw new Error("butler: 目标为空");
  if (/^[0-9a-f-]{16,}$/i.test(t)) {
    throw new Error(`butler: \`${t}\` 看起来是子代理会话，不能作为派活目标；请改派顶层会话（session- 开头）。`);
  }

  const { sessions } = await listSessions({ dshHome, workspace, topLevelOnly: true });
  const byId = new Map(sessions.map((s) => [s.id, s]));

  let hit = null;
  if (/^session-[0-9a-f-]{8,}$/i.test(t)) {
    hit = { sessionId: t, how: "id" };
  } else {
    const byRole = Object.entries(loadRoles(dshHome)).filter(([id, v]) => byId.has(id) && (v?.role === t || v?.job === t));
    if (byRole.length > 1) {
      throw new Error(`butler: 岗位「${t}」对应 ${byRole.length} 个会话，请改用 sessionId：${byRole.map(([id]) => id).join("; ")}`);
    }
    if (byRole.length === 1) hit = { sessionId: byRole[0][0], how: "role", role: byRole[0][1].role };
  }

  if (hit) {
    const known = byId.get(hit.sessionId);
    if (!known) throw new Error(`butler: \`${hit.sessionId}\` 不在当前工作区（或不存在）；管家只管理本工作区的会话。`);
    if (known.archived) throw new Error(`butler: 目标会话 \`${hit.sessionId}\` 已归档，不能派活。`);
    return { ...hit, title: known.title ?? null };
  }

  const live = sessions.filter((s) => !s.archived);
  const lower = t.toLowerCase();
  const titleOf = (s) => String(s.title ?? "").toLowerCase();
  const exact = live.filter((s) => titleOf(s) === lower);
  if (exact.length === 1) return { sessionId: exact[0].id, how: "title", title: exact[0].title };
  const fuzzy = live.filter((s) => titleOf(s).includes(lower));
  if (fuzzy.length === 1) return { sessionId: fuzzy[0].id, how: "title-fuzzy", title: fuzzy[0].title };
  if (fuzzy.length > 1) {
    const list = fuzzy.slice(0, 8).map((s) => `${s.title} (${s.id})`).join("; ");
    throw new Error(`butler: 目标「${t}」匹配到 ${fuzzy.length} 个会话，请改用 sessionId 精确指定：${list}`);
  }
  throw new Error(`butler: 在当前工作区找不到目标「${t}」对应的顶层会话（可用 butler_sessions 查看）。`);
}
