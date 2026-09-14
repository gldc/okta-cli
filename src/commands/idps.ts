import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, int } from "../cli/options";
import { getUser } from "../lib/lookup";
import { defineResource, publishCsr, resourceGet, type ResourceSpec } from "./resource";

const USER_LINK_FIELDS = "id,externalId,created,lastUpdated";
const IDP_KEY_FIELDS = "kid,kty,use,created,expiresAt";
const CSR_FIELDS = "id,created,kty";

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

  addOutputOptions(addVerbose(g.command("keys").description("List identity provider signing/encryption keys")), IDP_KEY_FIELDS)
    .action(action(ctx, (client) => client.getAll("/idps/credentials/keys")));

  addOutputOptions(addVerbose(g.command("key").description("Retrieve an IdP key credential").argument("<kid>")), IDP_KEY_FIELDS)
    .action(action(ctx, (client, _o, kid) => client.get(`/idps/credentials/keys/${kid}`)));

  addOutputOptions(addVerbose(bodyOpts(g.command("key-add").description("Create an IdP key credential"))), IDP_KEY_FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/idps/credentials/keys", { body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(bodyOpts(g.command("key-replace").description("Replace an IdP key credential").argument("<kid>"))), IDP_KEY_FIELDS)
    .action(action(ctx, (client, opts, kid) => client.json("PUT", `/idps/credentials/keys/${kid}`, { body: bodyFromOpts(opts) })));

  addVerbose(g.command("key-delete").description("Delete an IdP key credential").argument("<kid>"))
    .action(action(ctx, async (client, _o, kid) => {
      await client.json("DELETE", `/idps/credentials/keys/${kid}`);
      return `key ${kid} deleted`;
    }));

  addOutputOptions(addVerbose(g.command("signing-keys").description("List an IdP's signing key credentials").argument("<idp>")), IDP_KEY_FIELDS)
    .action(action(ctx, async (client, _o, idpArg) => client.getAll(`/idps/${(await resourceGet(client, IDPS, idpArg)).id}/credentials/keys`)));

  addOutputOptions(addVerbose(g.command("signing-key").description("Retrieve an IdP signing key credential").argument("<idp>").argument("<kid>")), IDP_KEY_FIELDS)
    .action(action(ctx, async (client, _o, idpArg, kid) => client.get(`/idps/${(await resourceGet(client, IDPS, idpArg)).id}/credentials/keys/${kid}`)));

  addOutputOptions(addVerbose(g.command("signing-key-active").description("List the active signing key credential for an IdP").argument("<idp>")), IDP_KEY_FIELDS)
    .action(action(ctx, async (client, _o, idpArg) => client.getAll(`/idps/${(await resourceGet(client, IDPS, idpArg)).id}/credentials/keys/active`)));

  // Deviation from the plan: generateIdentityProviderSigningKey's `validityYears` is a
  // required query parameter in the spec, not an optional one.
  addOutputOptions(addVerbose(g.command("signing-key-generate").description("Generate a new signing key credential for an IdP").argument("<idp>")
    .requiredOption("--validity-years <n>", "key validity in years", int)), IDP_KEY_FIELDS)
    .action(action(ctx, async (client, opts, idpArg) => {
      const idp = await resourceGet(client, IDPS, idpArg);
      return client.json("POST", `/idps/${idp.id}/credentials/keys/generate`, { query: { validityYears: opts.validityYears } });
    }));

  addOutputOptions(addVerbose(g.command("signing-key-clone").description("Clone a signing key credential from one IdP to another").argument("<idp>").argument("<kid>")
    .requiredOption("--target-idp <idp>", "id or unique name of the IdP to clone the key credential to")), IDP_KEY_FIELDS)
    .action(action(ctx, async (client, opts, idpArg, kid) => {
      const idp = await resourceGet(client, IDPS, idpArg);
      const target = await resourceGet(client, IDPS, opts.targetIdp);
      return client.json("POST", `/idps/${idp.id}/credentials/keys/${kid}/clone`, { query: { targetIdpId: target.id } });
    }));

  addOutputOptions(addVerbose(g.command("csrs").description("List certificate signing requests for an IdP").argument("<idp>")), CSR_FIELDS)
    .action(action(ctx, async (client, _o, idpArg) => client.getAll(`/idps/${(await resourceGet(client, IDPS, idpArg)).id}/credentials/csrs`)));

  addOutputOptions(addVerbose(g.command("csr").description("Retrieve a certificate signing request").argument("<idp>").argument("<id>")), CSR_FIELDS)
    .action(action(ctx, async (client, _o, idpArg, id) => client.get(`/idps/${(await resourceGet(client, IDPS, idpArg)).id}/credentials/csrs/${id}`)));

  addOutputOptions(addVerbose(bodyOpts(g.command("csr-add").description("Generate a certificate signing request for an IdP").argument("<idp>"))), CSR_FIELDS)
    .action(action(ctx, async (client, opts, idpArg) => {
      const idp = await resourceGet(client, IDPS, idpArg);
      return client.json("POST", `/idps/${idp.id}/credentials/csrs`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(g.command("csr-delete").description("Revoke a certificate signing request").argument("<idp>").argument("<id>"))
    .action(action(ctx, async (client, _o, idpArg, id) => {
      const idp = await resourceGet(client, IDPS, idpArg);
      await client.json("DELETE", `/idps/${idp.id}/credentials/csrs/${id}`);
      return `csr ${id} revoked from idp ${idp.id} (${idp.name})`;
    }));

  addOutputOptions(addVerbose(g.command("csr-publish").description("Publish a CSR with a CA-signed certificate, completing its lifecycle").argument("<idp>").argument("<id>")
    .requiredOption("--file <path>", "path to the signed certificate file")
    .addOption(new Option("--format <fmt>", "certificate file encoding").choices(["pem", "der", "cer"]).default("pem"))), IDP_KEY_FIELDS)
    .action(action(ctx, async (client, opts, idpArg, id) => {
      const idp = await resourceGet(client, IDPS, idpArg);
      return publishCsr(client, `/idps/${idp.id}/credentials/csrs/${id}/lifecycle/publish`, opts.file, opts.format);
    }));

  return g;
}
