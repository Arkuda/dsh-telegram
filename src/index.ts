/**
 * dsh-telegram — Telegram runtime adapter for DeepSeek Harness.
 *
 * Bridges Telegram chats to dsh agents: every allowed chat maps to one agent
 * session; user messages are forwarded with `followup()`, and committed
 * assistant text streams back to the chat. Zero runtime dependencies — the
 * Telegram Bot API is plain HTTP over Node's built-in fetch.
 *
 * @module dsh-telegram
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'dsh-telegram'
export const inject = ['agents', 'sessions']

/** Plugin config: bot credentials, authorization, and default agent options. */
export interface TelegramConfig {
  /** Telegram bot token from @BotFather. Required at runtime. */
  botToken: string
  /** Telegram user ids allowed to talk to the agent. Empty means everyone is rejected. */
  allowedUserIds: number[]
  /** Default provider route for created agents. */
  provider?: string
  /** Default model for created agents. */
  model?: string
  /** Working directory for created agents. */
  cwd?: string
  /** Long-poll timeout in seconds (Telegram max 50). */
  pollTimeoutSeconds?: number
  /** Treat Telegram forum topics as separate sessions when message_thread_id is present. */
  topicsEnabled?: boolean
}

export const Config: Schema<TelegramConfig> = Schema.object({
  botToken: Schema.string().required(),
  allowedUserIds: Schema.array(Number).required(),
  provider: Schema.string(),
  model: Schema.string(),
  cwd: Schema.string(),
  pollTimeoutSeconds: Schema.number().default(25),
  topicsEnabled: Schema.boolean().default(false),
})

/** Max Telegram message length; longer replies are split on newline boundaries. */
const TG_MAX_MESSAGE = 4000
const TG_API = 'https://api.telegram.org'

interface TgResult<T> {
  ok: boolean
  result?: T
  description?: string
}

interface TgUpdate {
  update_id: number
  message?: TgMessage
}

interface TgMessage {
  message_id: number
  message_thread_id?: number
  chat: { id: number; type: string }
  from?: { id: number; first_name?: string; username?: string }
  text?: string
}

/** One Telegram chat/topic mapped to one dsh agent session. */
interface ChatSession {
  key: string
  chatId: number
  threadId?: number
  agent: Agent
  dispose: () => Promise<void>
}

