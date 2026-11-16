# dsh-butler — DSH 工作区管家

[English](./README.en.md)

给 DeepSeek Harness（DSH）的每个工作区装一个「管家」：它看得见本工作区所有会话在干什么，
能按岗位名 / 标题把活派给正确的会话，还能一次汇总所有会话的要点、记忆与技能，不用一个个点开翻。
管家只管自己所在的工作区，并且可以在侧栏里按工作区启用或停用。

装好之后在任意会话里说人话就行：

> 「现在这个工作区都有哪些会话？都在干什么？」
> 「把『跑一遍回归测试』派给跑测试那个会话。」
> 「会话 session-xxxx 负责拉代码，以后叫它『拉代码』。」

## 提供什么

| 工具 | 作用 |
|---|---|
| `butler_sessions` | 会话总览：标题、状态（running / active / idle）、最近活跃时间、最近几轮在做什么 |
| `butler_digest` | 一次性摘要：各会话要点 + 技能清单 + 记忆规模（默认 ≤ 12 KB） |
| `butler_roles` | 岗位表：给会话起岗位名（拉代码 / 跑测试 / 查日志），之后按名字派活 |
| `butler_dispatch` | 跨会话派活：把一条自包含的任务投递给另一个会话并唤醒它 |

另外随包带一个 `butler` 技能（[skills/butler/SKILL.md](./skills/butler/SKILL.md)），告诉模型什么时候用哪个工具、派活要守哪些规矩。

## 每个工作区一个管家

管家不是一个单独的机器人，而是每个会话都能用的一组工具；谁调用，谁就是它所在工作区的管家。

- **只管本工作区**：看会话、做摘要、设岗位、派活，都只针对调用方所在工作区的会话。别的工作区看不到，也派不过去。
- **岗位表按工作区分开**：每个工作区都可以有自己的「跑测试」。
- **按工作区启停**：在侧栏工作区的「…」菜单（或右键菜单）里点「停用管家」/「启用管家」。
  停用后，该工作区里的会话调用四个工具都会被拒绝，其它工作区不受影响。
- 默认所有工作区都启用。想改成「先启用才生效」，把配置里的 `defaultEnabled` 设为 `false`。

菜单开关只能由人在 DSH 窗口里点：修改请求必须带窗口的会话 cookie，模型用 shell 发请求改不了。

## 安装

**插件市场**（收录后）：插件 → 发现，搜索 `dsh-butler`，安装。

**手动（npm）**：在 profile 目录里装包，并把它加进 bundles，然后重启 DSH。

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-butler
```

```jsonc
// ~/.dsh/profiles/desktop/package.json
{ "dsh": { "profile": { "bundles": ["…", "dsh-butler"] } } }
```

**从源码**（开发用，Windows / PowerShell 7）：

```powershell
pwsh -File scripts/install.ps1      # 备份 profile 配置 → 复制到 node_modules/dsh-butler → 写入 bundles
pwsh -File scripts/uninstall.ps1
```

装好后 `~/.dsh/butler/last-load.json` 会记下版本号和四个工具名，可以用来确认插件已加载。

## 工具参数

**`butler_sessions`**

| 参数 | 类型 | 说明 |
|---|---|---|
| `full` | boolean | 每个会话展开更多轮次 |
| `includeSubagents` | boolean | 把子代理会话也列出来（默认隐藏，它们不能派活） |
| `limit` | integer | 最多列多少个会话，默认 20 |

**`butler_digest`**：`full`、`includeSubagents`，含义同上。

**`butler_roles`**

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `list` \| `set` \| `remove` | 必填 |
| `sessionId` | string | `set` / `remove` 必填，必须是本工作区内 `session-` 开头的顶层会话 |
| `role` | string | 岗位短名，`set` 必填，工作区内唯一 |
| `job` | string | 一句话说明这个会话负责什么 |

**`butler_dispatch`**

| 参数 | 类型 | 说明 |
|---|---|---|
| `target` | string | 必填。sessionId / 岗位名 / 会话标题片段 |
| `message` | string | 必填。任务内容，要自包含：背景、做什么、什么算完成、产出放哪 |
| `title` | string | 走调度通道时的任务标题 |
| `dryRun` | boolean | 只解析目标并演练，不投递 |

## 派活是怎么实现的

目标解析顺序：`session-` id → 岗位名 → 会话标题（先精确，再唯一的模糊匹配），都只在本工作区内找。
匹配到多个会直接报错并列出候选，不会替你挑。

投递走宿主自己的两条官方通道，按顺序尝试：

1. **进程内投递**：`sessionController.resolveAgent` → `agent.followup` → `sessions.flush`。
   零延迟，冷会话会被自动唤醒，等持久化确认后才算成功。
2. **调度服务回退**：`schedule.create({ timing: { kind: "after" }, target: { kind: "session" } })`，几秒后投递。

目标会话收到的是一条用户消息，开头带 `【管家派活 · 来自会话 xxxxxxxx】`，
这样对方（以及之后翻记录的你）都知道这不是当场手打的。派活是异步的：工具返回只代表送达，不代表对方做完。

### 安全边界

- 只能派给**本工作区的顶层会话**。别的工作区的会话、子代理会话、已归档会话、调用方自己所在的会话都会被拒绝。
- 工作区停用管家后，该工作区内的调用一律拒绝。
- 每小时最多 `maxDispatchesPerHour` 次（默认 20），只计真正投递成功的。
- 每次尝试都写审计 `~/.dsh/butler/audit.jsonl`：成功、失败、限流、演练都有记录。
- `dryRun` 可以按次传，也可以在配置里全局打开。
- 插件不会自己派活，只在模型调用 `butler_dispatch` 时才动；随包技能要求模型在用户没点名目标时先建议再执行。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: butler
  config:
    defaultEnabled: true       # 没单独设置过的工作区是否启用管家
    maxDispatchesPerHour: 20   # 每小时派活上限（所有工作区合计）
    dispatchDelaySeconds: 3    # 调度回退通道的投递延迟（秒）
    dryRun: false              # 全局演练
    # dshHome: D:\dsh-home     # 覆盖 DSH 家目录，默认 $DSH_HOME 或 ~/.dsh
```

