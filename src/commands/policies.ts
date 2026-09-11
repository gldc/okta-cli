import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect } from "../cli/options";
import { parseBody } from "../lib/body";
import { deepMerge, isPlainObject } from "../lib/dotted";
import { selectField } from "../lib/lookup";
import type { OktaClient } from "../okta/client";
import { CommunicationError, ExitError, OktaApiError } from "../okta/errors";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

export const POLICY_TYPES = ["OKTA_SIGN_ON", "PASSWORD", "MFA_ENROLL", "IDP_DISCOVERY", "ACCESS_POLICY", "PROFILE_ENROLLMENT", "POST_AUTH_SESSION", "ENTITY_RISK", "CONTINUOUS_ACCESS"];
const RULE_FIELDS = "id,status,type,priority,name,system";

export const POLICIES: ResourceSpec = {
  name: "policies", description: "Policies and rules", path: "/policies", singular: "policy", nameField: "name", defaultFields: "id,status,type,priority,name", lifecycle: true, sortBy: "priority",
  listOptions: [
    { flags: "-t, --type <type>", param: "type", description: "policy type (required for list and for name lookups)", choices: POLICY_TYPES, requiredForList: true },
    { flags: "--status <status>", param: "status", description: "ACTIVE or INACTIVE", choices: ["ACTIVE", "INACTIVE"] },
  ],
};

function sortByPriority(items: any[]): any[] {
  return [...items].sort((a, b) => (typeof a.priority === "number" && typeof b.priority === "number" ? a.priority - b.priority : String(a.priority ?? "").localeCompare(String(b.priority ?? ""))));
}

async function getRule(client: OktaClient, policyId: string, ruleArg: string): Promise<any> {
  try {
    return await client.get(`/policies/${policyId}/rules/${encodeURIComponent(ruleArg)}`);
  } catch (e) {
    if (!(e instanceof OktaApiError) && !(e instanceof CommunicationError)) throw e;
  }
  const rules: any[] = await client.getAll(`/policies/${policyId}/rules`);
  const matches = rules.filter(selectField("name", ruleArg));
  if (matches.length > 1) throw new ExitError(`Name for policy rule must be unique. (found ${matches.length} matches).`);
  if (matches.length === 0) throw new ExitError("No matching policy rule found.");
  return matches[0];
}

const typeOpt = (cmd: Command) => cmd.addOption(new Option("-t, --type <type>", "policy type (for name lookup)").choices(POLICY_TYPES));
const resolvePolicy = (client: OktaClient, opts: Record<string, any>, policyArg: string) => resourceGet(client, POLICIES, policyArg, opts.type ? { type: opts.type } : {});

