import fs from "node:fs";
import path from "node:path";

/** 插件自己的小状态文件，都在 <dshHome>/butler/ 下。读不到或格式不对一律当空对象。 */
export function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** 先写临时文件再改名，避免写一半被读到 */
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 各工作区的管家：workspaceId -> { enabled, sessionId }，存于 <dshHome>/butler/workspaces.json。
 * sessionId 是这个工作区指定的管家会话，只有它能用管家工具；停用时保留，再启用就复用同一个会话。
 */
const workspacesFile = (dshHome) => path.join(dshHome, "butler", "workspaces.json");

export function loadWorkspaces(dshHome) {
  const out = {};
  for (const [id, v] of Object.entries(readJson(workspacesFile(dshHome)))) {
    // 0.2.x 存的是布尔值、没有管家会话；一律当未启用，重新点「启用管家」后会建会话
    out[id] = v && typeof v === "object" ? { enabled: v.enabled === true, sessionId: v.sessionId } : { enabled: false };
  }
  return out;
}

export function getWorkspaceState(dshHome, workspaceId) {
  return loadWorkspaces(dshHome)[workspaceId] ?? { enabled: false };
}

export function saveWorkspaceState(dshHome, workspaceId, state) {
  writeJson(workspacesFile(dshHome), { ...loadWorkspaces(dshHome), [workspaceId]: state });
}
