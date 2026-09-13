import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose } from "../cli/options";
import { parseBody } from "../lib/body";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

export const INLINE_HOOKS: ResourceSpec = { name: "inlinehooks", description: "Inline hook operations", path: "/inlineHooks", singular: "inline hook", nameField: "name", defaultFields: "id,status,type,version,name", lifecycle: true, creatable: false,
  listOptions: [{ flags: "-t, --type <type>", param: "type", description: "inline hook type, e.g. com.okta.oauth2.tokens.transform" }] };
export const HOOK_KEYS: ResourceSpec = { name: "hook-keys", description: "Hook keys (OAuth 2.0 client credentials for hooks)", path: "/hook-keys", singular: "hook key", nameField: "name", defaultFields: "id,name,keyId,created,lastUpdated", creatable: false };

export function inlineHookBody(opts: { name: string; type: string; url: string; version?: string; method?: string; authHeader?: string; authValue?: string }): Record<string, unknown> {
  const config: Record<string, unknown> = { uri: opts.url, method: opts.method ?? "POST", headers: [] };
  if (opts.authHeader && opts.authValue) config.authScheme = { type: "HEADER", key: opts.authHeader, value: opts.authValue };
  return { name: opts.name, type: opts.type, version: opts.version ?? "1.0.0", channel: { type: "HTTP", version: "1.0.0", config } };
}

export function registerInlinehooks(program: Command, ctx: Ctx): void {
  const g = defineResource(program, ctx, INLINE_HOOKS);

  addOutputOptions(addVerbose(g.command("add").description("Create an inline hook")
    .requiredOption("-n, --name <name>").requiredOption("-t, --type <type>", "inline hook type, e.g. com.okta.oauth2.tokens.transform").requiredOption("-u, --url <uri>")
    .option("--version <version>", "hook version", "1.0.0").option("--method <method>", "HTTP method", "POST")
    .option("--auth-header <key>", "auth scheme header name").option("--auth-value <secret>", "auth scheme header value")), INLINE_HOOKS.defaultFields)
    .action(action(ctx, (client, opts) => client.json("POST", "/inlineHooks", { body: inlineHookBody(opts as Parameters<typeof inlineHookBody>[0]) })));

  addOutputOptions(addVerbose(g.command("execute").description("Execute an inline hook with a test payload").argument("<name-or-id>")
    .option("-b, --body <json>", "JSON body; FILE:<path> reads a file")), null)
    .action(action(ctx, async (client, opts, nameOrId) => {
      const hook = await resourceGet(client, INLINE_HOOKS, nameOrId);
      return client.json("POST", `/inlineHooks/${hook.id}/execute`, { body: parseBody(opts.body) });
    }));

  const hk = defineResource(program, ctx, HOOK_KEYS);
  addOutputOptions(addVerbose(hk.command("add").description("Create a hook key").requiredOption("-n, --name <name>")), HOOK_KEYS.defaultFields)
    .action(action(ctx, (client, opts) => client.json("POST", "/hook-keys", { body: { name: opts.name } })));

  addOutputOptions(addVerbose(hk.command("public").description("Get the public key for a hook key").argument("<keyId>")), null)
    .action(action(ctx, (client, _o, keyId) => client.get(`/hook-keys/public/${keyId}`)));
}
