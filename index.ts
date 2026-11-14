// pachat-watch —— Pachat 收件箱长轮询 → 会话唤醒（OpenCode v2 插件）
//
// 配置读同目录的 pachat-watch.json（不放 opencode.jsonc，也不用环境变量）：
//
//   plugins/pachat-watch/
//   ├── index.ts
//   └── pachat-watch.json
//
//   {
//     "token": "pachat_xxx",
//     "session": "ses_xxx",
//     "prompt": "检查pachat收件箱消息，有新的消息进行回复",
//     "waitSeconds": 25,
//     "cooldownSeconds": 60,
//     "enabled": true
//   }
//
// 目录放在 plugins/ 下即被自动发现，无需在 opencode.jsonc 里注册；
// 若同时给了 plugins[].options，则以 JSON 文件为准（文件覆盖 options）。

type Options = {
  token?: string
  session?: string
  prompt?: string
  waitSeconds?: number
  cooldownSeconds?: number
  enabled?: boolean
  baseUrl?: string
}

type Box = {
  cursor?: string
  needsYou?: number
  unreadGroups?: number
  groups?: { id?: string; name?: string; unread?: number }[]
}

const DEFAULT_PROMPT = "检查pachat收件箱消息，有新的消息进行回复"
const DEFAULT_BASE = "https://pachat.ai/api/v1"
const DEFAULT_WAIT = 25
const DEFAULT_COOLDOWN = 60
const STATE_KEY = "watch/state"

