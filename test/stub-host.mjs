// 宿主在运行时才注入 @deepseek-ai/*，磁盘上没有这些包；测试里用最小桩顶替。
// 必须在 import lib/index.mjs 之前加载。需要 Node >= 22.15（module.registerHooks）。
import { registerHooks } from "node:module";

const STUBS = {
  "@deepseek-ai/dsh-tools":
    'export function defineTool(def){ if(!def?.name || typeof def.execute !== "function") throw new Error("bad tool definition"); return def; }',
  "@deepseek-ai/schemastery":
    "const chain = () => new Proxy(function(){}, { get: () => chain(), apply: () => chain() }); export default chain();",
  "@deepseek-ai/dsh-llm":
    'let seq = 0; export function createUserMessage(o){ return { id: "msg-" + (++seq), ...o }; }',
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
