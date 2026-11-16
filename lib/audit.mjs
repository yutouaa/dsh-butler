import fs from "node:fs";
import path from "node:path";

/** 派活审计：<dshHome>/butler/audit.jsonl，一行一条；同时是限流的计数来源 */
export function auditFile(dshHome) {
  return path.join(dshHome, "butler", "audit.jsonl");
}

export function appendAudit(entry, dshHome) {
  const file = auditFile(dshHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...entry }) + "\n", "utf8");
}

/** 最近一小时内真正投递成功的次数（用于限流） */
export function recentDispatches(dshHome, windowMs = 3600e3) {
  let text;
  try {
    text = fs.readFileSync(auditFile(dshHome), "utf8");
  } catch {
    return 0;
  }
  const since = Date.now() - windowMs;
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.kind === "dispatch" && e.at >= since && e.result === "scheduled") n += 1;
    } catch {
      /* 忽略坏行 */
    }
  }
  return n;
}
