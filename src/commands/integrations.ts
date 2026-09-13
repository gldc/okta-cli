import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, subgroup } from "../cli/options";
import { getUser } from "../lib/lookup";

const PAM_BASE = "/privileged-access/api/v1";
const OIN_BASE = "/integrations/api/v1";
const PERSONAL_SETTINGS_BASE = "/okta-personal-settings/api/v1";
const WEBAUTHN_REG_BASE = "/webauthn-registration/api/v1";

const SERVICE_ACCOUNT_FIELDS = "id,name,ownerGroupIds,status";
// Deviation from the plan: APIServiceIntegrationInstance has no `status` field.
const API_SERVICE_FIELDS = "id,name,type,createdAt";
const API_SERVICE_SECRET_FIELDS = "id,status,created,secret_hash";
const WEBAUTHN_ENROLLMENT_FIELDS = "id,factorType,status,vendorName,created";

// Deviation from the plan: in the pinned spec (2026.08.4) `/privileged-access/api/v1/resources`,
// `/resources/{id}`, `/resources/{id}/claim`, `/resources/{id}/rotate-password` and the three
// `/containers/{containerId}/...` paths are declared (path parameters only) with zero HTTP
// methods - no get/put/post/delete operation, so no documented request/response shape exists.
// Dropped `resources`/`resource-*`/`container-*`; `raw --base-path /privileged-access/api/v1`
// still reaches them.
function registerPam(program: Command, ctx: Ctx): void {
  const pam = subgroup(program, "pam", "Privileged Access Management (service accounts)");

  const sa = subgroup(pam, "service-accounts", "App service accounts");
  addOutputOptions(addVerbose(sa.command("list").description("List all app service accounts")
    .option("--match <expr>", "search by name, username, app instance label, or OIN app key")), SERVICE_ACCOUNT_FIELDS)
    .action(action(ctx, (client, opts) => client.getAll("/service-accounts", { basePath: PAM_BASE, query: { match: opts.match } })));
  addOutputOptions(addVerbose(sa.command("get").description("Retrieve an app service account").argument("<id>")), SERVICE_ACCOUNT_FIELDS)
    .action(action(ctx, (client, _o, id) => client.json("GET", `/service-accounts/${id}`, { basePath: PAM_BASE })));
  addOutputOptions(addVerbose(bodyOpts(sa.command("add").description("Create an app service account"))), SERVICE_ACCOUNT_FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/service-accounts", { basePath: PAM_BASE, body: bodyFromOpts(opts) })));
  addOutputOptions(addVerbose(bodyOpts(sa.command("update").description("Update (PATCH) an app service account").argument("<id>"))), SERVICE_ACCOUNT_FIELDS)
    .action(action(ctx, (client, opts, id) => client.json("PATCH", `/service-accounts/${id}`, { basePath: PAM_BASE, body: bodyFromOpts(opts) })));
  addVerbose(sa.command("delete").description("Delete an app service account").argument("<id>"))
    .action(action(ctx, async (client, _o, id) => {
      await client.json("DELETE", `/service-accounts/${id}`, { basePath: PAM_BASE });
      return `app service account ${id} deleted`;
    }));

  const osa = subgroup(pam, "okta-service-accounts", "Okta managed user accounts (Universal Directory users managed as service accounts)");
  addOutputOptions(addVerbose(osa.command("list").description("List all Okta managed user accounts")
    .option("--match <expr>", "search by account name or username")), SERVICE_ACCOUNT_FIELDS)
    .action(action(ctx, (client, opts) => client.getAll("/okta-service-accounts", { basePath: PAM_BASE, query: { match: opts.match } })));
  addOutputOptions(addVerbose(osa.command("get").description("Retrieve an Okta managed user account").argument("<id>")), SERVICE_ACCOUNT_FIELDS)
    .action(action(ctx, (client, _o, id) => client.json("GET", `/okta-service-accounts/${id}`, { basePath: PAM_BASE })));
  addOutputOptions(addVerbose(bodyOpts(osa.command("add").description("Create an Okta managed user account"))), SERVICE_ACCOUNT_FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/okta-service-accounts", { basePath: PAM_BASE, body: bodyFromOpts(opts) })));
  addVerbose(osa.command("delete").description("Delete an Okta managed user account").argument("<id>"))
    .action(action(ctx, async (client, _o, id) => {
      await client.json("DELETE", `/okta-service-accounts/${id}`, { basePath: PAM_BASE });
      return `Okta managed user account ${id} deleted`;
    }));
}

// Deviation from the plan: every `/integrations/api/v1/submissions...` path (OIN submissions,
// logo upload, capabilities-by-status) is declared in the pinned spec with zero HTTP methods,
// same as the PAM resources/containers paths above. Only `api-services` has real operations.
function registerOin(program: Command, ctx: Ctx): void {
  const oin = subgroup(program, "oin", "OIN API service integration instances");

  addOutputOptions(addVerbose(oin.command("api-services").description("List all API service integration instances")), API_SERVICE_FIELDS)
    .action(action(ctx, (client) => client.getAll("/api-services", { basePath: OIN_BASE })));
  addOutputOptions(addVerbose(oin.command("api-service").description("Retrieve an API service integration instance").argument("<id>")), API_SERVICE_FIELDS)
    .action(action(ctx, (client, _o, id) => client.json("GET", `/api-services/${id}`, { basePath: OIN_BASE })));
  addOutputOptions(addVerbose(oin.command("api-service-secrets").description("List an API service integration instance's client secrets").argument("<id>")), API_SERVICE_SECRET_FIELDS)
    .action(action(ctx, (client, _o, id) => client.getAll(`/api-services/${id}/credentials/secrets`, { basePath: OIN_BASE })));
  addOutputOptions(addVerbose(oin.command("api-service-secret-add").description("Create a new client secret for an API service integration instance").argument("<id>")), API_SERVICE_SECRET_FIELDS)
    .action(action(ctx, (client, _o, id) => client.json("POST", `/api-services/${id}/credentials/secrets`, { basePath: OIN_BASE })));
  for (const verb of ["activate", "deactivate"] as const) {
    addOutputOptions(addVerbose(oin.command(`api-service-secret-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} an API service integration instance client secret`).argument("<id>").argument("<secretId>")), API_SERVICE_SECRET_FIELDS)
      .action(action(ctx, (client, _o, id, secretId) => client.json("POST", `/api-services/${id}/credentials/secrets/${secretId}/lifecycle/${verb}`, { basePath: OIN_BASE })));
  }
  addVerbose(oin.command("api-service-secret-delete").description("Delete an API service integration instance client secret").argument("<id>").argument("<secretId>"))
    .action(action(ctx, async (client, _o, id, secretId) => {
      await client.json("DELETE", `/api-services/${id}/credentials/secrets/${secretId}`, { basePath: OIN_BASE });
      return `client secret ${secretId} deleted from API service integration instance ${id}`;
    }));
}

function registerWellKnown(program: Command, ctx: Ctx): void {
  const wk = subgroup(program, "well-known", "Well-known URIs");
  const entries: [string, string, string][] = [
    ["okta-organization", "/.well-known/okta-organization", "Retrieve the org metadata"],
    ["webauthn", "/.well-known/webauthn", "Retrieve the customized webauthn well-known URI content"],
    ["ssf-configuration", "/.well-known/ssf-configuration", "Retrieve the SSF transmitter metadata"],
    ["app-authenticator-configuration", "/.well-known/app-authenticator-configuration", "Retrieve the well-known app authenticator configuration"],
    ["apple-app-site-association", "/.well-known/apple-app-site-association", "Retrieve the customized apple-app-site-association well-known URI content"],
    ["assetlinks", "/.well-known/assetlinks.json", "Retrieve the customized assetlinks.json well-known URI content"],
  ];
  for (const [name, path, description] of entries) {
    addOutputOptions(addVerbose(wk.command(name).description(description)), null)
      .action(action(ctx, (client) => client.json("GET", path, { basePath: "" })));
  }
}

// Deviation from the plan: `edit-feature` is a PUT (replaceOktaPersonalAdminSettings), not a
// POST. `export-blocklists` has a GET (list) and a PUT (replace) in the spec, not a single POST,
// so it's split into `export-blocklist` / `export-blocklist-set` rather than one command.
function registerPersonalSettings(program: Command, ctx: Ctx): void {
  const ps = subgroup(program, "personal-settings", "Okta Personal admin settings (Workforce orgs)");
  addVerbose(bodyOpts(ps.command("edit-feature").description("Replace the Okta Personal admin settings")))
    .action(action(ctx, async (client, opts) => {
      await client.json("PUT", "/edit-feature", { basePath: PERSONAL_SETTINGS_BASE, body: bodyFromOpts(opts) });
      return "Okta Personal admin settings updated";
    }));
  addOutputOptions(addVerbose(ps.command("export-blocklist").description("List the email domains excluded from app migration")), null)
    .action(action(ctx, (client) => client.json("GET", "/export-blocklists", { basePath: PERSONAL_SETTINGS_BASE })));
  addVerbose(bodyOpts(ps.command("export-blocklist-set").description("Replace the email domains excluded from app migration")))
    .action(action(ctx, async (client, opts) => {
      await client.json("PUT", "/export-blocklists", { basePath: PERSONAL_SETTINGS_BASE, body: bodyFromOpts(opts) });
      return "blocked email domains replaced";
    }));
}

function registerWebauthnRegistration(program: Command, ctx: Ctx, usersCmd: Command): void {
  addOutputOptions(addVerbose(usersCmd.command("webauthn-enrollments").description("List a user's WebAuthn preregistration factors").argument("<user>")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login")), WEBAUTHN_ENROLLMENT_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => client.getAll(`/users/${(await getUser(client, userArg, opts.userLookupField)).id}/enrollments`, { basePath: WEBAUTHN_REG_BASE })));

  // Deviation from the plan: assignFulfillmentErrorWebAuthnPreregistrationFactor takes no
  // request body (requestBody: never), so there's no -b/-s here.
  addVerbose(usersCmd.command("webauthn-enrollment-error").description("Assign the fulfillment error status to a user's WebAuthn preregistration factor").argument("<user>").argument("<enrollmentId>")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login"))
    .action(action(ctx, async (client, opts, userArg, enrollmentId) => {
      const user = await getUser(client, userArg, opts.userLookupField);
      await client.json("POST", `/users/${user.id}/enrollments/${enrollmentId}/mark-error`, { basePath: WEBAUTHN_REG_BASE });
      return `WebAuthn preregistration factor ${enrollmentId} marked as errored for user ${user.id}`;
    }));

  const wp = subgroup(program, "webauthn-preregistration", "WebAuthn preregistration (fulfillment provider) enrollment flow");
  addOutputOptions(addVerbose(bodyOpts(wp.command("enroll").description("Enroll a preregistered WebAuthn factor"))), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/enroll", { basePath: WEBAUTHN_REG_BASE, body: bodyFromOpts(opts) })));
  addOutputOptions(addVerbose(bodyOpts(wp.command("activate").description("Activate a preregistered WebAuthn factor"))), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/activate", { basePath: WEBAUTHN_REG_BASE, body: bodyFromOpts(opts) })));
  addVerbose(bodyOpts(wp.command("initiate").description("Generate a WebAuthn preregistration fulfillment request")))
    .action(action(ctx, async (client, opts) => {
      await client.json("POST", "/initiate-fulfillment-request", { basePath: WEBAUTHN_REG_BASE, body: bodyFromOpts(opts) });
      return "WebAuthn preregistration fulfillment request generated";
    }));
  addVerbose(bodyOpts(wp.command("send-pin").description("Send the PIN for a WebAuthn preregistration enrollment to the user")))
    .action(action(ctx, async (client, opts) => {
      await client.json("POST", "/send-pin", { basePath: WEBAUTHN_REG_BASE, body: bodyFromOpts(opts) });
      return "PIN sent";
    }));
}

export function registerIntegrations(program: Command, ctx: Ctx, usersCmd: Command): void {
  registerPam(program, ctx);
  registerOin(program, ctx);
  registerWellKnown(program, ctx);
  registerPersonalSettings(program, ctx);
  registerWebauthnRegistration(program, ctx, usersCmd);
}
