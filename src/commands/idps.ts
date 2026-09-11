import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose } from "../cli/options";
import { getUser } from "../lib/lookup";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

const USER_LINK_FIELDS = "id,externalId,created,lastUpdated";

export const IDPS: ResourceSpec = {
  name: "idps", description: "Identity providers", path: "/idps", singular: "identity provider", nameField: "name", defaultFields: "id,status,type,name", lifecycle: true,
  listOptions: [{ flags: "-t, --type <type>", param: "type", description: "IdP type (SAML2, OIDC, GOOGLE, ...)" }],
};

export function registerIdps(program: Command, ctx: Ctx): Command {
  const g = defineResource(program, ctx, IDPS);

  addOutputOptions(addVerbose(g.command("users").description("List users linked to an identity provider").argument("<idp>")), USER_LINK_FIELDS)
    .action(action(ctx, async (client, _o, idpArg) => client.getAll(`/idps/${(await resourceGet(client, IDPS, idpArg)).id}/users`)));

  addOutputOptions(addVerbose(g.command("link").description("Link a user to an identity provider").argument("<idp>")
    .requiredOption("-u, --user <user>", "the user to link").requiredOption("-e, --external-id <id>", "the external id at the IdP")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login")), USER_LINK_FIELDS)
    .action(action(ctx, async (client, opts, idpArg) => {
      const idp = await resourceGet(client, IDPS, idpArg);
      const user = await getUser(client, opts.user, opts.userLookupField);
      return client.json("POST", `/idps/${idp.id}/users/${user.id}`, { body: { externalId: opts.externalId } });
    }));

  addVerbose(g.command("unlink").description("Remove a user's link to an identity provider").argument("<idp>")
    .requiredOption("-u, --user <user>", "the user to unlink").option("-f, --user-lookup-field <field>", "profile field to match", "login"))
    .action(action(ctx, async (client, opts, idpArg) => {
      const idp = await resourceGet(client, IDPS, idpArg);
      const user = await getUser(client, opts.user, opts.userLookupField);
      await client.json("DELETE", `/idps/${idp.id}/users/${user.id}`);
      return `user ${user.id} (${user.profile.login}) unlinked from idp ${idp.id} (${idp.name})`;
    }));

  addOutputOptions(addVerbose(g.command("keys").description("List identity provider signing/encryption keys")), "kid,kty,use,created,expiresAt")
    .action(action(ctx, (client) => client.getAll("/idps/credentials/keys")));

  return g;
}
