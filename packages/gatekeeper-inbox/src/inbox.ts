// The inbox gatekeeper: a small, secret-checked bridge between an outside app and this instance.
//
//   POST /gatekeeper/inbox/in      Forwards the body to FORWARD_URL (e.g. bank SMS from an iPhone
//                                  Shortcut into HomeOS). Checked against IN_SECRET.
//   POST /gatekeeper/inbox/chat    Submits a prompt through the Workshop's ExternalMessageGateway;
//                                  the agent's reply is POSTed to REPLY_URL. Checked against
//                                  CHAT_SECRET.
//   GET  /gatekeeper/inbox/models  Models the owner can pick for a chat turn. CHAT_SECRET.
//   DELETE /gatekeeper/inbox/chat  Deletes a chat /chat created ({chatKey, gadgetKey?}). CHAT_SECRET.
//
// /in and /chat take different secrets so a leaked Shortcut secret can only forward, never drive
// the agent. The vendor has no connectable resources, so the Workshop hides it from users.
//
// While a chat turn runs, the Workshop exposes its reply target to agent code as env.HOMEOS_AGENT.
// When TOOLS_URL names an MCP endpoint, that target also offers the endpoint's read-only tools, plus
// the write tools named in TOOLS_ALLOW_WRITE, and each prompt gets a one-line hint saying how to call
// them. Every other write tool stays out of reach here: it belongs behind the Workshop's approval flow.

import { RpcTarget, WorkerEntrypoint, restore, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  GatekeeperConnectCallback, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  ChatGatewayRpcTarget, GadgetResponse,
} from "@gadgets/workshop-shared/external-message-gateway";

// Nothing but classes and the default handler may be exported from a Worker entry module: workerd
// treats every named export as an entrypoint and rejects anything that isn't one.
const PREFIX = "/gatekeeper/inbox";

type ChatRequest = {
  chatKey: string;
  messageKey: string;
  prompt: string;
  modelId?: string;
  gadgetKey?: string;
  gadgetTitle?: string;
};

type ReplyParams = { chatKey: string; messageKey: string };

type ToolInfo = { name: string; description: string; inputSchema: Record<string, unknown> };
type ListedTool = ToolInfo & { annotations?: { readOnlyHint?: boolean } };

const TOOLS_HINT = "(Your data tools, in executeCode: `await env.HOMEOS_AGENT.listTools()` lists them and " +
    "`await env.HOMEOS_AGENT.callTool(name, args)` runs one and returns text. Never call " +
    "env.HOMEOS_AGENT.onGadgetResponse.)";

export default class Inbox extends WorkerEntrypoint<Cloudflare.Env> {
  async fetch(req: Request): Promise<Response> {
    const env = this.env;
    const path = new URL(req.url).pathname.slice(PREFIX.length);
    const given = req.headers.get("x-inbox-secret") ?? "";

    if (path === "/in" && req.method === "POST") {
      if (!(await secretMatches(given, env.IN_SECRET))) return unauthorized();
      if (!env.FORWARD_URL) return json({ error: "FORWARD_URL is not configured" }, 503);
      const res = await fetch(env.FORWARD_URL, {
        method: "POST",
        headers: {
          "content-type": req.headers.get("content-type") ?? "application/json",
          ...forwardAuth(env),
        },
        body: await req.arrayBuffer(),
      });
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "text/plain" },
      });
    }

    if (path === "/chat" && req.method === "POST") {
      if (!(await secretMatches(given, env.CHAT_SECRET))) return unauthorized();
      if (!env.OWNER_EMAIL) return json({ error: "OWNER_EMAIL is not configured" }, 503);
      const body = parseChatRequest(await req.json().catch(() => null));
      if (!body) return json({ error: "expected {chatKey, messageKey, prompt, modelId?}" }, 400);

      const { chatKey, messageKey } = body;
      // The Workshop dup()s and stores the reply target until the turn ends, so it must be a
      // persistent stub: ctx.restore() seals the params, and [restore]() below rebuilds the target
      // from them whenever the stub is loaded back from storage.
      const params: ReplyParams = { chatKey, messageKey };
      const chatGatewayRpcTarget =
          await this.ctx.restore(params) as unknown as RpcStub<ChatGatewayRpcTarget>;
      const result = await env.WORKSHOP_EXTERNAL_MESSAGES.submitExternalMessage({
        callerEmail: env.OWNER_EMAIL,
        gadgetKey: body.gadgetKey ?? "main",
        gadgetTitle: body.gadgetTitle ?? "Inbox",
        chatKey,
        messageKey,
        prompt: env.TOOLS_URL ? `${body.prompt}\n\n${TOOLS_HINT}` : body.prompt,
        modelId: body.modelId,
        chatGatewayRpcTarget,
      });
      return json(result, result.accepted ? 202 : 409);
    }

    if (path === "/chat" && req.method === "DELETE") {
      if (!(await secretMatches(given, env.CHAT_SECRET))) return unauthorized();
      if (!env.OWNER_EMAIL) return json({ error: "OWNER_EMAIL is not configured" }, 503);
      const body = await req.json().catch(() => null) as { chatKey?: unknown; gadgetKey?: unknown } | null;
      if (typeof body?.chatKey !== "string" || !body.chatKey) return json({ error: "expected {chatKey, gadgetKey?}" }, 400);
      const gadgetKey = typeof body.gadgetKey === "string" ? body.gadgetKey : "main";
      const deleted = await env.WORKSHOP_EXTERNAL_MESSAGES.deleteExternalChat(env.OWNER_EMAIL, gadgetKey, body.chatKey);
      return json({ deleted });
    }

    if (path === "/models" && req.method === "GET") {
      if (!(await secretMatches(given, env.CHAT_SECRET))) return unauthorized();
      if (!env.OWNER_EMAIL) return json({ error: "OWNER_EMAIL is not configured" }, 503);
      const models = await env.WORKSHOP_EXTERNAL_MESSAGES.listModels(env.OWNER_EMAIL);
      return json(models.map(({ id, name }) => ({ id, name })));
    }

    return json({ error: "not found" }, 404);
  }

  [restore](params: ReplyParams): ReplyTarget {
    return new ReplyTarget(params, this.env);
  }
}

