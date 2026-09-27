// End-to-end smoke test against a running instance. Needs REPLY_URL in .dev.vars to point at
// http://127.0.0.1:$REPLY_PORT/reply while it runs.
//
//   INBOX_URL=http://127.0.0.1:8787/gatekeeper/inbox IN_SECRET=... CHAT_SECRET=... \
//     node scripts/smoke.ts
//
// It checks that both secrets are enforced, that /in reaches FORWARD_URL (the body `{"text":""}`
// makes HomeOS answer 400 "empty message" after its own secret check, so nothing is stored), and
// that a chat prompt comes back through REPLY_URL.

import { createServer } from "node:http";

const INBOX_URL = process.env.INBOX_URL ?? "http://127.0.0.1:8787/gatekeeper/inbox";
const IN_SECRET = must("IN_SECRET");
const CHAT_SECRET = must("CHAT_SECRET");
const REPLY_PORT = Number(process.env.REPLY_PORT ?? 8799);
const TIMEOUT_MS = 180_000;

function must(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function check(label: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  if (!ok) process.exitCode = 1;
}

async function call(path: string, secret: string, body?: unknown) {
  const res = await fetch(INBOX_URL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-inbox-secret": secret },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const replies = new Map<string, string>();
const server = createServer((req, res) => {
  let data = "";
  req.on("data", chunk => { data += chunk; });
  req.on("end", () => {
    const { messageKey, text } = JSON.parse(data) as { messageKey: string; text: string };
    replies.set(messageKey, text);
    res.writeHead(204).end();
  });
});
await new Promise<void>(resolve => server.listen(REPLY_PORT, "127.0.0.1", resolve));

try {
  let r = await call("/in", "wrong", { text: "" });
  check("/in rejects a wrong secret", r.status === 401, r);
  r = await call("/in", CHAT_SECRET, { text: "" });
  check("/in rejects the chat secret", r.status === 401, r);
  r = await call("/in", IN_SECRET, { text: "" });
  check("/in forwards to FORWARD_URL", r.status === 400 && r.body?.error === "empty message", r);

  r = await call("/chat", IN_SECRET, { chatKey: "smoke", messageKey: "x", prompt: "hi" });
  check("/chat rejects the in secret", r.status === 401, r);
  r = await call("/models", CHAT_SECRET);
  check("/models lists the owner's models", r.status === 200 && Array.isArray(r.body), r);

  const messageKey = `smoke-${Date.now()}`;
  r = await call("/chat", CHAT_SECRET, {
    chatKey: `smoke-${new Date().toISOString().slice(0, 10)}`,
    messageKey,
    gadgetKey: "smoke",
    gadgetTitle: "Inbox smoke test",
    prompt: "Reply with exactly the word pong and nothing else. Do not use any tools.",
  });
  check("/chat accepts a prompt", r.status === 202 && r.body?.accepted === true, r);

  if (r.status === 202) {
    const started = Date.now();
    while (!replies.has(messageKey) && Date.now() - started < TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const text = replies.get(messageKey);
    check(`agent reply arrives at REPLY_URL (${Math.round((Date.now() - started) / 1000)}s)`,
        /pong/i.test(text ?? ""), text ?? "timed out");
  }
} finally {
  server.close();
}
