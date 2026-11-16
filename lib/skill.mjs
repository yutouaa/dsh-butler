import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./indexer.mjs";

/** 随包发布的 butler 技能（skills/butler/SKILL.md），通过 ctx.skills.registerProvider 提供给宿主。 */
const SKILL_NAME = "butler";
const PROVIDER_NAME = "dsh-butler-bundled-skill";
const SKILL_URL = new URL("../skills/butler/SKILL.md", import.meta.url);

/** 每次现读盘：改 SKILL.md 下一次发现就生效 */
async function load(signal) {
  const { data, body } = parseFrontmatter(await readFile(SKILL_URL, { encoding: "utf8", signal }));
  return {
    candidate: {
      name: SKILL_NAME,
      description: data.description || "工作区管家：会话总览、记忆/技能摘要、跨会话派活。",
      ...(data.whenToUse ? { whenToUse: data.whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER_NAME,
      source: "bundled",
      resourceBase: { kind: "directory", path: fileURLToPath(new URL("./", SKILL_URL)) },
      rank: 600, // 同名去重时 rank 小者胜，用户自建的同名技能可以覆盖它
      locator: SKILL_URL,
      path: fileURLToPath(SKILL_URL),
      metadata: data,
    },
    content: body,
  };
}

export const skillProvider = {
  name: PROVIDER_NAME,
  async list(options = {}) {
    return [(await load(options.signal)).candidate];
  },
  async get(selected, options = {}) {
    if (selected?.name !== SKILL_NAME) return undefined;
    const { candidate, content } = await load(options.signal);
    return { ...candidate, content };
  },
};
