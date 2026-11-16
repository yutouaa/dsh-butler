/**
 * dsh-butler 界面端：在侧栏工作区的「…」/ 右键菜单里加一项「启用管家 / 停用管家」。
 *
 * 只用宿主的 contextMenus 服务注册一条纯数据菜单项，不引 React、没有依赖。
 * 开关状态存在宿主那半（lib/route.mjs -> ~/.dsh/butler/workspaces.json）。
 * 取不到状态时不显示菜单项，绝不影响工作区菜单本身。
 */
window.__ModuleLoader__.load({
  id: "dsh-butler",
  factory: function () {
    var ROUTE = "dsh-butler/workspaces";

    /** 宿主可能挂在子路径下，按 document.baseURI 解析 */
    function apiUrl() {
      try {
        return new URL(ROUTE, document.baseURI).pathname;
      } catch (error) {
        return "/" + ROUTE;
      }
    }

    function request(method, body, signal) {
      var init = { method: method, credentials: "same-origin", signal: signal };
      if (body) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      return fetch(apiUrl(), init).then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      });
    }

    // shortcut: 按浏览器语言在中英文之间选，没接宿主的 locale 服务；要支持更多语言时改用 ctx.locale
    var zh = /^zh/i.test((typeof navigator !== "undefined" && navigator.language) || "zh");
    var T = zh
      ? { enable: "启用管家", disable: "停用管家", enabled: "已为「{name}」启用管家", disabled: "已为「{name}」停用管家", failed: "切换管家失败，请重试" }
      : { enable: "Enable butler", disable: "Disable butler", enabled: "Butler enabled for “{name}”", disabled: "Butler disabled for “{name}”", failed: "Could not switch the butler, try again" };

    return {
      inject: ["contextMenus"],
      apply: function (ctx) {
        ctx.effect(function () {
          return ctx.contextMenus.register({
            id: "dsh-butler.toggle",
            target: "workspace",
            order: 250, // 重命名(100) 之后、删除工作区(300) 之前
            resolve: function (target, signal) {
              return request("GET", null, signal).then(
                function (state) {
                  var flag = state.workspaces && state.workspaces[target.workspaceId];
                  var enabled = typeof flag === "boolean" ? flag : state.defaultEnabled !== false;
                  return [{
                    id: "toggle",
                    label: enabled ? T.disable : T.enable,
                    failureLabel: T.failed,
                    run: function () {
                      return request("POST", { workspaceId: target.workspaceId, enabled: !enabled }).then(function () {
                        ctx.contextMenus.notify((enabled ? T.disabled : T.enabled).replace("{name}", target.displayTitle), true);
                      });
                    },
                  }];
                },
                function () {
                  return []; // 宿主那半没加载或路由不可用：不显示菜单项
                },
              );
            },
          });
        }, "dsh-butler: workspace menu toggle");
      },
    };
  },
});
