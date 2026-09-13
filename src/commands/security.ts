import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, subgroup } from "../cli/options";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

const ATTACK_PROTECTION_BASE = "/attack-protection/api/v1";

// Deviation from the plan: SecurityEventsProviderResponse has no `lastUpdated` field.
export const SECURITY_EVENTS_PROVIDERS: ResourceSpec = {
  name: "security-events-providers", description: "Security events providers", path: "/security-events-providers", singular: "security events provider",
  nameField: "name", defaultFields: "id,name,status,type", lifecycle: true,
};

export const PUSH_PROVIDERS: ResourceSpec = {
  name: "push-providers", description: "Push notification providers (APNS/FCM)", path: "/push-providers", singular: "push provider",
  nameField: "name", defaultFields: "id,name,providerType,lastUpdatedDate",
  listOptions: [{ flags: "--type <t>", param: "type", description: "APNS or FCM", choices: ["APNS", "FCM"] }],
};

// Deviation from the plan: DeviceIntegrations has no `lastUpdated` field (only `displayName`,
// the enum `name` namespace, `status`, `platform`).
export const DEVICE_INTEGRATIONS: ResourceSpec = {
  name: "device-integrations", description: "Device integrations (posture providers, endpoint management)", path: "/device-integrations", singular: "device integration",
  nameField: "name", defaultFields: "id,displayName,name,status,platform", lifecycle: true, creatable: false, deletable: false, replaceable: false,
};

export const DEVICE_POSTURE_CHECKS: ResourceSpec = {
  name: "device-posture-checks", description: "Device posture checks", path: "/device-posture-checks", singular: "device posture check",
  nameField: "name", defaultFields: "id,name,platform,type,variableName",
};

// Deviation from the plan: EmailServerListResponse wraps the array under an `email-servers` key.
export const EMAIL_SERVERS: ResourceSpec = {
  name: "email-servers", description: "Custom SMTP email servers", path: "/email-servers", singular: "email server",
  nameField: "alias", defaultFields: "id,alias,host,port,username,enabled", replaceable: false, listKey: "email-servers",
};

