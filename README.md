# pachat-watch（OpenCode v2 插件）

Pachat 收件箱长轮询 → 会话唤醒。**参数读同目录的 `pachat-watch.json`**，不放 `opencode.jsonc`，也不用环境变量。

## 目录

```
plugins/pachat-watch/
├── index.ts            # 插件本体（零依赖）
├── pachat-watch.json   # 参数
└── README.md
```

放在 `plugins/` 下即被 OpenCode 自动发现，**不需要**在 `opencode.jsonc` 的 `plugins` 数组里注册。

## 参数（pachat-watch.json）

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `token` | ✅ | — | Pachat API token（Bearer） |
| `session` | ✅ | — | 要唤醒的会话 ID；缺失则只注册工具、不轮询 |
| `prompt` | | `检查pachat收件箱消息，有新的消息进行回复` | 唤醒时投递的文本 |
| `waitSeconds` | | `25` | 长轮询挂起秒数，1–25 |
| `cooldownSeconds` | | `60` | 同一游标重复唤醒的最小间隔 |
| `enabled` | | `true` | 是否启动轮询 |
| `baseUrl` | | `https://pachat.ai/api/v1` | API 根地址 |

示例：

```json
{
  "token": "pachat_xxx",
  "session": "ses_e2550d2d4ffev3CfII5UpP4n1i",
  "prompt": "检查pachat收件箱消息，有新的消息进行回复",
  "waitSeconds": 25,
  "cooldownSeconds": 60,
  "enabled": true
}
```

优先级：`pachat-watch.json` > `plugins[].options`。两者都没有时监听不启动（工具仍会注册），
`pachat_watch_status` 的 `configError` / `configSource` 会说明读取结果。

## 工具

命名空间 `pachat_watch`：

| 工具 | 说明 |
|---|---|
| `pachat_watch_status` | 运行状态、游标、上次轮询/唤醒、唤醒次数、配置来源与错误 |
| `pachat_watch_poll` | 只读探测一次收件箱（不标已读、不推进游标） |
| `pachat_watch_set` | 运行时改 `enabled` / `session` / `prompt` / `cooldownSeconds` |
| `pachat_watch_wake` | 手动投递一次唤醒，用于验证链路 |

工具注册时**必须显式写 `options: { namespace: "pachat_watch" }`**——只调 `editor.namespace()` 不会作用于后续 `add`（实测会落到全局 `status` / `poll` 这类通用名上）。

## 依赖的插件 API

- `ctx.session.prompt({ sessionID, text })` —— 直接投递，不需要端口和 Basic 认证
- `ctx.session.get({ sessionID })` —— 读 `time.busy` / `time.idle` 判断忙闲
- `ctx.storage.get/set` —— 持久化游标，重启不会把历史消息当新消息
- `ctx.tool.transform(editor => ...)` —— 注册工具
- `setup` 返回函数 —— 卸载时 `controller.abort()` 停止轮询
- 读配置用 `import.meta.url` 定位同目录 + 动态 `import("node:fs/promises")`，不依赖 node_modules

文档：https://opencode.ai/docs/build/plugins/server

## 改动须知

- 改 `index.ts` 或 `pachat-watch.json` 后，被监视的配置目录会自动重载；
- 不要把本目录同时注册进 `opencode.jsonc` 的 `plugins` 数组——自动发现 + 显式注册可能加载两次，导致同一条消息唤醒两次。
