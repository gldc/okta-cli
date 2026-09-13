import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, subgroup } from "../cli/options";
import { getUser } from "../lib/lookup";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

const METHOD_FIELDS = "type,status";
const SESSION_FIELDS = "id,userId,login,status,createdAt,expiresAt";
const AAGUID_FIELDS = "aaguid,name";

export const AUTHENTICATORS: ResourceSpec = { name: "authenticators", description: "Authenticators (MFA)", path: "/authenticators", singular: "authenticator", nameField: "name", defaultFields: "id,status,type,key,name", lifecycle: true, deletable: false, creatable: false };

export function registerAuthenticators(program: Command, ctx: Ctx): Command {
  const a = defineResource(program, ctx, AUTHENTICATORS);

  addOutputOptions(addVerbose(a.command("methods").description("List an authenticator's methods").argument("<name-or-id>")), METHOD_FIELDS)
    .action(action(ctx, async (client, _o, nameOrId) => client.getAll(`/authenticators/${(await resourceGet(client, AUTHENTICATORS, nameOrId)).id}/methods`)));

  for (const verb of ["activate", "deactivate"] as const) {
    addOutputOptions(addVerbose(a.command(`method-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} an authenticator method`).argument("<authenticator>").argument("<methodType>")), METHOD_FIELDS)
      .action(action(ctx, async (client, _o, authArg, methodType) => {
        const authenticator = await resourceGet(client, AUTHENTICATORS, authArg);
        return client.json("POST", `/authenticators/${authenticator.id}/methods/${methodType}/lifecycle/${verb}`);
      }));
  }

  addOutputOptions(addVerbose(a.command("method").description("Retrieve an authenticator method").argument("<authenticator>").argument("<methodType>")), METHOD_FIELDS)
    .action(action(ctx, async (client, _o, authArg, methodType) => client.get(`/authenticators/${(await resourceGet(client, AUTHENTICATORS, authArg)).id}/methods/${methodType}`)));

  addOutputOptions(addVerbose(bodyOpts(a.command("method-set").description("Replace an authenticator method").argument("<authenticator>").argument("<methodType>"))), METHOD_FIELDS)
    .action(action(ctx, async (client, opts, authArg, methodType) => {
      const authenticator = await resourceGet(client, AUTHENTICATORS, authArg);
      return client.json("PUT", `/authenticators/${authenticator.id}/methods/${methodType}`, { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(a.command("aaguids").description("List an authenticator's custom AAGUIDs").argument("<authenticator>")), AAGUID_FIELDS)
    .action(action(ctx, async (client, _o, authArg) => client.getAll(`/authenticators/${(await resourceGet(client, AUTHENTICATORS, authArg)).id}/aaguids`)));

  addOutputOptions(addVerbose(a.command("aaguid").description("Retrieve a custom AAGUID").argument("<authenticator>").argument("<aaguid>")), AAGUID_FIELDS)
    .action(action(ctx, async (client, _o, authArg, aaguid) => client.get(`/authenticators/${(await resourceGet(client, AUTHENTICATORS, authArg)).id}/aaguids/${aaguid}`)));

  addOutputOptions(addVerbose(bodyOpts(a.command("aaguid-add").description("Create a custom AAGUID").argument("<authenticator>"))), AAGUID_FIELDS)
    .action(action(ctx, async (client, opts, authArg) => {
      const authenticator = await resourceGet(client, AUTHENTICATORS, authArg);
      return client.json("POST", `/authenticators/${authenticator.id}/aaguids`, { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(bodyOpts(a.command("aaguid-replace").description("Replace a custom AAGUID").argument("<authenticator>").argument("<aaguid>"))), AAGUID_FIELDS)
    .action(action(ctx, async (client, opts, authArg, aaguid) => {
      const authenticator = await resourceGet(client, AUTHENTICATORS, authArg);
      return client.json("PUT", `/authenticators/${authenticator.id}/aaguids/${aaguid}`, { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(bodyOpts(a.command("aaguid-update").description("Update a custom AAGUID").argument("<authenticator>").argument("<aaguid>"))), AAGUID_FIELDS)
    .action(action(ctx, async (client, opts, authArg, aaguid) => {
      const authenticator = await resourceGet(client, AUTHENTICATORS, authArg);
      return client.json("PATCH", `/authenticators/${authenticator.id}/aaguids/${aaguid}`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(a.command("aaguid-delete").description("Delete a custom AAGUID").argument("<authenticator>").argument("<aaguid>"))
    .action(action(ctx, async (client, _o, authArg, aaguid) => {
      const authenticator = await resourceGet(client, AUTHENTICATORS, authArg);
      await client.json("DELETE", `/authenticators/${authenticator.id}/aaguids/${aaguid}`);
      return `AAGUID ${aaguid} deleted from authenticator ${authenticator.id} (${authenticator.name})`;
    }));

  // Deviation from the plan: verifyRpIdDomain takes no request body in the spec
  // (`requestBody?: never`) and returns 204, so there's no -b/-s and no printed object.
  addVerbose(a.command("verify-rp-id").description("Verify the Relying Party ID domain for a Passkey (FIDO2 WebAuthn) authenticator method").argument("<authenticator>")
    .addOption(new Option("--method <type>", "authenticator method type").choices(["webauthn"]).default("webauthn")))
    .action(action(ctx, async (client, opts, authArg) => {
      const authenticator = await resourceGet(client, AUTHENTICATORS, authArg);
      await client.json("POST", `/authenticators/${authenticator.id}/methods/${opts.method}/verify-rp-id-domain`);
      return `rp id domain verified for authenticator ${authenticator.id} (${authenticator.name}) method ${opts.method}`;
    }));

  const sessions = subgroup(program, "sessions", "User sessions");
  addOutputOptions(addVerbose(sessions.command("get").description("Get a session").argument("<sessionId>")), SESSION_FIELDS)
    .action(action(ctx, (client, _o, sessionId) => client.get(`/sessions/${sessionId}`)));
  addOutputOptions(addVerbose(sessions.command("refresh").description("Refresh a session").argument("<sessionId>")), SESSION_FIELDS)
    .action(action(ctx, (client, _o, sessionId) => client.json("POST", `/sessions/${sessionId}/lifecycle/refresh`)));
  addVerbose(sessions.command("revoke").description("Revoke a session").argument("<sessionId>"))
    .action(action(ctx, async (client, _o, sessionId) => {
      await client.json("DELETE", `/sessions/${sessionId}`);
      return `session ${sessionId} revoked`;
    }));

  return a;
}

export function registerUserSecurity(usersCmd: Command, ctx: Ctx): void {
  addOutputOptions(addVerbose(usersCmd.command("factors").description("List a user's enrolled factors").argument("<user>")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login")), "id,factorType,provider,status,created")
    .action(action(ctx, async (client, opts, userArg) => client.getAll(`/users/${(await getUser(client, userArg, opts.userLookupField)).id}/factors`)));

  addOutputOptions(addVerbose(usersCmd.command("factors-catalog").description("List factors available to enroll for a user").argument("<user>")), "factorType,provider,status,enrollment")
    .action(action(ctx, async (client, _o, userArg) => client.getAll(`/users/${(await getUser(client, userArg)).id}/factors/catalog`)));

  addVerbose(usersCmd.command("factor-delete").description("Remove a factor from a user").argument("<user>").argument("<factorId>")
    .option("--remove-recovery-enrollment", "also remove the recovery enrollment"))
    .action(action(ctx, async (client, opts, userArg, factorId) => {
      const user = await getUser(client, userArg);
      await client.json("DELETE", `/users/${user.id}/factors/${factorId}`, { query: opts.removeRecoveryEnrollment ? { removeRecoveryEnrollment: true } : {} });
      return `factor ${factorId} removed from user ${user.id} (${user.profile.login})`;
    }));

  addVerbose(usersCmd.command("factors-reset").description("Reset all factors for a user").argument("<user>"))
    .action(action(ctx, async (client, _o, userArg) => {
      const user = await getUser(client, userArg);
      await client.json("POST", `/users/${user.id}/lifecycle/reset_factors`);
      return `all factors reset for user ${user.id} (${user.profile.login})`;
    }));

  addVerbose(usersCmd.command("unsuspend").description("Unsuspend a user").argument("<login_or_id>"))
    .action(action(ctx, (client, _o, id) => client.json("POST", `/users/${id}/lifecycle/unsuspend`)));

  addOutputOptions(addVerbose(usersCmd.command("blocks").description("List a user's blocks").argument("<user>")), "type,appliesTo")
    .action(action(ctx, async (client, _o, userArg) => client.getAll(`/users/${(await getUser(client, userArg)).id}/blocks`)));

  addVerbose(usersCmd.command("sessions-revoke").description("Revoke all sessions for a user").argument("<user>")
    .option("--oauth-tokens", "also revoke OAuth tokens")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login"))
    .action(action(ctx, async (client, opts, userArg) => {
      const user = await getUser(client, userArg, opts.userLookupField);
      await client.json("DELETE", `/users/${user.id}/sessions`, { query: opts.oauthTokens ? { oauthTokens: true } : {} });
      return `sessions revoked for user ${user.id} (${user.profile.login})`;
    }));

  addOutputOptions(addVerbose(usersCmd.command("idps").description("List a user's linked identity providers").argument("<user>")), "id,type,status,name")
    .action(action(ctx, async (client, _o, userArg) => client.getAll(`/users/${(await getUser(client, userArg)).id}/idps`)));
}
