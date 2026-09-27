// Project-specific Env/ctx.exports typing, the same shape as the gatekeeper-test fixture's env.d.ts.
// This file must stay a global script (no top-level import/export) for the merges to apply.

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./inbox.js");
  }

  interface Env {
    WORKSHOP_EXTERNAL_MESSAGES: Fetcher<
        import("@gadgets/workshop-shared/external-message-gateway").ExternalMessageGateway &
        Rpc.WorkerEntrypointBranded>;
    IN_SECRET?: string;
    CHAT_SECRET?: string;
    OWNER_EMAIL?: string;
    FORWARD_URL?: string;
    REPLY_URL?: string;
    FORWARD_SECRET?: string;
    FORWARD_SECRET_HEADER: string;
    TOOLS_URL?: string;
    TOOLS_TOKEN?: string;
  }
}

interface ExecutionContext<Props = unknown> {
  readonly exports: Cloudflare.Exports;
}

// ctx.restore() exists at runtime with `allow_irrevocable_stub_storage` but is not in
// @cloudflare/workers-types yet; the `restore` symbol is declared in restore.d.ts.
interface ExecutionContext<Props = unknown> {
  restore(params: unknown): Promise<unknown>;
}
