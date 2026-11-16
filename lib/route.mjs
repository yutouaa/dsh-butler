import { loadWorkspaces } from "./state.mjs";

/** 界面端（lib/client.js）读写各工作区管家开关用的路由 */
export const WORKSPACES_ROUTE = "/dsh-butler/workspaces";

/**
 * GET  -> { workspaces: { <workspaceId>: { enabled, sessionId? } } }
 * POST { workspaceId, enabled } -> { ok, workspaceId, enabled, sessionId, created? }
 *      启用时会按需创建管家会话，所以可能要几秒。
 *
 * @param setEnabled  (workspaceId, enabled) => Promise<object>，抛出的错误可带 status
 * @param fromBrowser (request) => true | false | null。false 表示请求没带宿主窗口的签名会话 cookie：
 *                    开关是给人点的，模型拿 shell 发请求不能替自己打开；null 表示当前宿主无法判断，放行。
 */
export function workspacesHandler({ dshHome, setEnabled, fromBrowser = () => null }) {
  const send = (response, status, body) => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  };

  return (request, response) => {
    if (request.method === "GET") {
      send(response, 200, { workspaces: loadWorkspaces(dshHome) });
      return;
    }
    if (request.method !== "POST") {
      send(response, 405, { error: "method not allowed" });
      return;
    }
    if (fromBrowser(request) === false) {
      send(response, 401, { error: "管家开关只能在 DSH 窗口里操作" });
      return;
    }
    let raw = "";
    request.setEncoding?.("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4096) request.destroy?.();
    });
    request.on("error", () => send(response, 400, { error: "request failed" }));
    request.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      if (typeof body?.workspaceId !== "string" || !body.workspaceId || typeof body.enabled !== "boolean") {
        send(response, 400, { error: "需要 { workspaceId: string, enabled: boolean }" });
        return;
      }
      try {
        send(response, 200, { ok: true, workspaceId: body.workspaceId, ...(await setEnabled(body.workspaceId, body.enabled)) });
      } catch (err) {
        send(response, err?.status ?? 500, { error: String(err?.message ?? err) });
      }
    });
  };
}
