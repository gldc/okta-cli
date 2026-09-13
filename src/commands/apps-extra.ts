import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts } from "../cli/options";
import { parseBody } from "../lib/body";
import { getApp } from "../lib/lookup";
import type { OktaClient } from "../okta/client";
import { resourceGet } from "./resource";
import { FEATURE_FIELDS, KEY_FIELDS } from "./apps";
import { POLICIES } from "./policies";

// Deviation from the plan: OAuth2ClientJsonWebKey{Signing,Encryption}Response has no `alg` or
// `use` field (those are on the *Request* schema only) - the response is kid/status/kty(+e/n or x/y).
const JWK_FIELDS = "kid,status,kty,created";
const SECRET_FIELDS = "id,status,created,lastUpdated,secret_hash";
const CSR_FIELDS = "id,created,kty";
const CLAIM_FIELDS = "id,name,expression";
// Deviation from the plan: GroupPushMapping's id field is `id`, not `mappingId` (mappingId is
// only the path parameter name).
const MAPPING_FIELDS = "id,status,sourceGroupId,targetGroupId,lastPush";
const CWO_FIELDS = "id,status,requestingAppInstanceId,resourceAppInstanceId,created";
const INTERCLIENT_FIELDS = "id,appInstanceId,trustedAppInstanceId,created";
const ALLOWED_APP_ID_FIELDS = "appId";

// Maps --format to the Content-Type the spec's publishCsrFromApplication accepts for each
// certificate encoding (confirmed against Okta's developer docs for this operation).
const CSR_PUBLISH_CONTENT_TYPES: Record<string, string> = {
  pem: "application/x-pem-file",
  der: "application/pkix-cert",
  cer: "application/x-x509-ca-cert",
};

