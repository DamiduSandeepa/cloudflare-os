// The `restore` symbol exists at runtime with `allow_irrevocable_stub_storage` but is not in
// @cloudflare/workers-types yet (workshop-backend patches its generated types the same way). A
// module file, so this augments "cloudflare:workers" rather than replacing it.
export {};

declare module "cloudflare:workers" {
  export const restore: unique symbol;
}
