import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts } from "../cli/options";
import type { OktaClient } from "../okta/client";
import { defineResource, getNested, resourceGet, type ResourceSpec } from "./resource";

const SCOPE_FIELDS = "id,name,displayName,default,consent,system";
const CLAIM_FIELDS = "id,name,claimType,valueType,status,alwaysIncludeInToken";
const AS_POLICY_FIELDS = "id,status,priority,name";
const AS_RULE_FIELDS = "id,status,priority,name,type";
const CLIENT_FIELDS = "client_id,client_name";
// Deviation from the plan: the OAuth2RefreshToken schema has no `issued` field, only `created`.
const TOKEN_FIELDS = "id,status,created,expiresAt,userId,scopes";
const KEY_FIELDS = "kid,status,use,alg";
// Deviation from the plan: schema JwkUse is `{ use?: "sig" }` (a single enum value, not an
// array), so `rotate-keys` posts `{ use: "sig" }` rather than `{ use: ["<kid>"] }`.
const KEY_USE_CHOICES = ["sig"];
const RESOURCE_KEY_FIELDS = "id,kid,status,kty,created";

export const AUTH_SERVERS: ResourceSpec = {
  name: "auth-servers", description: "Custom authorization servers (OAuth 2.0 / OIDC)", path: "/authorizationServers", singular: "authorization server",
  nameField: "name", defaultFields: "id,status,name,audiences,issuer", lifecycle: true,
};

function sortByPriority(items: any[]): any[] {
  return [...items].sort((a, b) => (typeof a.priority === "number" && typeof b.priority === "number" ? a.priority - b.priority : String(a.priority ?? "").localeCompare(String(b.priority ?? ""))));
}