export function registerAppsExtra(appsCmd: Command, ctx: Ctx): void {
  const resolveApp = (client: OktaClient, appArg: string) => getApp(client, appArg);

  // Credentials: OAuth 2.0 client JSON Web Keys
  const jwksPath = (appId: string) => `/apps/${appId}/credentials/jwks`;

  addOutputOptions(addVerbose(appsCmd.command("jwks").description("List an OAuth 2.0 client's JSON Web Keys").argument("<app>")), JWK_FIELDS)
    .action(action(ctx, async (client, _o, appArg) => client.getAll(jwksPath((await resolveApp(client, appArg)).id))));

  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("jwks-add").description("Add a JSON Web Key to an OAuth 2.0 client").argument("<app>"))), JWK_FIELDS)
    .action(action(ctx, async (client, opts, appArg) => {
      const app = await resolveApp(client, appArg);
      return client.json("POST", jwksPath(app.id), { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(appsCmd.command("jwks-get").description("Retrieve one OAuth 2.0 client JSON Web Key").argument("<app>").argument("<kid>")), JWK_FIELDS)
    .action(action(ctx, async (client, _o, appArg, kid) => client.get(`${jwksPath((await resolveApp(client, appArg)).id)}/${kid}`)));

  addVerbose(appsCmd.command("jwks-delete").description("Delete an OAuth 2.0 client JSON Web Key").argument("<app>").argument("<kid>"))
    .action(action(ctx, async (client, _o, appArg, kid) => {
      const app = await resolveApp(client, appArg);
      await client.json("DELETE", `${jwksPath(app.id)}/${kid}`);
      return `key ${kid} deleted from app ${app.id} (${app.label})`;
    }));

  for (const verb of ["activate", "deactivate"] as const) {
    addOutputOptions(addVerbose(appsCmd.command(`jwks-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} an OAuth 2.0 client JSON Web Key`).argument("<app>").argument("<kid>")), JWK_FIELDS)
      .action(action(ctx, async (client, _o, appArg, kid) => {
        const app = await resolveApp(client, appArg);
        return client.json("POST", `${jwksPath(app.id)}/${kid}/lifecycle/${verb}`);
      }));
  }

  // Credentials: OAuth 2.0 client secrets
  const secretsPath = (appId: string) => `/apps/${appId}/credentials/secrets`;

  addOutputOptions(addVerbose(appsCmd.command("secrets").description("List an OAuth 2.0 client's secrets").argument("<app>")), SECRET_FIELDS)
    .action(action(ctx, async (client, _o, appArg) => client.getAll(secretsPath((await resolveApp(client, appArg)).id))));

  // Default output is raw JSON (not SECRET_FIELDS): the response is the only place the
  // plaintext client_secret is ever returned.
  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("secret-add").description("Create an OAuth 2.0 client secret (optionally bring your own via -b/-s)").argument("<app>"))), null)
    .action(action(ctx, async (client, opts, appArg) => {
      const app = await resolveApp(client, appArg);
      const body = parseBody(opts.body, opts.set);
      return client.json("POST", secretsPath(app.id), body !== undefined ? { body } : {});
    }));

  addOutputOptions(addVerbose(appsCmd.command("secret-get").description("Retrieve an OAuth 2.0 client secret").argument("<app>").argument("<id>")), SECRET_FIELDS)
    .action(action(ctx, async (client, _o, appArg, id) => client.get(`${secretsPath((await resolveApp(client, appArg)).id)}/${id}`)));

  addVerbose(appsCmd.command("secret-delete").description("Delete an OAuth 2.0 client secret").argument("<app>").argument("<id>"))
    .action(action(ctx, async (client, _o, appArg, id) => {
      const app = await resolveApp(client, appArg);
      await client.json("DELETE", `${secretsPath(app.id)}/${id}`);
      return `secret ${id} deleted from app ${app.id} (${app.label})`;
    }));

  for (const verb of ["activate", "deactivate"] as const) {
    addOutputOptions(addVerbose(appsCmd.command(`secret-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} an OAuth 2.0 client secret`).argument("<app>").argument("<id>")), SECRET_FIELDS)
      .action(action(ctx, async (client, _o, appArg, id) => {
        const app = await resolveApp(client, appArg);
        return client.json("POST", `${secretsPath(app.id)}/${id}/lifecycle/${verb}`);
      }));
  }

  // Credentials: certificate signing requests
  const csrsPath = (appId: string) => `/apps/${appId}/credentials/csrs`;

  addOutputOptions(addVerbose(appsCmd.command("csrs").description("List certificate signing requests for an app").argument("<app>")), CSR_FIELDS)
    .action(action(ctx, async (client, _o, appArg) => client.getAll(csrsPath((await resolveApp(client, appArg)).id))));

  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("csr-add").description("Generate a certificate signing request").argument("<app>"))), CSR_FIELDS)
    .action(action(ctx, async (client, opts, appArg) => {
      const app = await resolveApp(client, appArg);
      return client.json("POST", csrsPath(app.id), { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(appsCmd.command("csr-get").description("Retrieve a certificate signing request").argument("<app>").argument("<id>")), CSR_FIELDS)
    .action(action(ctx, async (client, _o, appArg, id) => client.get(`${csrsPath((await resolveApp(client, appArg)).id)}/${id}`)));

  addVerbose(appsCmd.command("csr-delete").description("Revoke a certificate signing request").argument("<app>").argument("<id>"))
    .action(action(ctx, async (client, _o, appArg, id) => {
      const app = await resolveApp(client, appArg);
      await client.json("DELETE", `${csrsPath(app.id)}/${id}`);
      return `csr ${id} revoked from app ${app.id} (${app.label})`;
    }));

  addOutputOptions(addVerbose(appsCmd.command("csr-publish").description("Publish a CSR with a CA-signed certificate, completing its lifecycle").argument("<app>").argument("<id>")
    .requiredOption("--file <path>", "path to the signed certificate file")
    .addOption(new Option("--format <fmt>", "certificate file encoding").choices(["pem", "der", "cer"]).default("pem"))), KEY_FIELDS)
    .action(action(ctx, async (client, opts, appArg, id) => {
      const app = await resolveApp(client, appArg);
      const bytes = new Uint8Array(await Bun.file(opts.file).arrayBuffer());
      const rsp = await client.request("POST", `${csrsPath(app.id)}/${id}/lifecycle/publish`, { body: bytes, headers: { "Content-Type": CSR_PUBLISH_CONTENT_TYPES[opts.format as string]! } });
      const text = await rsp.text();
      return text.length === 0 ? undefined : JSON.parse(text);
    }));

  // Credentials: key credentials (list/generate already exist on apps.ts)
  addOutputOptions(addVerbose(appsCmd.command("key").description("Retrieve a specific application key credential").argument("<app>").argument("<kid>")), KEY_FIELDS)
    .action(action(ctx, async (client, _o, appArg, kid) => client.get(`/apps/${(await resolveApp(client, appArg)).id}/credentials/keys/${kid}`)));

  addOutputOptions(addVerbose(appsCmd.command("key-clone").description("Clone a key credential from one app to another").argument("<app>").argument("<kid>")
    .requiredOption("--target-app <app>", "label or id of the app to clone the key credential to")), KEY_FIELDS)
    .action(action(ctx, async (client, opts, appArg, kid) => {
      const app = await resolveApp(client, appArg);
      const target = await resolveApp(client, opts.targetApp);
      return client.json("POST", `/apps/${app.id}/credentials/keys/${kid}/clone`, { query: { targetAid: target.id } });
    }));

  // Federated claims
  const claimsPath = (appId: string) => `/apps/${appId}/federated-claims`;

  addOutputOptions(addVerbose(appsCmd.command("federated-claims").description("List an app's federated claims").argument("<app>")), CLAIM_FIELDS)
    .action(action(ctx, async (client, _o, appArg) => client.getAll(claimsPath((await resolveApp(client, appArg)).id))));

  addOutputOptions(addVerbose(appsCmd.command("federated-claim").description("Retrieve a federated claim").argument("<app>").argument("<id>")), CLAIM_FIELDS)
    .action(action(ctx, async (client, _o, appArg, id) => client.get(`${claimsPath((await resolveApp(client, appArg)).id)}/${id}`)));

  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("federated-claim-add").description("Create a federated claim").argument("<app>"))), CLAIM_FIELDS)
    .action(action(ctx, async (client, opts, appArg) => {
      const app = await resolveApp(client, appArg);
      return client.json("POST", claimsPath(app.id), { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("federated-claim-replace").description("Replace a federated claim").argument("<app>").argument("<id>"))), CLAIM_FIELDS)
    .action(action(ctx, async (client, opts, appArg, id) => {
      const app = await resolveApp(client, appArg);
      return client.json("PUT", `${claimsPath(app.id)}/${id}`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(appsCmd.command("federated-claim-delete").description("Delete a federated claim").argument("<app>").argument("<id>"))
    .action(action(ctx, async (client, _o, appArg, id) => {
      const app = await resolveApp(client, appArg);
      await client.json("DELETE", `${claimsPath(app.id)}/${id}`);
      return `federated claim ${id} deleted from app ${app.id} (${app.label})`;
    }));

  // Group push mappings
  const mappingsPath = (appId: string) => `/apps/${appId}/group-push/mappings`;

  addOutputOptions(addVerbose(appsCmd.command("group-push-mappings").description("List an app's group push mappings").argument("<app>")), MAPPING_FIELDS)
    .action(action(ctx, async (client, _o, appArg) => client.getAll(mappingsPath((await resolveApp(client, appArg)).id))));

  addOutputOptions(addVerbose(appsCmd.command("group-push-mapping").description("Retrieve a group push mapping").argument("<app>").argument("<id>")), MAPPING_FIELDS)
    .action(action(ctx, async (client, _o, appArg, id) => client.get(`${mappingsPath((await resolveApp(client, appArg)).id)}/${id}`)));

  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("group-push-mapping-add").description("Create (or link) a group push mapping").argument("<app>"))), MAPPING_FIELDS)
    .action(action(ctx, async (client, opts, appArg) => {
      const app = await resolveApp(client, appArg);
      return client.json("POST", mappingsPath(app.id), { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("group-push-mapping-update").description("Update a group push mapping's status").argument("<app>").argument("<id>"))), MAPPING_FIELDS)
    .action(action(ctx, async (client, opts, appArg, id) => {
      const app = await resolveApp(client, appArg);
      return client.json("PATCH", `${mappingsPath(app.id)}/${id}`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(appsCmd.command("group-push-mapping-delete").description("Delete a group push mapping (must be INACTIVE)").argument("<app>").argument("<id>")
    .option("--delete-target-group", "also delete the target group"))
    .action(action(ctx, async (client, opts, appArg, id) => {
      const app = await resolveApp(client, appArg);
      await client.json("DELETE", `${mappingsPath(app.id)}/${id}`, { query: { deleteTargetGroup: !!opts.deleteTargetGroup } });
      return `group push mapping ${id} deleted from app ${app.id} (${app.label})`;
    }));

  // Default provisioning connection
  const connPath = (appId: string) => `/apps/${appId}/connections/default`;

  addOutputOptions(addVerbose(appsCmd.command("connection").description("Retrieve an app's default provisioning connection").argument("<app>")), null)
    .action(action(ctx, async (client, _o, appArg) => client.get(connPath((await resolveApp(client, appArg)).id))));

  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("connection-set").description("Update an app's default provisioning connection").argument("<app>"))), null)
    .action(action(ctx, async (client, opts, appArg) => {
      const app = await resolveApp(client, appArg);
      return client.json("POST", connPath(app.id), { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(appsCmd.command("connection-jwks").description("Retrieve the JWKS for an app's default provisioning connection").argument("<app>")), null)
    .action(action(ctx, async (client, _o, appArg) => client.get(`${connPath((await resolveApp(client, appArg)).id)}/jwks`)));

  for (const verb of ["activate", "deactivate"] as const) {
    addVerbose(appsCmd.command(`connection-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} an app's default provisioning connection`).argument("<app>"))
      .action(action(ctx, async (client, _o, appArg) => {
        const app = await resolveApp(client, appArg);
        await client.json("POST", `${connPath(app.id)}/lifecycle/${verb}`);
        return `provisioning connection ${verb}d for app ${app.id} (${app.label})`;
      }));
  }

  // Cross App Access (CWO) connections
  const cwoPath = (appId: string) => `/apps/${appId}/cwo/connections`;

  addOutputOptions(addVerbose(appsCmd.command("cwo-connections").description("List an app's Cross App Access connections").argument("<app>")), CWO_FIELDS)
    .action(action(ctx, async (client, _o, appArg) => client.getAll(cwoPath((await resolveApp(client, appArg)).id))));

  addOutputOptions(addVerbose(appsCmd.command("cwo-connection").description("Retrieve a Cross App Access connection").argument("<app>").argument("<id>")), CWO_FIELDS)
    .action(action(ctx, async (client, _o, appArg, id) => client.get(`${cwoPath((await resolveApp(client, appArg)).id)}/${id}`)));

  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("cwo-connection-add").description("Create a Cross App Access connection").argument("<app>"))), CWO_FIELDS)
    .action(action(ctx, async (client, opts, appArg) => {
      const app = await resolveApp(client, appArg);
      return client.json("POST", cwoPath(app.id), { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("cwo-connection-update").description("Update a Cross App Access connection's status").argument("<app>").argument("<id>"))), CWO_FIELDS)
    .action(action(ctx, async (client, opts, appArg, id) => {
      const app = await resolveApp(client, appArg);
      return client.json("PATCH", `${cwoPath(app.id)}/${id}`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(appsCmd.command("cwo-connection-delete").description("Delete a Cross App Access connection").argument("<app>").argument("<id>"))
    .action(action(ctx, async (client, _o, appArg, id) => {
      const app = await resolveApp(client, appArg);
      await client.json("DELETE", `${cwoPath(app.id)}/${id}`);
      return `Cross App Access connection ${id} deleted from app ${app.id} (${app.label})`;
    }));

  // Interclient (interclient SSO token) trust
  addOutputOptions(addVerbose(appsCmd.command("interclient-allowed").description("List the apps this app allows to request interclient SSO").argument("<app>")), ALLOWED_APP_ID_FIELDS)
    .action(action(ctx, async (client, _o, appArg) => {
      const ids: string[] = await client.get(`/apps/${(await resolveApp(client, appArg)).id}/interclient-allowed-apps`);
      return ids.map((appId) => ({ appId }));
    }));

  addOutputOptions(addVerbose(appsCmd.command("interclient-allow").description("Allow another app to request interclient SSO against this app").argument("<app>")
    .requiredOption("--target-app <app>", "label or id of the app to allow")), INTERCLIENT_FIELDS)
    .action(action(ctx, async (client, opts, appArg) => {
      const app = await resolveApp(client, appArg);
      const target = await resolveApp(client, opts.targetApp);
      return client.json("POST", `/apps/${app.id}/interclient-allowed-apps`, { body: { id: target.id } });
    }));

  addVerbose(appsCmd.command("interclient-disallow").description("Remove an allowed app's interclient SSO mapping").argument("<app>").argument("<allowedAppId>"))
    .action(action(ctx, async (client, _o, appArg, allowedAppId) => {
      const app = await resolveApp(client, appArg);
      await client.json("DELETE", `/apps/${app.id}/interclient-allowed-apps/${allowedAppId}`);
      return `interclient mapping to ${allowedAppId} removed from app ${app.id} (${app.label})`;
    }));

  addOutputOptions(addVerbose(appsCmd.command("interclient-targets").description("List the apps that allow this app to request interclient SSO").argument("<app>")), ALLOWED_APP_ID_FIELDS)
    .action(action(ctx, async (client, _o, appArg) => {
      const ids: string[] = await client.get(`/apps/${(await resolveApp(client, appArg)).id}/interclient-target-apps`);
      return ids.map((appId) => ({ appId }));
    }));

  // Logo
  addVerbose(appsCmd.command("logo").description("Upload an app's logo").argument("<app>").requiredOption("--file <path>", "path to the logo image file"))
    .action(action(ctx, async (client, opts, appArg) => {
      const app = await resolveApp(client, appArg);
      await client.upload(`/apps/${app.id}/logo`, "file", opts.file);
      return "logo updated";
    }));

  // Sign-in policy assignment
  addVerbose(appsCmd.command("assign-policy").description("Assign an app to a sign-in policy").argument("<app>")
    .requiredOption("--policy <name-or-id>", "policy name or id").addOption(new Option("-t, --type <type>", "policy type (for name lookup)")))
    .action(action(ctx, async (client, opts, appArg) => {
      const app = await resolveApp(client, appArg);
      const policy = await resourceGet(client, POLICIES, opts.policy, opts.type ? { type: opts.type } : {});
      await client.json("PUT", `/apps/${app.id}/policies/${policy.id}`);
      return `app ${app.id} (${app.label}) assigned to policy ${policy.id} (${policy.name})`;
    }));

  // Provisioning features
  addOutputOptions(addVerbose(appsCmd.command("feature").description("Retrieve a provisioning feature").argument("<app>").argument("<featureName>")), FEATURE_FIELDS)
    .action(action(ctx, async (client, _o, appArg, featureName) => client.get(`/apps/${(await resolveApp(client, appArg)).id}/features/${featureName}`)));

  addOutputOptions(addVerbose(bodyOpts(appsCmd.command("feature-set").description("Update a provisioning feature").argument("<app>").argument("<featureName>"))), FEATURE_FIELDS)
    .action(action(ctx, async (client, opts, appArg, featureName) => {
      const app = await resolveApp(client, appArg);
      return client.json("PUT", `/apps/${app.id}/features/${featureName}`, { body: bodyFromOpts(opts) });
    }));
}
