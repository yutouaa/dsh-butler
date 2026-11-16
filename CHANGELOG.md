# Changelog

## 0.2.1

### 变更

- **每个工作区一个专门的管家会话**。0.2.0 里「谁调用谁就是管家」的做法改掉了：
  侧栏工作区菜单里点「启用管家」会在该工作区新建一个叫「管家」的会话（已有可用的就复用），
  并发一条开场白让它先汇报本工作区的情况；四个工具**只有这个会话能用**，同工作区的其它会话也会被拒绝。
- 「停用管家」只关开关，管家会话原样保留，再启用复用它；会话被归档或删除后，下次启用另建一个。
- 没启用过管家的工作区一律拒绝，不再有「默认启用」。
- 工具描述加了「仅本工作区的管家会话可用」；随包技能同步说明。

### 移除

- 配置项 `defaultEnabled`、`workspace`。
- `workspaces.json` 里 0.2.0 的布尔值格式：升级后一律视为未启用，重新点一次「启用管家」即可。

### 内部

- 新增 `lib/enable.mjs`（启用/停用与建会话）；开关接口 POST 现在会等建会话完成，并区分 404（未知工作区）和 500。
- 测试增加：只认管家会话、启用建会话、复用、归档后另建、开场白失败、建会话失败不留半成品开关。

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