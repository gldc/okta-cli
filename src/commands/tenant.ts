import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, int, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import type { OktaClient } from "../okta/client";
import { ExitError } from "../okta/errors";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

const MAPPING_FIELDS = "id,source.name,source.type,target.name,target.type";
const MAPPING_PROPERTY_FIELDS = "property,expression,pushStatus";
const EMAIL_DOMAIN_DNS_FIELDS = "recordType,fqdn,verificationValue";
const PRINCIPAL_RATE_LIMIT_FIELDS = "id,principalType,principalId,defaultPercentage,defaultConcurrencyPercentage";

export const MAPPINGS: ResourceSpec = {
  name: "mappings", description: "Profile mappings", path: "/mappings", singular: "profile mapping",
  nameField: "id", defaultFields: MAPPING_FIELDS, creatable: false, deletable: false, replaceable: false,
  listOptions: [
    { flags: "--source-id <id>", param: "sourceId", description: "filter by source id" },
    { flags: "--target-id <id>", param: "targetId", description: "filter by target id" },
  ],
};

export const EMAIL_DOMAINS: ResourceSpec = {
  name: "email-domains", description: "Custom email sender domains", path: "/email-domains", singular: "email domain",
  nameField: "domain", defaultFields: "id,domain,displayName,userName,validationStatus",
};

export const BEHAVIORS: ResourceSpec = {
  name: "behaviors", description: "Behavior detection rules", path: "/behaviors", singular: "behavior rule",
  nameField: "name", defaultFields: "id,status,type,name", lifecycle: true,
};

export const SMS_TEMPLATES: ResourceSpec = {
  name: "sms-templates", description: "Custom SMS templates", path: "/templates/sms", singular: "SMS template",
  nameField: "name", defaultFields: "id,type,name,template",
  listOptions: [{ flags: "--template-type <t>", param: "templateType", description: "SMS_VERIFY_CODE" }],
};

export const REALMS: ResourceSpec = {
  name: "realms", description: "Realms", path: "/realms", singular: "realm",
  nameField: "profile.name", defaultFields: "id,profile.name,profile.realmType,isDefault,created",
  listOptions: [{ flags: "--search <expr>", param: "search", description: "SCIM search" }],
};

export const REALM_ASSIGNMENTS: ResourceSpec = {
  name: "realm-assignments", description: "Realm assignments", path: "/realm-assignments", singular: "realm assignment",
  nameField: "name", defaultFields: "id,status,priority,name,isDefault", lifecycle: true, sortBy: "priority",
};

export const CAPTCHAS: ResourceSpec = {
  name: "captchas", description: "CAPTCHA instances", path: "/captchas", singular: "CAPTCHA instance",
  nameField: "name", defaultFields: "id,name,type,siteKey",
};

const bodyOpts = (cmd: Command) => cmd.option("-b, --body <json>", "JSON body; FILE:<path> reads a file").option("-s, --set <k=v>", "set a (dotted) field", collect, []);
const bodyFromOpts = (opts: Record<string, any>) => {
  const body = parseBody(opts.body, opts.set);
  if (body === undefined) throw new ExitError("Provide -b and/or -s");
  return body;
};

