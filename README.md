# dsh-telegram

**Telegram runtime adapter for DeepSeek Harness** — talk to your dsh agents from Telegram. Every allowed chat maps to one agent session (or one session per Telegram forum topic when enabled); messages flow in via `followup()`, committed assistant text streams back to the chat. Zero runtime dependencies (plain HTTP over Node's built-in `fetch`).

## Overview

dsh-telegram turns a DeepSeek Harness agent into a Telegram bot. It is a *protocol driver* in the dsh extension model: it adapts an external wire peer (Telegram) to `ctx.agents`, the same role the official ACP/JSON-RPC bridges play — but for human chat instead of automation.

**Who is it for?**

- Anyone who wants to query their DeepSeek agents from a phone, without opening the web UI.
- Teams that want a shared, auditable chat surface in front of a harness (Telegram history is kept by Telegram).
- Developers who want a minimal, readable reference for writing a protocol-driver plugin.

**What it does**

- Long-polls the Telegram Bot API (`getUpdates`) with no server, no webhook, no framework.
- Creates one dsh agent session per allowed chat on first message; when `topicsEnabled` is enabled, each Telegram forum topic (`message_thread_id`) in a chat gets its own session and context. Subsequent messages `followup()` into the same session.
- Streams every committed assistant message back to the chat; long replies are split at Telegram's 4096-char limit.
- Supports `/start`, `/new` (fresh chat/topic session), `/status`.
- Rejects unauthorized users outright (configurable allowlist).

**What it does not do (yet)**

- No webhook mode (requires a public HTTPS endpoint).
- No inline keyboards, media, voice, or rich messages — text in, text out.
- No cross-restart persistence of chat→session mapping (see Compatibility).

## Compatibility

- Requires **Node.js ≥ 22.19** (uses global `fetch`).
- Built and verified against `@deepseek-ai/dsh@0.1.0-rc.6` / `@deepseek-ai/cordis@^4.0.1`.
- **Last verified:** 2026-08-13 against mainline commit of the same day (dsh repo `master`).
- dsh is in developer preview and iterates rapidly. Pin your dsh version and re-verify after updates; the plugin's peer dependencies (`@deepseek-ai/dsh-agent`, `dsh-llm`, `dsh-session`) may change shape between RC releases.
- Chat/topic→session mapping lives in memory: restarting dsh loses open sessions (use `/new` to start a fresh one).

## Install / Uninstall

Install into a dsh profile (local checkout; no build permission needed):

```sh
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-telegram
```

From GitHub (source install — pnpm runs the `prepare` script, so allow it once):

```sh
pnpm dsh plugin --profile web add github:<you>/dsh-telegram
# pnpm ≥10 blocks the build script on first install; copy the printed package key
# into <profile>/pnpm-workspace.yaml under allowBuilds, then re-run.
```

From npm (once published):

```sh
pnpm dsh plugin --profile web add dsh-telegram
```

Uninstall:

```sh
pnpm dsh plugin --profile web remove dsh-telegram
```

## Quick start

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Find your Telegram user id (e.g. message [@userinfobot](https://t.me/userinfobot)).
3. Set the token and your user id in the profile's `cordis.patch.yml` (or export `DSH_TELEGRAM_BOT_TOKEN`):

   ```yaml
   - id: dsh-telegram
     name: dsh-telegram
     config:
       botToken: '123456:ABC-DEF...'
       allowedUserIds: [123456789]
       provider: deepseek-official
       model: deepseek-v4-flash
   ```

4. Start dsh, open your bot in Telegram, send `/start`, then any message.

## Configuration

All keys live under the `dsh-telegram` row's `config` (patch layer; later layers win per row).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `botToken` | string | env `DSH_TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather. Empty disables sending. |
| `allowedUserIds` | number[] | `[]` | Telegram user ids allowed to chat. **Empty = everyone rejected.** |
| `provider` | string | — | Provider route for created agents (falls back to profile default). |
| `model` | string | — | Model for created agents (falls back to profile default). |
| `cwd` | string | `process.cwd()` | Working directory for created agent sessions. |
| `pollTimeoutSeconds` | number | `25` | Long-poll timeout for `getUpdates` (Telegram max 50). |
| `topicsEnabled` | boolean | `false` | Treat Telegram forum topics as separate sessions keyed by `message_thread_id`. Replies and typing indicators are sent back to the originating topic. |

## Permissions & data

- **Authorization:** the allowlist is the only gate. Unauthorized users receive `⛔ You are not authorized` and are never given an agent session. The bot token itself is the secret that lets anyone *call* your bot; the allowlist decides who gets a session.
- **Network:** the plugin talks only to `api.telegram.org` (bot API). Agent model calls go through the harness's normal LLM provider path.
- **Filesystem:** no files are read or written by this plugin; agent sessions inherit the harness workspace policy.
- **Secrets:** never commit `botToken` to the repository. Use the env-var form in the shipped patch (`process.env.DSH_TELEGRAM_BOT_TOKEN ?? ''`).
- **Transcripts:** Telegram keeps chat history on its servers; dsh sessions additionally persist per the harness session persistence config.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Bot never replies, `botToken is empty` warning | Token not configured | Set `DSH_TELEGRAM_BOT_TOKEN` or `config.botToken`; restart dsh |
| `⛔ You are not authorized` | Your user id is not in `allowedUserIds` | Add your id; restart dsh |
| `poll error: telegram getUpdates: 401` | Token invalid/revoked | Recreate token in @BotFather |
| Replies stop mid-conversation | Agent error | Check dsh logs; the error is forwarded to the chat with `⚠️ Agent error:` |
| Long poll spam in logs | Network to `api.telegram.org` blocked/unstable | Ensure the machine can reach `api.telegram.org` (proxy env vars are respected by Node `fetch`); the plugin backs off automatically |
| `cannot get property "agents" without inject` | Plugin loaded without `inject` metadata (stale build) | Rebuild: `pnpm run build`; verify the installed `lib/index.js` is fresh |

## Development

```sh
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run build         # tsc → lib/
```

Structure:

- `src/index.ts` — plugin entry (`name`/`inject`/`Config`/`apply`), Telegram client, long-poll loop, session mapping.
- `cordis.patch.yml` — the bundle patch layer that mounts the plugin row.

Design notes for contributors:

- **Zero runtime dependencies** is a goal: the Bot API surface used here is intentionally small (`getUpdates`, `sendMessage`, `sendChatAction`). Before adding a dependency, ask whether Node's built-ins cover it.
- Session mapping is deliberately in-memory. By default, one chat = one agent; set `topicsEnabled: true` to use one `(chat, topic)` pair = one agent for Telegram forum topics. A future version may persist mappings; see Compatibility.

## License & security

MIT. Report security issues privately via the repository's security advisory (or open an issue without secrets). The plugin runs the Telegram token as configured by the operator; it executes no model code itself — all agent behavior is governed by the harness's own permission and sandbox policy.
