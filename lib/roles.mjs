import path from "node:path";
import { readJson, writeJson } from "./state.mjs";

/** 岗位表：sessionId -> { role, job, updatedAt }，存于 <dshHome>/butler/roles.json */
const rolesFile = (dshHome) => path.join(dshHome, "butler", "roles.json");

export function loadRoles(dshHome) {
  return readJson(rolesFile(dshHome));
}

/**
 * @param peers 同一工作区内的会话 id 集合；岗位名只要求在工作区内唯一，
 *              这样每个工作区都能有自己的「跑测试」。
 */
export function setRole({ sessionId, role, job, dshHome, peers }) {
  const name = String(role ?? "").trim();
  if (!name) throw new Error("butler: 岗位名不能为空");
  const roles = loadRoles(dshHome);
  const taken = Object.keys(roles).find((id) => id !== sessionId && peers.has(id) && roles[id]?.role === name);
  if (taken) throw new Error(`butler: 岗位「${name}」已被 \`${taken}\` 占用，先对它 remove 再设置。`);
  roles[sessionId] = { role: name, job: job ? String(job).trim() : undefined, updatedAt: Date.now() };
  writeJson(rolesFile(dshHome), roles);
  return roles[sessionId];
}

export function removeRole({ sessionId, dshHome }) {
  const roles = loadRoles(dshHome);
  if (!roles[sessionId]) return false;
  delete roles[sessionId];
  writeJson(rolesFile(dshHome), roles);
  return true;
}
