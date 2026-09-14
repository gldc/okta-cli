import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, collect, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import { ExitError } from "../okta/errors";
import { GOV_V2 } from "./governance";

// See "Resolved ambiguities" #2 in the plan: these four families are addressed with the
// resource as the first positional argument (an ORN or Okta id, per gov-schema.d.ts's
// `resource-id-orn-or-okta` parameter), not through a `resources` subgroup or a
// `defineResource`/`resourceGet` lookup - there is no `GET /resources` list endpoint to
// resolve a name against, so the argument is used as-is (encodeURIComponent'd for the URL).

const CONDITION_FIELDS = "id,status,priority,name,description,approvalSequenceId";
const SEQUENCE_FIELDS = "id,name,description,compatibleResourceTypes";
// `list`'s own default fields, without `description`: live, a sequence's description is
// frequently multi-paragraph, which wrecks the table layout. `get` (a single row) keeps
// SEQUENCE_FIELDS with description - that's not a table-layout problem there.
const SEQUENCE_LIST_FIELDS = "id,name,compatibleResourceTypes";

// Builds the `revoke-principal-access-creatable` body: verbatim from -b, or
// {principalOrn, revokeOrns} from --principal/--revoke. Mirrors `messageBody` in
// governance-requests.ts's -b-vs-flags shape.
function revokePrincipalAccessBody(opts: Record<string, any>): unknown {
  if (opts.body !== undefined) {
    if (opts.principal !== undefined || opts.revoke?.length) throw new ExitError("Use either -b or --principal/--revoke");
    return parseBody(opts.body);
  }
  if (!opts.principal || !opts.revoke?.length) throw new ExitError("Provide -b, or --principal and at least one --revoke");
  return { principalOrn: opts.principal, revokeOrns: opts.revoke };
}