## 读什么、写什么

只读：

- 会话：`~/.dsh/storages/session_projcache/sessions/*.json`（宿主可能正在写，半截文件会被跳过并计数）
- 工作区与归档表：`~/.dsh/storages/workspace.json`
- 记忆：`~/.dsh/MEMORY.md`、`USER.md`，找不到再看 `~/.mnemon/runtime/`
- 技能：`~/.dsh/skills/*/SKILL.md` 与 `<工作区>/.dsh/skills/*/SKILL.md`

只写 `~/.dsh/butler/`：`roles.json`（岗位表）、`workspaces.json`（各工作区的启停开关）、`audit.jsonl`（派活审计）、`last-load.json`（加载标记）。
插件不访问外网；唯一的 HTTP 是界面端向本机宿主读写开关（`/dsh-butler/workspaces`）。
注意摘要会把同工作区其它会话的 prompt 片段带进当前会话的上下文。

## 兼容性

| DSH | 状态 |
|---|---|
| 0.2.2-rc.3 | experimental：自动化测试通过；真实跨会话投递和工作区菜单开关请先在自己的环境里验证（派活可先用 `dryRun`） |

需要 Node ≥ 22。会话数据读的是宿主的投影缓存，属于内部格式，宿主升级后可能需要跟进。

## 已知限制

- 会话属于哪个工作区是按它的工作目录判断的（落在哪个工作区的文件夹下）。两个工作区指向同一个文件夹时无法区分。
- 工作目录不属于任何已登记工作区的会话没有菜单可点，按 `defaultEnabled` 处理，管辖范围就是那个目录。
- 菜单开关只在 Web / 桌面界面里有；纯命令行宿主只能用 `defaultEnabled`，或直接改 `~/.dsh/butler/workspaces.json`。
- 菜单文案按浏览器语言在中文和英文之间选。
- 会话标题由 DSH 用首条 prompt 自动生成，可能比较长。
- 宿主异常退出可能留下假的 running 状态，判断时结合「上次活跃」时间。
- 限流在并发调用下不是严格原子的：同一瞬间的多次派活可能略微超过上限。
- `audit.jsonl` 不会自动轮转。

## 开发

```bash
npm test                                                             # 插件测试 + 数据层自检
node --test --test-name-pattern "限流" "test/*.test.mjs"             # 只跑一条
node lib/indexer.mjs list --top-level --workspace <路径>             # 数据层 CLI：list | digest | stats | json
```

`@deepseek-ai/*` 由宿主在运行时注入，磁盘上没有；测试用 [test/stub-host.mjs](./test/stub-host.mjs) 里的桩顶替（需要 Node ≥ 22.15）。

## License

[MIT](./LICENSE)
