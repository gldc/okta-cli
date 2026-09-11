import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addVerbose } from "../cli/options";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

export const TOKENS: ResourceSpec = { name: "tokens", description: "API token operations", path: "/api-tokens", singular: "API token", nameField: "name",
  defaultFields: "id,name,userId,created,expiresAt,tokenWindow", creatable: false, replaceable: false, deletable: false };

export function registerTokens(program: Command, ctx: Ctx): void {
  const g = defineResource(program, ctx, TOKENS);
  addVerbose(g.command("revoke").description("Revoke an API token").argument("<name-or-id>"))
    .action(action(ctx, async (client, _o, nameOrId) => {
      const tok = await resourceGet(client, TOKENS, nameOrId);
      await client.json("DELETE", `/api-tokens/${tok.id}`);
      return `API token ${tok.id} (${tok.name}) revoked`;
    }));
  addVerbose(g.command("revoke-current").description("Revoke the API token used for this request"))
    .action(action(ctx, async (client) => { await client.json("DELETE", "/api-tokens/current"); return "current API token revoked"; }));
}