function log(...args: unknown[]) {
  try {
    console.log("[pachat-watch]", ...args)
  } catch {
    /* 宿主日志不可用时静默 */
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

const CONFIG_FILE = "pachat-watch.json"

// 读插件同目录的 pachat-watch.json；任何失败都只记日志，交由调用方兜底。
async function loadFileConfig(): Promise<{ cfg?: Options; path?: string; error?: string }> {
  try {
    const path = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const { readFile } = await import("node:fs/promises")
    const here = path.dirname(fileURLToPath(import.meta.url))
    const file = path.join(here, CONFIG_FILE)
    const parsed = JSON.parse(await readFile(file, "utf8")) as Options
    if (!parsed || typeof parsed !== "object") throw new Error("不是 JSON 对象")
    return { cfg: parsed, path: file }
  } catch (e: any) {
    return { error: `${CONFIG_FILE}: ${String(e?.message ?? e)}` }
  }
}

export default {
  id: "pachat.watch",

  async setup(ctx: any) {
    // ---- 读配置：同目录 JSON 优先，其次 opencode.jsonc 的 options ----
    const fromFile = await loadFileConfig()
    const o: Options = { ...((ctx?.options ?? {}) as Options), ...(fromFile.cfg ?? {}) }
    const configSource = fromFile.cfg ? fromFile.path! : fromFile.error ? "无配置文件" : "opencode.jsonc options"
    if (fromFile.error) log("读配置失败，回退到 options：", fromFile.error)
    else log("配置来源", configSource)

    const token = typeof o.token === "string" ? o.token.trim() : ""
    const target = typeof o.session === "string" ? o.session.trim() : ""
    const prompt = typeof o.prompt === "string" && o.prompt.trim() ? o.prompt : DEFAULT_PROMPT
    const base = (typeof o.baseUrl === "string" && o.baseUrl.trim() ? o.baseUrl : DEFAULT_BASE).replace(/\/+$/, "")
    const wait = Math.min(Math.max(Number(o.waitSeconds ?? DEFAULT_WAIT) || DEFAULT_WAIT, 1), 25)
    let cooldown = Math.max(Number(o.cooldownSeconds ?? DEFAULT_COOLDOWN) || 0, 0) * 1000
    let enabled = o.enabled !== false

    if (!token) {
      log("缺少 options.token，监听未启动")
      enabled = false
    }
    if (!target) {
      log("缺少 options.session，监听未启动（工具仍可用）")
      enabled = false
    }

    const controller = new AbortController()
    const state = {
      running: false,
      cursor: "",
      lastPollAt: null as string | null,
      lastWakeAt: null as string | null,
      wakeCount: 0,
      wakeSkipped: 0,
      lastNeedsYou: 0,
      lastError: "" as string,
      lastBusy: false,
      session: target,
      cooldownSeconds: Math.round(cooldown / 1000),
      configSource,
      configError: fromFile.error ?? "",
    }
    let lastWokeCursor = ""
    let loopPromise: Promise<void> | null = null

    function startLoop() {
      if (loopPromise) return
      loopPromise = loop().finally(() => {
        loopPromise = null
      })
    }

    // ---- 游标持久化 ----
    try {
      const saved = (await ctx.storage.get(STATE_KEY)) as { cursor?: string } | undefined
      if (saved?.cursor) {
        state.cursor = saved.cursor
        log("恢复游标", state.cursor)
      }
    } catch (e) {
      log("读取游标失败", String(e))
    }

    async function saveCursor() {
      try {
        await ctx.storage.set(STATE_KEY, { cursor: state.cursor, at: new Date().toISOString() })
      } catch (e) {
        log("保存游标失败", String(e))
      }
    }

    // ---- Pachat 收件箱长轮询 ----
    async function inbox(cursor: string, waitSec: number): Promise<Box> {
      let url = base + "/inbox"
      if (cursor) url += `?since=${encodeURIComponent(cursor)}&wait=${waitSec}`
      const timeout = setTimeout(() => controller.abort(), (waitSec + 15) * 1000)
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`inbox HTTP ${res.status}`)
        return (await res.json()) as Box
      } finally {
        clearTimeout(timeout)
      }
    }

    // ---- 会话忙闲 ----
    async function busy(sessionID: string): Promise<boolean> {
      try {
        const s: any = await ctx.session.get({ sessionID })
        const t = s?.time ?? s?.data?.time ?? {}
        if (!t.busy) return false
        return !t.idle || t.busy > t.idle
      } catch {
        return false
      }
    }

    // ---- 唤醒 ----
    async function wake(sessionID: string, reason: string) {
      await ctx.session.prompt({
        sessionID,
        text: `${prompt}\n\n（触发原因：${reason}）`,
      })
      state.wakeCount++
      state.lastWakeAt = new Date().toISOString()
      log("已唤醒", sessionID, reason)
    }

    // ---- 主循环 ----
    async function loop() {
      state.running = true
      log(`启动 session=${target} wait=${wait}s cooldown=${state.cooldownSeconds}s`)
      while (!controller.signal.aborted) {
        try {
          const box = await inbox(state.cursor, wait)
          state.lastPollAt = new Date().toISOString()
          state.lastNeedsYou = box.needsYou ?? 0
          state.lastError = ""

          const priming = !state.cursor
          if (box.cursor && box.cursor !== state.cursor) {
            state.cursor = box.cursor
            await saveCursor()
          }
          if (priming) {
            log("初始化游标", state.cursor)
            continue
          }
          if ((box.needsYou ?? 0) <= 0 && (box.unreadGroups ?? 0) <= 0) continue

          const now = Date.now()
          const lastWakeMs = state.lastWakeAt ? Date.parse(state.lastWakeAt) : 0
          if (lastWokeCursor === state.cursor && now - lastWakeMs < cooldown) {
            state.wakeSkipped++
            continue
          }

          state.lastBusy = await busy(target)
          if (state.lastBusy) {
            state.wakeSkipped++
            continue
          }

          const reason = `needsYou=${box.needsYou ?? 0}, unreadGroups=${box.unreadGroups ?? 0}, cursor=${state.cursor}`
          await wake(target, reason)
          lastWokeCursor = state.cursor
        } catch (e: any) {
          if (controller.signal.aborted) break
          state.lastError = String(e?.message ?? e)
          log("轮询失败", state.lastError)
          await sleep(5000, controller.signal)
        }
      }
      state.running = false
      log("已停止")
    }

    // ---- 工具：状态 / 探测 / 运行时调整 / 手动唤醒 ----
    try {
      const statusTool = {
        name: "status",
        description: "Pachat 监听状态：是否运行、游标、上次轮询/唤醒、唤醒次数、上次错误。无参数。",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: JSON.stringify({ ...state, enabled }, null, 2) }),
      }

      const pollTool = {
        name: "poll",
        description: "只读探测一次 Pachat 收件箱（不标已读、不推进监听游标）。",
        input: {
          type: "object",
          properties: { wait: { type: "integer", minimum: 0, maximum: 25, description: "等待秒数，0 立即返回" } },
          additionalProperties: false,
        },
        execute: async (input: { wait?: number }) => {
          const w = Math.min(Math.max(Number(input?.wait ?? 0) || 0, 0), 25)
          const box = await inbox(state.cursor, w)
          return {
            content: JSON.stringify(
              { cursor: box.cursor, needsYou: box.needsYou ?? 0, unreadGroups: box.unreadGroups ?? 0, groups: box.groups ?? [] },
              null,
              2,
            ),
          }
        },
      }

      const setTool = {
        name: "set",
        description: "运行时调整：enabled 开关、cooldownSeconds 冷却秒数、session 目标会话、prompt 唤醒文本。",
        input: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            session: { type: "string" },
            prompt: { type: "string" },
            cooldownSeconds: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        execute: async (input: any) => {
          if (typeof input?.cooldownSeconds === "number" && input.cooldownSeconds >= 0) {
            cooldown = input.cooldownSeconds * 1000
            state.cooldownSeconds = input.cooldownSeconds
          }
          if (typeof input?.session === "string" && input.session.trim()) {
            state.session = input.session.trim()
          }
          if (typeof input?.enabled === "boolean") {
            enabled = input.enabled
            if (enabled) startLoop()
          }
          return { content: JSON.stringify({ ...state, enabled }, null, 2) }
        },
      }

      const wakeTool = {
        name: "wake",
        description: "手动投递一次唤醒，用于验证链路。",
        input: {
          type: "object",
          properties: { reason: { type: "string" } },
          additionalProperties: false,
        },
        execute: async (input: { reason?: string }) => {
          await wake(state.session, input?.reason || "manual")
          return { content: `已唤醒 ${state.session}` }
        },
      }

      await ctx.tool.transform((editor: any) => {
        editor.namespace({ name: "pachat_watch", description: "Pachat 收件箱监听" })
        // 显式给每个工具挂命名空间，避免落到全局 status/poll 这类通用名上
        for (const tool of [statusTool, pollTool, setTool, wakeTool])
          editor.add({ ...tool, options: { namespace: "pachat_watch" } })
      })
    } catch (e) {
      log("注册工具失败（监听不受影响）", String(e))
    }

    if (enabled) startLoop()

    // 卸载时停止
    return () => {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
  },
}
