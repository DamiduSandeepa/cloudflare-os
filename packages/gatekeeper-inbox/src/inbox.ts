// The inbox gatekeeper: a small, secret-checked bridge between an outside app and this instance.
//
//   POST /gatekeeper/inbox/in      Forwards the body to FORWARD_URL (e.g. bank SMS from an iPhone
//                                  Shortcut into HomeOS). Checked against IN_SECRET.
//   POST /gatekeeper/inbox/chat    Submits a prompt through the Workshop's ExternalMessageGateway;
//                                  the agent's reply is POSTed to REPLY_URL. Checked against
//                                  CHAT_SECRET.
//   GET  /gatekeeper/inbox/models  Models the owner can pick for a chat turn. CHAT_SECRET.
//
// /in and /chat take different secrets so a leaked Shortcut secret can only forward, never drive
// the agent. The vendor has no connectable resources, so the Workshop hides it from users.

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
        prompt: body.prompt,
        modelId: body.modelId,
        chatGatewayRpcTarget,
      });
      return json(result, result.accepted ? 202 : 409);
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
