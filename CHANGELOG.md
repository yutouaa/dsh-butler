# Changelog

## 0.2.0

首个公开版本。

### 修复

- 派活通道改用 `ctx.inject(deps, cb)` 惰性取得 `sessionController` / `sessions` / `schedule`。
  之前直接读 `ctx.sessionController`，在 cordis 4 下会抛 `cannot get property … without inject`，真实派活走不通。
- `config.dshHome` 现在对会话索引和摘要也生效，之前只对岗位表和审计生效。
- 岗位表不再接受子代理会话 id；岗位重名时报错而不是静默落到标题匹配。
- 已归档会话不再参与标题匹配，按 id / 岗位名命中归档会话时直接拒绝。
- 拒绝把活派给调用方自己所在的会话。
- 投递失败也写审计（`result: "failed"`），之前只记成功、限流和演练。

### 新增

- **每个工作区一个管家**：四个工具都只作用于调用方所在工作区的会话，跨工作区看不到也派不过去；
  岗位表按工作区分开，岗位名在工作区内唯一。
- **按工作区启停**：侧栏工作区的「…」/ 右键菜单新增「启用管家 / 停用管家」（界面端 `lib/client.js`，
  通过宿主的 `contextMenus` 服务注册）。状态存于 `~/.dsh/butler/workspaces.json`，
  修改必须来自 DSH 窗口。新增配置 `defaultEnabled`。

### 变更

- 移除 `butler_sessions` / `butler_digest` 的 `allWorkspaces` 参数。
- `butler_sessions` / `butler_digest` 默认只列顶层会话，新增 `includeSubagents` 参数。
- 派出去的消息开头带 `【管家派活 · 来自会话 xxxxxxxx】` 来源标记。
- 随包技能移到 `skills/butler/SKILL.md`，并通过 `ctx.skills.registerProvider` 注册给宿主。
- 新增 `locale/zh.json`、`locale/en.json`（插件页的标题与说明）。
- 配置项带说明文字；`package.json` 补齐 `engines.dsh`、兼容性声明和可选 peer 依赖范围。
- 数据层 CLI 新增 `--top-level`。

### 内部

- 删除被 `indexer.mjs` 取代的旧数据层（`store.mjs`、`digest.mjs`）。
- 新增 `node:test` 插件测试（桩宿主 + 临时夹具，不依赖真实 `~/.dsh`）；`npm test` 一条命令跑全部。
- 会话缓存目录的 `stat` 改为并发。

## 0.1.0

内部版本，未发布。