async function tgCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as TgResult<T>
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? 'unknown error'}`)
  return data.result as T
}

/** Split long text into Telegram-sized chunks at newline boundaries. */
export function splitLong(text: string, max = TG_MAX_MESSAGE): string[] {
  if (text.length <= max) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < 1) cut = max
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

export function getSessionKey(chatId: number, threadId: number | undefined, topicsEnabled: boolean): string {
  return topicsEnabled && threadId !== undefined ? `${chatId}:${threadId}` : `${chatId}`
}

export function apply(ctx: Context, config: TelegramConfig): void {
  const agents = ctx.agents
  const logger = ctx.logger
  const sessions = new Map<string, ChatSession>()
  let offset = 0
  let stopped = false
  let lastErrorAt = 0

  if (config.botToken.length === 0) {
    logger.warn('dsh-telegram: botToken is empty; set DSH_TELEGRAM_BOT_TOKEN or config.botToken')
  }
  if (config.allowedUserIds.length === 0) {
    logger.warn('dsh-telegram: allowedUserIds is empty; every chat will be rejected. Add your Telegram user id to config.')
  }

  const isAllowed = (userId: number | undefined): boolean =>
    userId !== undefined && config.allowedUserIds.includes(userId)

  const sendText = (chatId: number, text: string, threadId?: number): Promise<unknown> =>
    Promise.all(splitLong(text).map((part) =>
      tgCall<unknown>(config.botToken, 'sendMessage', {
        chat_id: chatId,
        text: part,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      })
        .catch((error: unknown) => logger.warn(`dsh-telegram: sendMessage failed: ${String(error)}`)),
    ))

  const typing = (chatId: number, threadId?: number): void => {
    void tgCall<unknown>(config.botToken, 'sendChatAction', {
      chat_id: chatId,
      action: 'typing',
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    })
      .catch(() => undefined)
  }

  const ensureSession = async (chatId: number, threadId?: number): Promise<ChatSession> => {
    const key = getSessionKey(chatId, threadId, config.topicsEnabled ?? false)
    const existing = sessions.get(key)
    if (existing !== undefined) return existing
    const sessionId = SessionId(randomUUID())
    const agentOptions: Record<string, string> = {}
    if (config.provider !== undefined) agentOptions.provider = config.provider
    if (config.model !== undefined) agentOptions.model = config.model
    const handle = await agents.create({
      sessionId,
      meta: { cwd: config.cwd ?? process.cwd() },
      agentOptions,
    })
    const record: ChatSession = {
      key,
      chatId,
      threadId: config.topicsEnabled === true ? threadId : undefined,
      agent: handle.agent,
      dispose: () => handle.dispose(),
    }
    sessions.set(key, record)
    logger.info(
      `dsh-telegram: created agent ${sessionId} for chat ${chatId}` +
      `${record.threadId !== undefined ? ` topic ${record.threadId}` : ''}`,
    )
    return record
  }

  const disposeSession = async (record: ChatSession): Promise<void> => {
    sessions.delete(record.key)
    await record.dispose()
  }

  /** Stream committed assistant text back to the owning chat. */
  ctx.on('session/event', (session, event: SessionEvent) => {
    for (const record of sessions.values()) {
      if (record.agent.session !== session) continue
      if (event.type === 'assistant/message') {
        const text = event.data.message.content
          .map((block) => {
            if (block.type === 'text') return block.text
            if (block.type === 'image') return `[image attachment ${block.attachment.attachmentId}]`
            return ''
          })
          .filter((part) => part.length > 0)
          .join('\n')
        if (text.length > 0) void sendText(record.chatId, text, record.threadId)
      }
    }
  })

  /** Surface agent failures as a chat message. */
  ctx.on('agent/error', ({ agent, error }) => {
    for (const record of sessions.values()) {
      if (record.agent !== agent) continue
      const message = error instanceof Error ? error.message : String(error)
      void sendText(record.chatId, `⚠️ Agent error: ${message}`, record.threadId)
    }
  })

  const handleCommand = async (record: ChatSession, text: string): Promise<boolean> => {
    const command = text.split(/\s+/)[0]
    if (command === '/start') {
      await sendText(record.chatId,
        '🤖 Connected to DeepSeek Harness.\n\n' +
        'Send any message to talk to the agent. Commands:\n' +
        '/new — start a fresh session\n' +
        '/status — show session info',
        record.threadId)
      return true
    }
    if (command === '/new') {
      await disposeSession(record)
      const fresh = await ensureSession(record.chatId, record.threadId)
      await sendText(record.chatId, '🔄 New session started.', record.threadId)
      void fresh.agent
      return true
    }
    if (command === '/status') {
      await sendText(record.chatId,
        `Session: ${record.agent.session.id}\n` +
        `Scope: ${record.threadId !== undefined ? `topic ${record.threadId}` : 'chat'}\n` +
        `Model: ${config.model ?? 'default'}\n` +
        `Agent alive: ${ctx.agents.get(record.agent.id) === record.agent}`,
        record.threadId)
      return true
    }
    return false
  }

  /** Long-poll loop: fetch updates, dispatch to the right chat's agent. */
  const pollLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const updates = await tgCall<TgUpdate[]>(config.botToken, 'getUpdates', {
          offset,
          timeout: config.pollTimeoutSeconds ?? 25,
        })
        for (const update of updates) {
          if (update.update_id >= offset) offset = update.update_id + 1
          const message = update.message
          if (message === undefined || message.text === undefined) continue
          const chatId = message.chat.id
          const threadId = config.topicsEnabled === true ? message.message_thread_id : undefined
          if (!isAllowed(message.from?.id)) {
            void sendText(chatId, '⛔ You are not authorized to use this bot.', threadId)
            continue
          }
          const record = await ensureSession(chatId, threadId)
          if (await handleCommand(record, message.text)) continue
          typing(chatId, threadId)
          const userMessage = createUserMessage({
            content: [{ type: 'text', text: message.text }],
            source: { kind: 'user' },
          })
          record.agent.followup(userMessage)
        }
        lastErrorAt = 0
      } catch (error: unknown) {
        // Long polls fail on timeouts and transient network errors; back off
        // briefly instead of spinning.
        const now = Date.now()
        if (now - lastErrorAt > 30_000) {
          logger.warn(`dsh-telegram: poll error: ${String(error)}`)
          lastErrorAt = now
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  }

  const stop = async (): Promise<void> => {
    stopped = true
    await Promise.all([...sessions.values()].map((record) => record.dispose()))
    sessions.clear()
  }

  ctx.effect(() => {
    void pollLoop()
    return () => {
      void stop()
    }
  })
}