export function registerSecurity(program: Command, ctx: Ctx): void {
  defineResource(program, ctx, SECURITY_EVENTS_PROVIDERS);

  // SSF (Shared Signals Framework) streams.
  const ssf = subgroup(program, "ssf", "Shared Signals Framework (SSF) streams");

  // Deviation from the plan: without --stream-id this returns the full StreamConfiguration
  // array (or a single StreamConfiguration with it), not a bare array of ids - printed as
  // JSON since StreamConfiguration's fields don't fit a fixed table.
  addOutputOptions(addVerbose(ssf.command("stream").description("Retrieve SSF stream configuration(s) (all, or one with --stream-id)")
    .option("--stream-id <id>", "SSF stream configuration id")), null)
    .action(action(ctx, (client, opts) => client.get("/ssf/stream", opts.streamId ? { stream_id: opts.streamId } : {})));

  addOutputOptions(addVerbose(bodyOpts(ssf.command("stream-add").description("Create an SSF stream"))), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/ssf/stream", { body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(bodyOpts(ssf.command("stream-replace").description("Replace (PUT) the SSF stream configuration"))), null)
    .action(action(ctx, (client, opts) => client.json("PUT", "/ssf/stream", { body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(bodyOpts(ssf.command("stream-update").description("Update (PATCH) the SSF stream configuration"))), null)
    .action(action(ctx, (client, opts) => client.json("PATCH", "/ssf/stream", { body: bodyFromOpts(opts) })));

  addVerbose(ssf.command("stream-delete").description("Delete an SSF stream (all, or one with --stream-id)").option("--stream-id <id>", "SSF stream configuration id"))
    .action(action(ctx, async (client, opts) => {
      await client.json("DELETE", "/ssf/stream", { query: opts.streamId ? { stream_id: opts.streamId } : {} });
      return opts.streamId ? `SSF stream ${opts.streamId} deleted` : "SSF stream deleted";
    }));

  // Deviation from the plan: getSsfStreamStatus's `stream_id` query parameter is mandatory
  // in the schema (not optional), so `--stream-id` is required here.
  addOutputOptions(addVerbose(ssf.command("stream-status").description("Retrieve the status of an SSF stream").requiredOption("--stream-id <id>", "SSF stream configuration id")), null)
    .action(action(ctx, (client, opts) => client.get("/ssf/stream/status", { stream_id: opts.streamId })));

  // Deviation from the plan: there's no `stream-status-set` command - the spec has no POST
  // for /ssf/stream/status (GET only). Also, StreamVerificationRequest.stream_id is mandatory,
  // so --stream-id is required here too (not optional as the plan has it).
  addVerbose(ssf.command("stream-verify").description("Verify an SSF stream by publishing a verification event").requiredOption("--stream-id <id>", "SSF stream configuration id").option("--state <s>", "arbitrary state string echoed back by the receiver"))
    .action(action(ctx, (client, opts) => client.json("POST", "/ssf/stream/verification", { body: { stream_id: opts.streamId, state: opts.state } })));

  // Deviation from the plan: the request body is a raw SET JWT string (Content-Type:
  // application/secevent+jwt), not JSON, so it bypasses bodyOpts/bodyFromOpts's JSON parsing.
  const se = subgroup(program, "security-events", "Security event tokens (SETs)");
  addVerbose(se.command("send").description("Publish a security event token (SET JWT) to Okta").requiredOption("-b, --body <jwt>", "raw SET JWT; FILE:<path> reads a file"))
    .action(action(ctx, async (client, opts) => {
      const jwt: string = (opts.body.startsWith("FILE:") ? readFileSync(opts.body.slice(5), "utf8") : opts.body).trim();
      await client.json("POST", "/security-events", { basePath: "/security/api/v1", body: jwt, headers: { "Content-Type": "application/secevent+jwt" } });
      return "security event token published";
    }));

  // ThreatInsight configuration.
  const threats = subgroup(program, "threats", "ThreatInsight configuration");
  addOutputOptions(addVerbose(threats.command("config").description("Retrieve the ThreatInsight configuration")), null)
    .action(action(ctx, (client) => client.get("/threats/configuration")));
  // Deviation from the plan: updateConfiguration is a POST, not a PUT.
  addOutputOptions(addVerbose(bodyOpts(threats.command("config-set").description("Update the ThreatInsight configuration"))), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/threats/configuration", { body: bodyFromOpts(opts) })));

  // Bot protection configuration.
  const bot = subgroup(program, "bot-protection", "Bot protection configuration");
  addOutputOptions(addVerbose(bot.command("config").description("Retrieve the bot protection configuration")), null)
    .action(action(ctx, (client) => client.get("/bot-protection/configuration")));
  // Deviation from the plan: updateBotProtectionConfiguration is a POST, not a PUT.
  addOutputOptions(addVerbose(bodyOpts(bot.command("config-set").description("Update the bot protection configuration"))), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/bot-protection/configuration", { body: bodyFromOpts(opts) })));

  // Attack protection (authenticator settings, user lockout settings).
  const ap = subgroup(program, "attack-protection", "Attack protection settings");
  addOutputOptions(addVerbose(ap.command("authenticator-settings").description("Retrieve the authenticator settings")), null)
    .action(action(ctx, (client) => client.json("GET", "/authenticator-settings", { basePath: ATTACK_PROTECTION_BASE })));
  addOutputOptions(addVerbose(bodyOpts(ap.command("authenticator-settings-set").description("Replace the authenticator settings"))), null)
    .action(action(ctx, (client, opts) => client.json("PUT", "/authenticator-settings", { body: bodyFromOpts(opts), basePath: ATTACK_PROTECTION_BASE })));
  addOutputOptions(addVerbose(ap.command("lockout-settings").description("Retrieve the user lockout settings")), null)
    .action(action(ctx, (client) => client.json("GET", "/user-lockout-settings", { basePath: ATTACK_PROTECTION_BASE })));
  addOutputOptions(addVerbose(bodyOpts(ap.command("lockout-settings-set").description("Replace the user lockout settings"))), null)
    .action(action(ctx, (client, opts) => client.json("PUT", "/user-lockout-settings", { body: bodyFromOpts(opts), basePath: ATTACK_PROTECTION_BASE })));

  defineResource(program, ctx, PUSH_PROVIDERS);
  defineResource(program, ctx, DEVICE_INTEGRATIONS);

  const dpc = defineResource(program, ctx, DEVICE_POSTURE_CHECKS);
  addOutputOptions(addVerbose(dpc.command("defaults").description("List all default (BUILTIN) device posture checks")), DEVICE_POSTURE_CHECKS.defaultFields)
    .action(action(ctx, (client) => client.getAll("/device-posture-checks/default")));

  // Email servers.
  const es = defineResource(program, ctx, EMAIL_SERVERS);
  addOutputOptions(addVerbose(bodyOpts(es.command("update").description("Update (PATCH) a custom SMTP email server").argument("<server>"))), EMAIL_SERVERS.defaultFields)
    .action(action(ctx, async (client, opts, serverArg) => {
      const server = await resourceGet(client, EMAIL_SERVERS, serverArg);
      return client.json("PATCH", `/email-servers/${server.id}`, { body: bodyFromOpts(opts) });
    }));
  addVerbose(es.command("test").description("Send a test email through a custom SMTP email server").argument("<server>").option("--from <addr>", "sender address").option("--to <addr>", "recipient address"))
    .action(action(ctx, async (client, opts, serverArg) => {
      const server = await resourceGet(client, EMAIL_SERVERS, serverArg);
      await client.json("POST", `/email-servers/${server.id}/test`, { body: { fromAddress: opts.from, toAddress: opts.to } });
      return `test email sent through email server ${server.id} (${server.alias})`;
    }));

  // Disaster recovery.
  const dr = subgroup(program, "dr", "Disaster recovery failover/failback");
  // Deviation from the plan: DRStatusResponse wraps a `status` array of `{ domain, isFailedOver }`
  // (no `status`/`lastUpdated` fields as the plan guessed).
  addOutputOptions(addVerbose(dr.command("status").description("Retrieve the disaster recovery status for all domains, or one domain").argument("[domain]")), "domain,isFailedOver")
    .action(action(ctx, async (client, _o, domain?: string) => (await client.get(domain ? `/dr/status/${domain}` : "/dr/status")).status ?? []));
  addOutputOptions(addVerbose(bodyOpts(dr.command("failover").description("Start the failover of your org"))), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/dr/failover", { body: bodyFromOpts(opts) })));
  addOutputOptions(addVerbose(bodyOpts(dr.command("failback").description("Start the failback of your org"))), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/dr/failback", { body: bodyFromOpts(opts) })));
}
