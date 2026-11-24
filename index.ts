// pachat-watch —— Pachat 收件箱长轮询 → 会话唤醒（OpenCode v2 插件）
// v2: 每群按 lastSeq 去重 + 插件秒回「收到」+ leader 单实例（已修复 6 项）
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
  enabled?: boolean
  baseUrl?: string
}

type Box = {
  cursor?: string
  needsYou?: number
  unreadGroups?: number
  groups?: {
    id?: string
    name?: string
    unread?: number
    mentionsYou?: number
    repliesToYou?: number
    addedByYourOwner?: number
    fromYourOwner?: number
    lastSeq?: number
    lastReadSeq?: number
  }[]
}

const DEFAULT_PROMPT = "检查pachat收件箱消息，有新的消息进行回复"
const DEFAULT_BASE = "https://pachat.ai/api/v1"
const DEFAULT_WAIT = 25
const STATE_KEY = "watch/state"
const LEADER_KEY = "watch/leader"
const LEADER_TTL = 45 * 1000
const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

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
    let prompt = typeof o.prompt === "string" && o.prompt.trim() ? o.prompt : DEFAULT_PROMPT
    const base = (typeof o.baseUrl === "string" && o.baseUrl.trim() ? o.baseUrl : DEFAULT_BASE).replace(/\/+$/, "")
    const wait = Math.min(Math.max(Number(o.waitSeconds ?? DEFAULT_WAIT) || DEFAULT_WAIT, 1), 25)
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
      leader: false,
      cursor: "",
      lastPollAt: null as string | null,
      lastWakeAt: null as string | null,
      lastOwnerWakeAt: null as string | null,
      lastOwnerCursor: "" as string,
      handled: {} as Record<string, number>,
      wakeCount: 0,
      wakeSkipped: 0,
      lastNeedsYou: 0,
      lastError: "" as string,
      lastBusy: false,
      session: target,
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

    // ---- 状态持久化（游标 + 已处理过的「主人发言」游标）----
    try {
      const saved = (await ctx.storage.get(STATE_KEY)) as
        | { cursor?: string; lastOwnerCursor?: string; handled?: Record<string, number> }
        | undefined
      if (saved?.cursor) {
        state.cursor = saved.cursor
        log("恢复游标", state.cursor)
      }
      if (saved?.lastOwnerCursor) state.lastOwnerCursor = saved.lastOwnerCursor
      if (saved?.handled && typeof saved.handled === "object") state.handled = saved.handled
    } catch (e) {
      log("读取游标失败", String(e))
    }

    async function saveState() {
      try {
        await ctx.storage.set(STATE_KEY, {
          cursor: state.cursor,
          lastOwnerCursor: state.lastOwnerCursor,
          handled: state.handled,
          at: new Date().toISOString(),
        })
      } catch (e) {
        log("保存状态失败", String(e))
      }
    }

    // ---- 单实例 leader：热重载/双加载时，只有 leader 真正轮询 ----
    async function becomeLeader(): Promise<boolean> {
      try {
        const cur = (await ctx.storage.get(LEADER_KEY)) as { id?: string; at?: number } | undefined
        const now = Date.now()
        if (cur?.id && cur.id !== instanceId && cur.at && now - cur.at < LEADER_TTL) return false
        await ctx.storage.set(LEADER_KEY, { id: instanceId, at: now })
        return true
      } catch {
        return true
      }
    }

    // ---- Pachat 收件箱长轮询 ----
    async function inbox(cursor: string, waitSec: number): Promise<Box> {
      let url = base + "/inbox"
      if (cursor) url += `?since=${encodeURIComponent(cursor)}&wait=${waitSec}`
      // 用局部 controller 做超时，避免超时把共享 controller 一起 abort、终止整个循环
      const local = new AbortController()
      const onAbort = () => local.abort()
      controller.signal.addEventListener("abort", onAbort, { once: true })
      const timeout = setTimeout(() => local.abort(), (waitSec + 15) * 1000)
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: local.signal,
        })
        if (!res.ok) throw new Error(`inbox HTTP ${res.status}`)
        return (await res.json()) as Box
      } finally {
        clearTimeout(timeout)
        controller.signal.removeEventListener("abort", onAbort)
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

    // ---- 秒回「收到」：插件在唤醒同一刻直接发，不依赖模型、也不额外取数 ----
    // 群 id 与 replyTo 需要的 seq 都从刚才这次 inbox 的 groups 里取（lastSeq）。
    async function ack(groups: any[]): Promise<Record<string, number>> {
      const seqs: Record<string, number> = {}
      for (const g of groups) {
        const directG =
          (Number(g?.mentionsYou) || 0) +
          (Number(g?.repliesToYou) || 0) +
          (Number(g?.addedByYourOwner) || 0)
        const gid = g?.id
        if (!gid || directG <= 0) continue
        const lastSeq = Number(g?.lastSeq) || 0
        const payload = {
          text: "收到，正在处理…",
          ...(lastSeq > 0 ? { replyTo: lastSeq } : {}),
          // 稳定 opKey：同一条消息重试也只发一次
          opKey: `ack:${gid}:${lastSeq}`,
          // 这条消息此刻还是未读，不加 ignoreNew 会被 Pachat 以 409 new_messages 拒掉
          ignoreNew: true,
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch(`${base}/groups/${encodeURIComponent(gid)}/messages`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: controller.signal,
            })
            if (!res.ok) {
              log("ack HTTP", res.status, gid)
              continue
            }
            try {
              const j: any = await res.json()
              const ackSeq = Number(j?.seq) || 0
              if (ackSeq > 0) seqs[gid] = ackSeq
            } catch {
              /* 响应非 JSON 时忽略 */
            }
            break
          } catch (e) {
            log("ack 失败", String(e))
            if (controller.signal.aborted) break
            await sleep(1000, controller.signal)
          }
        }
      }
      return seqs
    }

    // ---- 主循环 ----
    async function loop() {
      state.running = true
      log(`启动 session=${target} wait=${wait}s`)
      while (!controller.signal.aborted && enabled) {
        try {
          if (!(await becomeLeader())) {
            state.leader = false
            log("非 leader，等待接管")
            await sleep(5000, controller.signal)
            continue
          }
          state.leader = true

          const box = await inbox(state.cursor, wait)
          state.lastPollAt = new Date().toISOString()
          state.lastNeedsYou = box.needsYou ?? 0
          state.lastError = ""

          const priming = !state.cursor
          if (box.cursor && box.cursor !== state.cursor) {
            state.cursor = box.cursor
            await saveState()
          }
          if (priming) {
            log("初始化游标", state.cursor)
            continue
          }
          // 区分「直接找我」和「主人随便说了句话」：
          // direct = 被 @ / 被回复 / 被拉进群；ownerPosts = 主人在群里发言。
          // 注意 needsYou 已经把主人发言算进去了，所以这里不能用它判断。
          const groups = (box.groups ?? []) as any[]
          const direct = groups.reduce(
            (n, g) =>
              n +
              (Number(g?.mentionsYou) || 0) +
              (Number(g?.repliesToYou) || 0) +
              (Number(g?.addedByYourOwner) || 0),
            0,
          )
          const ownerPosts = groups.reduce((n, g) => n + (Number(g?.fromYourOwner) || 0), 0)
          state.lastNeedsYou = direct + ownerPosts
          if (direct <= 0 && ownerPosts <= 0) continue

          // 按「每群 lastSeq」去重：只有出现比上次已投递更靠后的消息才唤醒。
          // seq 单调，比 cursor 稳：热重载、长任务、未读未变都不会重复投递同一条消息。
          const fresh = groups.filter((g) => {
            const gid = g?.id
            if (!gid) return false
            const cnt =
              (Number(g?.mentionsYou) || 0) +
              (Number(g?.repliesToYou) || 0) +
              (Number(g?.addedByYourOwner) || 0) +
              (Number(g?.fromYourOwner) || 0)
            if (cnt <= 0) return false
            const lastSeq = Number(g?.lastSeq) || 0
            const lastRead = Number(g?.lastReadSeq) || 0
            if (lastSeq <= lastRead) return false
            return lastSeq > (state.handled[gid] || 0)
          })
          if (fresh.length === 0) {
            state.wakeSkipped++
            continue
          }

          // 不再因为会话忙而丢弃：OpenCode 会话自带消息队列，直接投递即可（忙就排队）
          state.lastBusy = await busy(target)

          const reason = `direct=${direct}, ownerPosts=${ownerPosts}, cursor=${state.cursor}`
          // 秒回「收到」（best-effort，带一次重试），拿到 ack 的 seq
          const ackSeqs = await ack(fresh)
          lastWokeCursor = state.cursor
          // 先投递；投递失败就保留 handled，下一轮重试 —— 绝不丢消息
          try {
            await wake(target, reason)
          } catch (e: any) {
            state.lastError = String(e?.message ?? e)
            log("唤醒失败，保留 handled 以便重试", state.lastError)
            await sleep(5000, controller.signal)
            continue
          }
          // 投递成功后再推进去重水位并落盘
          for (const g of fresh) {
            const gid = g?.id
            if (!gid) continue
            const seq = Math.max(Number(g?.lastSeq) || 0, ackSeqs[gid] || 0)
            if (seq > (state.handled[gid] || 0)) state.handled[gid] = seq
          }
          await saveState()
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
        description: "运行时调整：enabled 开关、session 目标会话、prompt 唤醒文本。",
        input: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            session: { type: "string" },
            prompt: { type: "string" },
          },
          additionalProperties: false,
        },
        execute: async (input: any) => {
          if (typeof input?.session === "string" && input.session.trim()) {
            state.session = input.session.trim()
          }
          if (typeof input?.prompt === "string" && input.prompt.trim()) {
            prompt = input.prompt
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
      // 释放 leader，让下一个实例立刻接管
      Promise.resolve()
        .then(async () => {
          const cur = (await ctx.storage.get(LEADER_KEY)) as any
          if (cur?.id === instanceId) await ctx.storage.set(LEADER_KEY, { id: "", at: 0 })
        })
        .catch(() => {})
    }
  },
}
