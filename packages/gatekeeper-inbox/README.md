# gatekeeper-inbox

A small bridge between an outside app (here: HomeOS) and this instance. It has no connectable
resources, so it never shows up on the Connectors page.

| Route                          | Secret (`x-inbox-secret`) | Does                                                    |
| ------------------------------ | ------------------------- | ------------------------------------------------------- |
| `POST /gatekeeper/inbox/in`    | `IN_SECRET`               | Forwards the body to `FORWARD_URL` (e.g. iPhone SMS).   |
| `POST /gatekeeper/inbox/chat`  | `CHAT_SECRET`             | Sends a prompt to the agent; the reply goes to `REPLY_URL`. |
| `GET /gatekeeper/inbox/models` | `CHAT_SECRET`             | Lists models the owner can pick for a chat turn.        |

`/chat` takes `{chatKey, messageKey, prompt, modelId?, gadgetKey?, gadgetTitle?}` and submits it
through the Workshop's `ExternalMessageGateway` (source `inbox`) as `OWNER_EMAIL`. The reply target
is a persistent stub (`ctx.restore()`) that POSTs `{chatKey, messageKey, text}` to `REPLY_URL`. Delivery
is at least once, so the receiver should upsert by `messageKey`.

While the turn runs, the Workshop exposes that target to agent code as `env.HOMEOS_AGENT`. With
`TOOLS_URL` set to an MCP endpoint, it also offers `listTools()` and `callTool(name, args)` for the
endpoint's **read-only** tools (by `readOnlyHint`, rechecked on every call), and each prompt gets a
one-line hint about them. Write tools stay behind the Workshop's approval flow.

## Config

Put these in a gitignored `.dev.vars` next to `wrangler.jsonc`:

```
IN_SECRET=...
CHAT_SECRET=...
OWNER_EMAIL=you@example.com
FORWARD_URL=http://127.0.0.1:8790/sms
REPLY_URL=http://127.0.0.1:8790/api/chat/reply
FORWARD_SECRET=...
FORWARD_SECRET_HEADER=x-homeos-secret
TOOLS_URL=http://127.0.0.1:8790/mcp
TOOLS_TOKEN=...
```

## Smoke test

With the dev server running and `REPLY_URL` pointing at `http://127.0.0.1:8799/reply`:

```
IN_SECRET=... CHAT_SECRET=... node scripts/smoke.ts
```