export function registerTenant(program: Command, ctx: Ctx): void {
  const mp = defineResource(program, ctx, MAPPINGS);
  addOutputOptions(addVerbose(bodyOpts(mp.command("update").description("Update (POST) a profile mapping's property expressions").argument("<mapping-id>"))), MAPPING_FIELDS)
    .action(action(ctx, async (client, opts, mappingArg) => {
      const mapping = await resourceGet(client, MAPPINGS, mappingArg);
      return client.json("POST", `/mappings/${mapping.id}`, { body: bodyFromOpts(opts) });
    }));
  addOutputOptions(addVerbose(mp.command("properties").description("List a profile mapping's property expressions").argument("<mapping-id>")), MAPPING_PROPERTY_FIELDS)
    .action(action(ctx, async (client, _o, mappingArg) => {
      const mapping = await resourceGet(client, MAPPINGS, mappingArg);
      const props: Record<string, any> = mapping.properties ?? {};
      return Object.entries(props)
        .map(([property, v]) => ({ property, expression: v?.expression, pushStatus: v?.pushStatus }))
        .sort((a, b) => a.property.localeCompare(b.property));
    }));

  const ed = defineResource(program, ctx, EMAIL_DOMAINS);
  addOutputOptions(addVerbose(ed.command("verify").description("Trigger DNS verification of an email domain").argument("<domain>")), EMAIL_DOMAINS.defaultFields)
    .action(action(ctx, async (client, _o, domainArg) => {
      const domain = await resourceGet(client, EMAIL_DOMAINS, domainArg);
      return client.json("POST", `/email-domains/${domain.id}/verify`);
    }));
  addOutputOptions(addVerbose(ed.command("dns").description("Show DNS validation records for an email domain").argument("<domain>")), EMAIL_DOMAIN_DNS_FIELDS)
    .action(action(ctx, async (client, _o, domainArg) => (await resourceGet(client, EMAIL_DOMAINS, domainArg)).dnsValidationRecords ?? []));

  defineResource(program, ctx, BEHAVIORS);
  defineResource(program, ctx, SMS_TEMPLATES);
  defineResource(program, ctx, REALMS);
  defineResource(program, ctx, REALM_ASSIGNMENTS);
  defineResource(program, ctx, CAPTCHAS);

  const rl = subgroup(program, "rate-limits", "Rate limit settings and principal overrides");

  addOutputOptions(addVerbose(rl.command("settings").description("Show admin-notifications, per-client and warning-threshold rate limit settings")), null)
    .action(action(ctx, async (client: OktaClient) => {
      const [adminNotifications, perClient, warningThreshold] = await Promise.all([
        client.get("/rate-limit-settings/admin-notifications"),
        client.get("/rate-limit-settings/per-client"),
        client.get("/rate-limit-settings/warning-threshold"),
      ]);
      return { adminNotifications, perClient, warningThreshold };
    }));

  addOutputOptions(addVerbose(rl.command("set-warning-threshold").description("Set the rate limit warning threshold percentage").argument("<percent>")), null)
    .action(action(ctx, (client, _o, percent) => client.json("PUT", "/rate-limit-settings/warning-threshold", { body: { warningThreshold: int(percent) } })));

  addOutputOptions(addVerbose(rl.command("set-admin-notifications").description("Enable or disable rate limit admin notification emails")
    .addOption(new Option("--enabled", "enable admin notification emails").conflicts("disabled"))
    .addOption(new Option("--disabled", "disable admin notification emails").conflicts("enabled"))), null)
    .action(action(ctx, (client, opts) => {
      if (!opts.enabled && !opts.disabled) throw new ExitError("Provide --enabled or --disabled");
      return client.json("PUT", "/rate-limit-settings/admin-notifications", { body: { notificationsEnabled: !!opts.enabled } });
    }));

  addOutputOptions(addVerbose(bodyOpts(rl.command("set-per-client").description("Replace the per-client rate limit settings"))), null)
    .action(action(ctx, (client, opts) => client.json("PUT", "/rate-limit-settings/per-client", { body: bodyFromOpts(opts) })));

  // Deviation from the plan: listPrincipalRateLimitEntities' `filter` query parameter is
  // mandatory in the schema (not optional), so `--filter` is a required option here.
  addOutputOptions(addVerbose(rl.command("principals").description("List principal rate limit overrides").requiredOption("--filter <expr>", 'filter expression, e.g. principalType eq "SSWS_TOKEN"')), PRINCIPAL_RATE_LIMIT_FIELDS)
    .action(action(ctx, (client, opts) => client.getAll("/principal-rate-limits", { query: { filter: opts.filter } })));

  addOutputOptions(addVerbose(bodyOpts(rl.command("principal-add").description("Create a principal rate limit override"))), PRINCIPAL_RATE_LIMIT_FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/principal-rate-limits", { body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(bodyOpts(rl.command("principal-update").description("Replace a principal rate limit override").argument("<id>"))), PRINCIPAL_RATE_LIMIT_FIELDS)
    .action(action(ctx, (client, opts, id) => client.json("PUT", `/principal-rate-limits/${id}`, { body: bodyFromOpts(opts) })));
}