export function registerPolicies(program: Command, ctx: Ctx): Command {
  const g = defineResource(program, ctx, POLICIES);

  addOutputOptions(addVerbose(typeOpt(g.command("rules").description("List a policy's rules").argument("<policy>"))), RULE_FIELDS)
    .action(action(ctx, async (client, opts, policyArg) => {
      const policy = await resolvePolicy(client, opts, policyArg);
      return sortByPriority(await client.getAll(`/policies/${policy.id}/rules`));
    }));

  addOutputOptions(addVerbose(typeOpt(g.command("rule").description("Get one policy rule by id or unique name substring").argument("<policy>").argument("<rule-name-or-id>"))), RULE_FIELDS)
    .action(action(ctx, async (client, opts, policyArg, ruleArg) => {
      const policy = await resolvePolicy(client, opts, policyArg);
      return getRule(client, policy.id, ruleArg);
    }));

  addOutputOptions(addVerbose(typeOpt(g.command("rule-add").description("Create a policy rule from a JSON body (-b) and/or dotted assignments (-s)").argument("<policy>")
    .option("-b, --body <json>", "JSON body; FILE:<path> reads a file").option("-s, --set <k=v>", "set a (dotted) field", collect, []))), RULE_FIELDS)
    .action(action(ctx, async (client, opts, policyArg) => {
      const policy = await resolvePolicy(client, opts, policyArg);
      const body = parseBody(opts.body, opts.set);
      if (body === undefined) throw new ExitError("Provide -b and/or -s");
      return client.json("POST", `/policies/${policy.id}/rules`, { body });
    }));

  addOutputOptions(addVerbose(typeOpt(g.command("rule-replace").description("Replace (PUT) a policy rule; with only -s the current object is fetched and merged").argument("<policy>").argument("<rule>")
    .option("-b, --body <json>", "JSON body; FILE:<path> reads a file").option("-s, --set <k=v>", "set a (dotted) field", collect, []))), RULE_FIELDS)
    .action(action(ctx, async (client, opts, policyArg, ruleArg) => {
      const policy = await resolvePolicy(client, opts, policyArg);
      const existing = await getRule(client, policy.id, ruleArg);
      let body = parseBody(opts.body, opts.set);
      if (body === undefined) throw new ExitError("Provide -b and/or -s");
      if (!opts.body && isPlainObject(body)) body = deepMerge(existing, body);
      return client.json("PUT", `/policies/${policy.id}/rules/${existing.id}`, { body });
    }));

  for (const verb of ["activate", "deactivate"] as const) {
    addOutputOptions(addVerbose(typeOpt(g.command(`rule-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} a policy rule`).argument("<policy>").argument("<rule>"))), RULE_FIELDS)
      .action(action(ctx, async (client, opts, policyArg, ruleArg) => {
        const policy = await resolvePolicy(client, opts, policyArg);
        const rule = await getRule(client, policy.id, ruleArg);
        const rv = await client.json("POST", `/policies/${policy.id}/rules/${rule.id}/lifecycle/${verb}`);
        return rv ?? `rule ${rule.id} (${rule.name ?? ""}) ${verb}d`;
      }));
  }

  addVerbose(typeOpt(g.command("rule-delete").description("Delete a policy rule").argument("<policy>").argument("<rule>")))
    .action(action(ctx, async (client, opts, policyArg, ruleArg) => {
      const policy = await resolvePolicy(client, opts, policyArg);
      const rule = await getRule(client, policy.id, ruleArg);
      await client.json("DELETE", `/policies/${policy.id}/rules/${rule.id}`);
      return `rule ${rule.id} (${rule.name ?? ""}) deleted from policy ${policy.id}`;
    }));

  addOutputOptions(addVerbose(typeOpt(g.command("clone").description("Clone a policy").argument("<policy>"))), POLICIES.defaultFields)
    .action(action(ctx, async (client, opts, policyArg) => client.json("POST", `/policies/${(await resolvePolicy(client, opts, policyArg)).id}/clone`)));

  addOutputOptions(addVerbose(typeOpt(g.command("apps").description("List apps a policy applies to").argument("<policy>"))), "id,label,status")
    .action(action(ctx, async (client, opts, policyArg) => client.getAll(`/policies/${(await resolvePolicy(client, opts, policyArg)).id}/app`)));

  addOutputOptions(addVerbose(g.command("mappings").description("List a policy's resource mappings").argument("<policy>")), "id,resourceType,resourceId")
    .action(action(ctx, async (client, _opts, policyArg) => client.getAll(`/policies/${(await resourceGet(client, POLICIES, policyArg)).id}/mappings`)));

  addOutputOptions(addVerbose(g.command("map").description("Map a policy to a resource").argument("<policy>")
    .addOption(new Option("--resource-type <type>", "resource type").choices(["APP", "USER_TYPE", "GROUP"]).makeOptionMandatory())
    .requiredOption("--resource-id <id>", "resource id")), "id,resourceType,resourceId")
    .action(action(ctx, async (client, opts, policyArg) => {
      const policy = await resourceGet(client, POLICIES, policyArg);
      return client.json("POST", `/policies/${policy.id}/mappings`, { body: { resourceType: opts.resourceType, resourceId: opts.resourceId } });
    }));

  return g;
}