export function registerAuthServers(program: Command, ctx: Ctx): Command {
  const g = defineResource(program, ctx, AUTH_SERVERS);
  const resolveServer = (client: OktaClient, arg: string) => resourceGet(client, AUTH_SERVERS, arg);

  addOutputOptions(addVerbose(g.command("scopes").description("List a custom authorization server's scopes").argument("<server>")), SCOPE_FIELDS)
    .action(action(ctx, async (client, _o, serverArg) => {
      const server = await resolveServer(client, serverArg);
      return client.getAll(`/authorizationServers/${server.id}/scopes`);
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("scope-add").description("Create a scope on a custom authorization server").argument("<server>"))), SCOPE_FIELDS)
    .action(action(ctx, async (client, opts, serverArg) => {
      const server = await resolveServer(client, serverArg);
      return client.json("POST", `/authorizationServers/${server.id}/scopes`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(g.command("scope-delete").description("Delete a scope from a custom authorization server").argument("<server>").argument("<scope-name-or-id>"))
    .action(action(ctx, async (client, _o, serverArg, scopeArg) => {
      const server = await resolveServer(client, serverArg);
      const scope = await getNested(client, `/authorizationServers/${server.id}/scopes`, scopeArg, "name", "authorization server scope");
      await client.json("DELETE", `/authorizationServers/${server.id}/scopes/${scope.id}`);
      return `scope ${scope.id} (${scope.name}) deleted from authorization server ${server.id}`;
    }));

  addOutputOptions(addVerbose(g.command("claims").description("List a custom authorization server's claims").argument("<server>")), CLAIM_FIELDS)
    .action(action(ctx, async (client, _o, serverArg) => {
      const server = await resolveServer(client, serverArg);
      return client.getAll(`/authorizationServers/${server.id}/claims`);
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("claim-add").description("Create a claim on a custom authorization server").argument("<server>"))), CLAIM_FIELDS)
    .action(action(ctx, async (client, opts, serverArg) => {
      const server = await resolveServer(client, serverArg);
      return client.json("POST", `/authorizationServers/${server.id}/claims`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(g.command("claim-delete").description("Delete a claim from a custom authorization server").argument("<server>").argument("<claim-name-or-id>"))
    .action(action(ctx, async (client, _o, serverArg, claimArg) => {
      const server = await resolveServer(client, serverArg);
      const claim = await getNested(client, `/authorizationServers/${server.id}/claims`, claimArg, "name", "authorization server claim");
      await client.json("DELETE", `/authorizationServers/${server.id}/claims/${claim.id}`);
      return `claim ${claim.id} (${claim.name}) deleted from authorization server ${server.id}`;
    }));

  addOutputOptions(addVerbose(g.command("policies").description("List a custom authorization server's policies").argument("<server>")), AS_POLICY_FIELDS)
    .action(action(ctx, async (client, _o, serverArg) => {
      const server = await resolveServer(client, serverArg);
      return sortByPriority(await client.getAll(`/authorizationServers/${server.id}/policies`));
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("policy-add").description("Create a policy on a custom authorization server").argument("<server>"))), AS_POLICY_FIELDS)
    .action(action(ctx, async (client, opts, serverArg) => {
      const server = await resolveServer(client, serverArg);
      return client.json("POST", `/authorizationServers/${server.id}/policies`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(g.command("policy-delete").description("Delete a policy from a custom authorization server").argument("<server>").argument("<policy-name-or-id>"))
    .action(action(ctx, async (client, _o, serverArg, policyArg) => {
      const server = await resolveServer(client, serverArg);
      const policy = await getNested(client, `/authorizationServers/${server.id}/policies`, policyArg, "name", "authorization server policy");
      await client.json("DELETE", `/authorizationServers/${server.id}/policies/${policy.id}`);
      return `policy ${policy.id} (${policy.name}) deleted from authorization server ${server.id}`;
    }));

  for (const verb of ["activate", "deactivate"] as const) {
    addOutputOptions(addVerbose(g.command(`policy-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} a custom authorization server policy`).argument("<server>").argument("<policy>")), AS_POLICY_FIELDS)
      .action(action(ctx, async (client, _o, serverArg, policyArg) => {
        const server = await resolveServer(client, serverArg);
        const policy = await getNested(client, `/authorizationServers/${server.id}/policies`, policyArg, "name", "authorization server policy");
        const rv = await client.json("POST", `/authorizationServers/${server.id}/policies/${policy.id}/lifecycle/${verb}`);
        return rv ?? `policy ${policy.id} (${policy.name}) ${verb}d`;
      }));
  }

  addOutputOptions(addVerbose(g.command("rules").description("List a custom authorization server policy's rules").argument("<server>").argument("<policy>")), AS_RULE_FIELDS)
    .action(action(ctx, async (client, _o, serverArg, policyArg) => {
      const server = await resolveServer(client, serverArg);
      const policy = await getNested(client, `/authorizationServers/${server.id}/policies`, policyArg, "name", "authorization server policy");
      return sortByPriority(await client.getAll(`/authorizationServers/${server.id}/policies/${policy.id}/rules`));
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("rule-add").description("Create a rule on a custom authorization server policy").argument("<server>").argument("<policy>"))), AS_RULE_FIELDS)
    .action(action(ctx, async (client, opts, serverArg, policyArg) => {
      const server = await resolveServer(client, serverArg);
      const policy = await getNested(client, `/authorizationServers/${server.id}/policies`, policyArg, "name", "authorization server policy");
      return client.json("POST", `/authorizationServers/${server.id}/policies/${policy.id}/rules`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(g.command("rule-delete").description("Delete a rule from a custom authorization server policy").argument("<server>").argument("<policy>").argument("<rule>"))
    .action(action(ctx, async (client, _o, serverArg, policyArg, ruleArg) => {
      const server = await resolveServer(client, serverArg);
      const policy = await getNested(client, `/authorizationServers/${server.id}/policies`, policyArg, "name", "authorization server policy");
      const rule = await getNested(client, `/authorizationServers/${server.id}/policies/${policy.id}/rules`, ruleArg, "name", "authorization server policy rule");
      await client.json("DELETE", `/authorizationServers/${server.id}/policies/${policy.id}/rules/${rule.id}`);
      return `rule ${rule.id} (${rule.name}) deleted from policy ${policy.id} on authorization server ${server.id}`;
    }));

  for (const verb of ["activate", "deactivate"] as const) {
    addOutputOptions(addVerbose(g.command(`rule-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} a custom authorization server policy rule`).argument("<server>").argument("<policy>").argument("<rule>")), AS_RULE_FIELDS)
      .action(action(ctx, async (client, _o, serverArg, policyArg, ruleArg) => {
        const server = await resolveServer(client, serverArg);
        const policy = await getNested(client, `/authorizationServers/${server.id}/policies`, policyArg, "name", "authorization server policy");
        const rule = await getNested(client, `/authorizationServers/${server.id}/policies/${policy.id}/rules`, ruleArg, "name", "authorization server policy rule");
        const rv = await client.json("POST", `/authorizationServers/${server.id}/policies/${policy.id}/rules/${rule.id}/lifecycle/${verb}`);
        return rv ?? `rule ${rule.id} (${rule.name}) ${verb}d`;
      }));
  }

  addOutputOptions(addVerbose(g.command("clients").description("List OAuth 2.0 clients that requested tokens from a custom authorization server").argument("<server>")), CLIENT_FIELDS)
    .action(action(ctx, async (client, _o, serverArg) => {
      const server = await resolveServer(client, serverArg);
      return client.getAll(`/authorizationServers/${server.id}/clients`);
    }));

  addOutputOptions(addVerbose(g.command("tokens").description("List refresh tokens issued to a client by a custom authorization server").argument("<server>").argument("<clientId>")), TOKEN_FIELDS)
    .action(action(ctx, async (client, _o, serverArg, clientId) => {
      const server = await resolveServer(client, serverArg);
      return client.getAll(`/authorizationServers/${server.id}/clients/${clientId}/tokens`);
    }));

  addVerbose(g.command("tokens-revoke").description("Revoke all tokens, or one token, issued to a client by a custom authorization server").argument("<server>").argument("<clientId>").argument("[tokenId]"))
    .action(action(ctx, async (client, _o, serverArg, clientId, tokenId?: string) => {
      const server = await resolveServer(client, serverArg);
      const path = tokenId ? `/authorizationServers/${server.id}/clients/${clientId}/tokens/${tokenId}` : `/authorizationServers/${server.id}/clients/${clientId}/tokens`;
      await client.json("DELETE", path);
      return tokenId
        ? `token ${tokenId} revoked for client ${clientId} on authorization server ${server.id}`
        : `all tokens revoked for client ${clientId} on authorization server ${server.id}`;
    }));

  addOutputOptions(addVerbose(g.command("keys").description("List the JSON Web Keys used to sign tokens for a custom authorization server").argument("<server>")), KEY_FIELDS)
    .action(action(ctx, async (client, _o, serverArg) => {
      const server = await resolveServer(client, serverArg);
      return client.getAll(`/authorizationServers/${server.id}/credentials/keys`);
    }));

  addOutputOptions(addVerbose(g.command("rotate-keys").description("Rotate the signing keys for a custom authorization server").argument("<server>")
    .addOption(new Option("--use <use>", "key use (only `sig` is supported by Okta)").choices(KEY_USE_CHOICES).default("sig"))), KEY_FIELDS)
    .action(action(ctx, async (client, opts, serverArg) => {
      const server = await resolveServer(client, serverArg);
      return client.json("POST", `/authorizationServers/${server.id}/credentials/lifecycle/keyRotate`, { body: { use: opts.use } });
    }));

  addOutputOptions(addVerbose(g.command("key").description("Retrieve a signing key credential for a custom authorization server").argument("<server>").argument("<kid>")), KEY_FIELDS)
    .action(action(ctx, async (client, _o, serverArg, kid) => client.get(`/authorizationServers/${(await resolveServer(client, serverArg)).id}/credentials/keys/${kid}`)));

  addOutputOptions(addVerbose(g.command("associated").description("List authorization servers associated with a custom authorization server").argument("<server>")), AUTH_SERVERS.defaultFields)
    .action(action(ctx, async (client, _o, serverArg) => client.getAll(`/authorizationServers/${(await resolveServer(client, serverArg)).id}/associatedServers`)));

  // Deviation from the plan: AssociatedServerMediated's field is `trusted` (a list of
  // authorization server ids), not `associated`.
  addOutputOptions(addVerbose(g.command("associated-add").description("Associate another authorization server with a custom authorization server").argument("<server>")
    .requiredOption("--server <other>", "id or unique name of the authorization server to associate")), AUTH_SERVERS.defaultFields)
    .action(action(ctx, async (client, opts, serverArg) => {
      const server = await resolveServer(client, serverArg);
      const other = await resolveServer(client, opts.server);
      return client.json("POST", `/authorizationServers/${server.id}/associatedServers`, { body: { trusted: [other.id] } });
    }));

  addVerbose(g.command("associated-delete").description("Remove an associated authorization server").argument("<server>").argument("<associatedId>"))
    .action(action(ctx, async (client, _o, serverArg, associatedId) => {
      const server = await resolveServer(client, serverArg);
      await client.json("DELETE", `/authorizationServers/${server.id}/associatedServers/${associatedId}`);
      return `associated authorization server ${associatedId} removed from authorization server ${server.id}`;
    }));

  addOutputOptions(addVerbose(g.command("resource-keys").description("List the public JSON Web Keys of a custom authorization server")
    .argument("<server>")), RESOURCE_KEY_FIELDS)
    .action(action(ctx, async (client, _o, serverArg) => client.getAll(`/authorizationServers/${(await resolveServer(client, serverArg)).id}/resourceservercredentials/keys`)));

  addOutputOptions(addVerbose(g.command("resource-key").description("Retrieve a public JSON Web Key of a custom authorization server").argument("<server>").argument("<kid>")), RESOURCE_KEY_FIELDS)
    .action(action(ctx, async (client, _o, serverArg, kid) => client.get(`/authorizationServers/${(await resolveServer(client, serverArg)).id}/resourceservercredentials/keys/${kid}`)));

  addOutputOptions(addVerbose(bodyOpts(g.command("resource-key-add").description("Add a public JSON Web Key to a custom authorization server").argument("<server>"))), RESOURCE_KEY_FIELDS)
    .action(action(ctx, async (client, opts, serverArg) => {
      const server = await resolveServer(client, serverArg);
      return client.json("POST", `/authorizationServers/${server.id}/resourceservercredentials/keys`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(g.command("resource-key-delete").description("Delete a public JSON Web Key from a custom authorization server").argument("<server>").argument("<kid>"))
    .action(action(ctx, async (client, _o, serverArg, kid) => {
      const server = await resolveServer(client, serverArg);
      await client.json("DELETE", `/authorizationServers/${server.id}/resourceservercredentials/keys/${kid}`);
      return `resource server key ${kid} deleted from authorization server ${server.id}`;
    }));

  for (const verb of ["activate", "deactivate"] as const) {
    addOutputOptions(addVerbose(g.command(`resource-key-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} a public JSON Web Key of a custom authorization server`).argument("<server>").argument("<kid>")), RESOURCE_KEY_FIELDS)
      .action(action(ctx, async (client, _o, serverArg, kid) => {
        const server = await resolveServer(client, serverArg);
        return client.json("POST", `/authorizationServers/${server.id}/resourceservercredentials/keys/${kid}/lifecycle/${verb}`);
      }));
  }

  return g;
}