export function registerGovernanceResources(g: Command, ctx: Ctx): void {
  const conditions = subgroup(g, "request-conditions", "Resource request conditions (who can request access, and how) (v2)");

  // Deviation check (plan Task 6, request-conditions list bullet): the plan flags
  // `conditions-list-filter` as a parameter that exists in the spec's parameter set but
  // needs confirming against `listResourceRequestConditionsV2`'s own `parameters.query`.
  // gov-schema.d.ts (grep "listResourceRequestConditionsV2") declares `query?: never` for
  // that operation, so `--filter` is dropped here as the plan anticipated - no deviation.
  addOutputOptions(addVerbose(conditions.command("list").description("List a resource's request conditions").argument("<resourceId>")), CONDITION_FIELDS)
    .action(action(ctx, (client, _opts, resourceId) =>
      client.getAll(`/resources/${encodeURIComponent(resourceId)}/request-conditions`, { basePath: GOV_V2, listKey: "data" })));

  addOutputOptions(addVerbose(conditions.command("get").description("Get one request condition").argument("<resourceId>").argument("<conditionId>")), CONDITION_FIELDS)
    .action(action(ctx, (client, _opts, resourceId, conditionId) =>
      client.json("GET", `/resources/${encodeURIComponent(resourceId)}/request-conditions/${encodeURIComponent(conditionId)}`, { basePath: GOV_V2 })));

  addOutputOptions(addVerbose(bodyOpts(conditions.command("add").description("Create a request condition (-b and/or -s); required: requesterSettings, accessScopeSettings, approvalSequenceId, name").argument("<resourceId>"))), CONDITION_FIELDS)
    .action(action(ctx, (client, opts, resourceId) =>
      client.json("POST", `/resources/${encodeURIComponent(resourceId)}/request-conditions`, { basePath: GOV_V2, body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(bodyOpts(conditions.command("update").description("Update a request condition (-b and/or -s; object body: name?, description?, requesterSettings?, accessScopeSettings?, accessDurationSettings?, approvalSequenceId?, priority?)").argument("<resourceId>").argument("<conditionId>"))), CONDITION_FIELDS)
    .action(action(ctx, (client, opts, resourceId, conditionId) =>
      client.json("PATCH", `/resources/${encodeURIComponent(resourceId)}/request-conditions/${encodeURIComponent(conditionId)}`, { basePath: GOV_V2, body: bodyFromOpts(opts) })));

  addVerbose(conditions.command("delete").description("Delete a request condition").argument("<resourceId>").argument("<conditionId>"))
    .action(action(ctx, async (client, _opts, resourceId, conditionId) => {
      await client.json("DELETE", `/resources/${encodeURIComponent(resourceId)}/request-conditions/${encodeURIComponent(conditionId)}`, { basePath: GOV_V2 });
      return `request condition ${conditionId} deleted`;
    }));

  for (const verb of ["activate", "deactivate"] as const) {
    addOutputOptions(addVerbose(conditions.command(verb).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} a request condition`).argument("<resourceId>").argument("<conditionId>")), CONDITION_FIELDS)
      .action(action(ctx, (client, _opts, resourceId, conditionId) =>
        client.json("POST", `/resources/${encodeURIComponent(resourceId)}/request-conditions/${encodeURIComponent(conditionId)}/${verb}`, { basePath: GOV_V2 })));
  }

  const sequences = subgroup(g, "request-sequences", "Resource request sequences (approval sequences compatible with a resource type) (v2)");

  addOutputOptions(addVerbose(sequences.command("list").description("List a resource's request sequences").argument("<resourceId>")), SEQUENCE_LIST_FIELDS)
    .action(action(ctx, (client, _opts, resourceId) =>
      client.getAll(`/resources/${encodeURIComponent(resourceId)}/request-sequences`, { basePath: GOV_V2, listKey: "data" })));

  addOutputOptions(addVerbose(sequences.command("get").description("Get one request sequence").argument("<resourceId>").argument("<sequenceId>")), SEQUENCE_FIELDS)
    .action(action(ctx, (client, _opts, resourceId, sequenceId) =>
      client.json("GET", `/resources/${encodeURIComponent(resourceId)}/request-sequences/${encodeURIComponent(sequenceId)}`, { basePath: GOV_V2 })));

  // Asymmetric: the delete path is NOT resource-scoped (`/governance/api/v2/request-sequences/
  // {id}`, unlike list/get's `/resources/{resourceId}/request-sequences/{id}`) - takes only
  // the sequence id. Do not "fix" this to match list/get's two-positional shape.
  addVerbose(sequences.command("delete").description("Delete a request sequence (not resource-scoped, unlike list/get: takes only the sequence id)").argument("<sequenceId>"))
    .action(action(ctx, async (client, _opts, sequenceId) => {
      await client.json("DELETE", `/request-sequences/${encodeURIComponent(sequenceId)}`, { basePath: GOV_V2 });
      return `request sequence ${sequenceId} deleted`;
    }));

  const settings = subgroup(g, "request-settings", "Resource and org-wide access request settings (v2)");

  addOutputOptions(addVerbose(settings.command("get").description("Get a resource's request settings").argument("<resourceId>")), null)
    .action(action(ctx, (client, _opts, resourceId) => client.json("GET", `/resources/${encodeURIComponent(resourceId)}/request-settings`, { basePath: GOV_V2 })));

  addOutputOptions(addVerbose(bodyOpts(settings.command("update").description("Update a resource's request settings (-b and/or -s; object body: requestOnBehalfOfSettings?, riskSettings?)").argument("<resourceId>"))), null)
    .action(action(ctx, (client, opts, resourceId) => client.json("PATCH", `/resources/${encodeURIComponent(resourceId)}/request-settings`, { basePath: GOV_V2, body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(settings.command("org-get").description("Get org-wide access request settings")), null)
    .action(action(ctx, (client) => client.json("GET", "/request-settings", { basePath: GOV_V2 })));

  addOutputOptions(addVerbose(bodyOpts(settings.command("org-update").description("Update org-wide access request settings (-b and/or -s; object body: subprocessorsAcknowledged?, integrations?)"))), null)
    .action(action(ctx, (client, opts) => client.json("PATCH", "/request-settings", { basePath: GOV_V2, body: bodyFromOpts(opts) })));

  const entitlementSettings = subgroup(g, "entitlement-settings", "Per-resource entitlement management opt-in/opt-out (v2)");

  addOutputOptions(addVerbose(entitlementSettings.command("get").description("Get a resource's entitlement management status").argument("<resourceOrn>")), "status")
    .action(action(ctx, (client, _opts, resourceOrn) => client.json("GET", `/resources/${encodeURIComponent(resourceOrn)}/entitlement-settings`, { basePath: GOV_V2 })));

  addOutputOptions(addVerbose(entitlementSettings.command("set").description("Opt a resource in or out of entitlement management (async - the response status may still read OPTING_*; poll with `gov operations get`)").argument("<resourceOrn>")
    .addOption(new Option("--status <status>", "OPTED_IN or OPTED_OUT").choices(["OPTED_IN", "OPTED_OUT"]).makeOptionMandatory())), "status")
    .action(action(ctx, (client, opts, resourceOrn) =>
      client.json("PATCH", `/resources/${encodeURIComponent(resourceOrn)}/entitlement-settings`, { basePath: GOV_V2, body: { status: opts.status } })));

  // Top level on the governance group, not a subgroup (only one operation).
  addOutputOptions(addVerbose(g.command("revoke-principal-access").description("Revoke a principal's access to one or more resources (-b, or --principal/--revoke; async - the response carries only _links to the operations to poll) (v2)")
    .option("-b, --body <json>", "JSON body (revoke-principal-access-creatable); FILE:<path> reads a file; mutually exclusive with --principal/--revoke")
    .option("--principal <orn>", "principalOrn (user ORN) whose access is being revoked")
    .option("--revoke <orn>", "resourceOrn to revoke (repeatable)", collect, [])), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/revoke-principal-access", { basePath: GOV_V2, body: revokePrincipalAccessBody(opts) })));
}