/** Receives the agent's reply for one chat message and hands it to REPLY_URL. */
@validateRpc()
class ReplyTarget extends RpcTarget {
  #params: ReplyParams;
  #env: Cloudflare.Env;

  constructor(params: ReplyParams, env: Cloudflare.Env) {
    super();
    this.#params = params;
    this.#env = env;
  }

  async onGadgetResponse(response: GadgetResponse): Promise<void> {
    if (!this.#env.REPLY_URL) throw new Error("REPLY_URL is not configured");
    const res = await fetch(this.#env.REPLY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...forwardAuth(this.#env) },
      body: JSON.stringify({ ...this.#params, text: response.text }),
    });
    // Throwing leaves the reply queued in the Workshop, which retries the delivery later.
    if (!res.ok) throw new Error(`reply delivery failed: HTTP ${res.status}`);
  }

  /** The tools at TOOLS_URL the agent may run: read-only ones and the allowed write ones. */
  async listTools(): Promise<ToolInfo[]> {
    return (await this.#allowedTools()).map(({ name, description, inputSchema }) =>
      ({ name, description, inputSchema }));
  }

  /** Runs an allowed tool and returns its text output. */
  async callTool(name: string, args?: Record<string, unknown>): Promise<string> {
    // Checked against a fresh list on every call, so a tool that stops being read-only is refused.
    if (!(await this.#allowedTools()).some(tool => tool.name === name)) {
      throw new Error(`No tool named "${name}" is available here. Call listTools() to see them.`);
    }
    const result = await this.#mcp("tools/call", { name, arguments: args ?? {} }) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? []).map(part => part.text ?? "").join("\n");
    if (result.isError) throw new Error(text || `${name} failed`);
    return text;
  }

  // Write tools pass only when named in TOOLS_ALLOW_WRITE, so a new write tool on the endpoint (such
  // as one that moves money) stays behind the approval flow until someone allows it here.
  async #allowedTools(): Promise<ListedTool[]> {
    const { tools } = await this.#mcp("tools/list", {}) as { tools: ListedTool[] };
    const writes = new Set((this.#env.TOOLS_ALLOW_WRITE ?? "").split(",").map(n => n.trim()).filter(Boolean));
    return tools.filter(tool => tool.annotations?.readOnlyHint === true || writes.has(tool.name));
  }

  // One stateless JSON-RPC request; enough for servers that answer with plain JSON.
  async #mcp(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.#env.TOOLS_URL) throw new Error("No tools are configured for this chat.");
    const res = await fetch(this.#env.TOOLS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.#env.TOOLS_TOKEN ? { authorization: `Bearer ${this.#env.TOOLS_TOKEN}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`Tools endpoint answered HTTP ${res.status}`);
    const body = await res.json() as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Inbox",
      url: "https://github.com/DamiduSandeepa/cloudflare-os",
      tagline: "A bridge for an outside app",
    };
  }

  /** An empty list hides this vendor from the Connectors page. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return "";
  }

  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    throw new Error("The inbox bridge has no accounts to connect.");
  }
}

function parseChatRequest(body: unknown): ChatRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  for (const field of ["chatKey", "messageKey", "prompt"]) {
    if (typeof b[field] !== "string" || !b[field]) return null;
  }
  for (const field of ["modelId", "gadgetKey", "gadgetTitle"]) {
    if (b[field] !== undefined && typeof b[field] !== "string") return null;
  }
  return b as ChatRequest;
}

// Hashing first gives timingSafeEqual equal-length inputs, so the secret's length doesn't leak.
async function secretMatches(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map(s =>
    crypto.subtle.digest("SHA-256", encoder.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

function forwardAuth(env: Cloudflare.Env): Record<string, string> {
  return env.FORWARD_SECRET ? { [env.FORWARD_SECRET_HEADER]: env.FORWARD_SECRET } : {};
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
