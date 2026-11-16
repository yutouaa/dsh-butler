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

/** 各工作区的管家开关：workspaceId -> boolean，存于 <dshHome>/butler/workspaces.json；没记录的走默认值 */
const flagsFile = (dshHome) => path.join(dshHome, "butler", "workspaces.json");

export function loadWorkspaceFlags(dshHome) {
  return readJson(flagsFile(dshHome));
}

export function isWorkspaceEnabled(dshHome, workspaceId, fallback) {
  const flag = loadWorkspaceFlags(dshHome)[workspaceId];
  return typeof flag === "boolean" ? flag : fallback;
}

export function setWorkspaceEnabled(dshHome, workspaceId, enabled) {
  writeJson(flagsFile(dshHome), { ...loadWorkspaceFlags(dshHome), [workspaceId]: Boolean(enabled) });
}
