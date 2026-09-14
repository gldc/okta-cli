import { InvalidArgumentError, Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose } from "../cli/options";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

const SCOPE_CHOICES = ["CORS", "REDIRECT", "IFRAME_EMBED"];
const collectScope = (v: string, prev: string[]): string[] => {
  if (!SCOPE_CHOICES.includes(v)) throw new InvalidArgumentError(`Allowed choices are ${SCOPE_CHOICES.join(", ")}.`);
  return [...prev, v];
};

export const TRUSTED_ORIGINS: ResourceSpec = { name: "trusted-origins", description: "Trusted origins (CORS / redirect)", path: "/trustedOrigins", singular: "trusted origin", nameField: "name", defaultFields: "id,status,name,origin", lifecycle: true, creatable: false };
export const DOMAINS: ResourceSpec = { name: "domains", description: "Custom domains", path: "/domains", singular: "custom domain", nameField: "domain", defaultFields: "id,domain,validationStatus,certificateSourceType", listKey: "domains", replaceable: false, creatable: false };
export const ZONES: ResourceSpec = { name: "zones", description: "Network zones", path: "/zones", singular: "network zone", nameField: "name", defaultFields: "id,status,type,usage,name", lifecycle: true };
export const LOG_STREAMS: ResourceSpec = { name: "log-streams", description: "Log streams", path: "/logStreams", singular: "log stream", nameField: "name", defaultFields: "id,status,type,name", lifecycle: true,
  listOptions: [{ flags: "-t, --type <type>", param: "filter", description: "log stream type (aws_eventbridge, splunk_cloud_logstreaming)", transform: (v) => `type eq "${v}"` }] };
const LOG_STREAM_SCHEMA_FIELDS = "id,title,type";

export function registerPlatform(program: Command, ctx: Ctx): void {
  const to = defineResource(program, ctx, TRUSTED_ORIGINS);
  addOutputOptions(addVerbose(to.command("add").description("Create a trusted origin")
    .requiredOption("-n, --name <name>").requiredOption("-o, --origin <url>")
    .addOption(new Option("--scope <scope>", "scope type, repeatable (default: CORS + REDIRECT)").choices(SCOPE_CHOICES).argParser(collectScope).default([]))), TRUSTED_ORIGINS.defaultFields)
    .action(action(ctx, (client, opts) => {
      const scopes: string[] = opts.scope.length ? opts.scope : ["CORS", "REDIRECT"];
      return client.json("POST", "/trustedOrigins", { body: { name: opts.name, origin: opts.origin, scopes: scopes.map((type) => ({ type })) } });
    }));

  const dm = defineResource(program, ctx, DOMAINS);
  addOutputOptions(addVerbose(dm.command("add").description("Create a custom domain").requiredOption("-d, --domain <fqdn>")
    .addOption(new Option("--cert-source <type>", "certificate source").choices(["MANUAL", "OKTA_MANAGED"]).default("OKTA_MANAGED"))), DOMAINS.defaultFields)
    .action(action(ctx, (client, opts) => client.json("POST", "/domains", { body: { domain: opts.domain, certificateSourceType: opts.certSource } })));
  addOutputOptions(addVerbose(dm.command("verify").description("Trigger DNS verification of a custom domain").argument("<domain-or-id>")), DOMAINS.defaultFields)
    .action(action(ctx, async (client, _o, d) => client.json("POST", `/domains/${(await resourceGet(client, DOMAINS, d)).id}/verify`)));

  addVerbose(dm.command("certificate").description("Upsert the certificate for a custom domain").argument("<domain-or-id>")
    .requiredOption("--cert <path>", "path to the PEM certificate").requiredOption("--key <path>", "path to the PEM private key")
    .option("--chain <path>", "path to the PEM certificate chain"))
    .action(action(ctx, async (client, opts, d) => {
      const domain = await resourceGet(client, DOMAINS, d);
      const [certificate, privateKey, certificateChain] = await Promise.all([
        Bun.file(opts.cert).text(), Bun.file(opts.key).text(), opts.chain ? Bun.file(opts.chain).text() : Promise.resolve(undefined),
      ]);
      await client.json("PUT", `/domains/${domain.id}/certificate`, { body: { type: "PEM", certificate, privateKey, certificateChain } });
      return `certificate updated for domain ${domain.id} (${domain.domain})`;
    }));

  defineResource(program, ctx, ZONES);
  const ls = defineResource(program, ctx, LOG_STREAMS);

  addOutputOptions(addVerbose(ls.command("schemas").description("List the log stream schemas")), LOG_STREAM_SCHEMA_FIELDS)
    .action(action(ctx, (client) => client.get("/meta/schemas/logStream")));

  addOutputOptions(addVerbose(ls.command("schema").description("Retrieve the schema for a log stream type").argument("<type>")), LOG_STREAM_SCHEMA_FIELDS)
    .action(action(ctx, (client, _o, type) => client.get(`/meta/schemas/logStream/${type}`)));
}
