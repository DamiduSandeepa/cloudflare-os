import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, bindings, defineGadgetsWorker, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

/**
 * Site settings and secrets live in a gitignored `.dev.vars` beside this file:
 *   IN_SECRET        callers of /in send it as `x-inbox-secret` (e.g. an iPhone Shortcut)
 *   CHAT_SECRET      callers of /chat and /models send it as `x-inbox-secret`
 *   OWNER_EMAIL      the Gadgets account chat turns run as
 *   FORWARD_URL      where /in bodies are POSTed
 *   REPLY_URL        where agent replies are POSTed
 *   FORWARD_SECRET   sent with both, in the FORWARD_SECRET_HEADER header
 *   TOOLS_URL        optional MCP endpoint whose read-only tools the agent gets as env.HOMEOS_AGENT
 *   TOOLS_TOKEN      bearer token for TOOLS_URL
 */
export default defineGadgetsWorker({
  name: "gatekeeper-inbox",
  entrypoint: ".wrangler/validate/src/inbox.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  env: {
    // Chat turns enter the Workshop through its external-message gateway, the way a
    // chat-integration worker would. `source` namespaces this bridge's gadget, chat and message keys.
    WORKSHOP_EXTERNAL_MESSAGES: bindings.worker({
      worker: "workshop-backend",
      exportName: "ExternalMessageGateway",
      props: { source: "inbox" },
    }),
    FORWARD_SECRET_HEADER: bindings.text("x-inbox-secret"),
  },
  observability: OBSERVABILITY,
});

export const wrangler = { build: CAPNWEB_VALIDATE_BUILD } satisfies WranglerExtras;
