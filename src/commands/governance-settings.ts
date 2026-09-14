import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, collect, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import type { OktaClient } from "../okta/client";
import { ExitError } from "../okta/errors";
import { GOV_V1 } from "./governance";
import { defineResource, type ResourceSpec } from "./resource";

const INTEGRATION_FIELDS = "id,type,status";
const ASSESS_FIELDS = "ruleId,ruleName,type,principalOrn,resourceOrn";

// integration-type (gov-schema.d.ts, grepped 2026-09-14) is a one-value enum today (`SLACK`) -
// wired as .choices() per the plan so a future second value only needs updating here.
const INTEGRATION_TYPES = ["SLACK"];

function integrationAddBody(opts: Record<string, any>): unknown {
  if (opts.body !== undefined || (opts.set as string[] | undefined)?.length) {
    if (opts.type !== undefined) throw new ExitError("Use either -b/-s or --type");
    return bodyFromOpts(opts);
  }
  if (!opts.type) throw new ExitError("Provide -b/-s, or --type");
  return { type: opts.type };
}

// update-risk-rule-request (gov-schema.d.ts, grepped 2026-09-14) requires `id` and accepts only
// name/notes/description/conflictCriteria - not `status`, which the GET representation
// (risk-rule-conflict, used as defineResource's replace merge base) carries but the update
// schema does not accept. Not called out in the plan; found while checking the PUT body shape.
// Follows the `customRoleReplaceBody`/`requireCaptchaSecretKey` precedent (roles.ts, tenant.ts)
// of an explicit beforeReplace allowlist, since REPLACE_OMIT_DEFAULT's blanket `id` strip would
// otherwise send a body missing the one field the schema requires.
async function riskRuleReplaceBody(_client: OktaClient, existing: any, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { id: existing.id, name: body.name, notes: body.notes, description: body.description, conflictCriteria: body.conflictCriteria };
}

export const GOV_RISK_RULES: ResourceSpec = {
  name: "risk-rules", description: "Separation-of-duties risk rules", path: "/risk-rules",
  basePath: GOV_V1, singular: "risk rule", nameField: "name", listKey: "data",
  defaultFields: "id,name,status,type,description", limitOption: true,
  beforeReplace: riskRuleReplaceBody,
};

// Builds the `potential-risk-assessment-request` body: verbatim from -b, or {principalOrn,
// resourceOrn|resourceOrnList} from --principal/--resource - one --resource sends the singular
// field, two-or-more send the list form (the schema allows only one or the other).
function riskRuleAssessBody(opts: Record<string, any>): unknown {
  const resources = (opts.resource as string[] | undefined) ?? [];
  if (opts.body !== undefined) {
    if (opts.principal !== undefined || resources.length) throw new ExitError("Use either -b or --principal/--resource");
    return parseBody(opts.body);
  }
  if (!opts.principal) throw new ExitError("Provide -b, or --principal (and optionally --resource)");
  const out: Record<string, unknown> = { principalOrn: opts.principal };
  if (resources.length === 1) out.resourceOrn = resources[0];
  else if (resources.length > 1) out.resourceOrnList = resources;
  return out;
}

export function registerGovernanceSettings(g: Command, ctx: Ctx): void {
  const settings = subgroup(g, "settings", "Org-wide governance settings and certification integrations");

  addOutputOptions(addVerbose(settings.command("get").description("Get org governance settings (delegates, governanceAI, escalations, integrations)")), null)
    .action(action(ctx, (client) => client.json("GET", "/settings", { basePath: GOV_V1 })));

  addOutputOptions(addVerbose(bodyOpts(settings.command("update").description("Update org governance settings (-b and/or -s; object body: delegates?, governanceAI?, escalations?; integrations is read-only here - present on GET but not accepted by this PATCH)"))), null)
    .action(action(ctx, (client, opts) => client.json("PATCH", "/settings", { basePath: GOV_V1, body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(settings.command("certification").description("Get org certification integration settings")), null)
    .action(action(ctx, (client) => client.json("GET", "/settings/certification", { basePath: GOV_V1 })));

  addOutputOptions(addVerbose(bodyOpts(settings.command("certification-update").description('Update org certification integration settings (-b and/or -s; object body: {integrations: {settings: [...]}})'))), null)
    .action(action(ctx, (client, opts) => client.json("PATCH", "/settings/certification", { basePath: GOV_V1, body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(settings.command("integrations").description("List org certification integrations (declares no filter/limit; one SLACK integration seen live on runlayer.okta.com)")), INTEGRATION_FIELDS)
    .action(action(ctx, (client) => client.getAll("/settings/integrations", { basePath: GOV_V1, listKey: "data" })));

  addOutputOptions(addVerbose(bodyOpts(settings.command("integration-add").description("Add an org certification integration (--type, or -b/-s)"))
    .addOption(new Option("--type <t>", "integration type").choices(INTEGRATION_TYPES))),
  INTEGRATION_FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/settings/integrations", { basePath: GOV_V1, body: integrationAddBody(opts) })));

  addVerbose(settings.command("integration-delete").description("Delete an org certification integration").argument("<integrationId>"))
    .action(action(ctx, async (client, _opts, integrationId) => {
      await client.json("DELETE", `/settings/integrations/${encodeURIComponent(integrationId)}`, { basePath: GOV_V1 });
      return `integration ${integrationId} deleted`;
    }));

  const riskRules = defineResource(g, ctx, GOV_RISK_RULES);

  addOutputOptions(addVerbose(riskRules.command("assess").description("Dry-run check for what access would conflict with a risk rule, without changing anything (-b, or --principal/--resource)")
    .option("-b, --body <json>", "JSON body (potential-risk-assessment-request); FILE:<path> reads a file; mutually exclusive with --principal/--resource")
    .option("--principal <orn>", "principalOrn to assess")
    .option("--resource <orn>", "resourceOrn to assess against (repeatable; 2+ sends resourceOrnList instead of resourceOrn)", collect, [])),
  ASSESS_FIELDS)
    .action(action(ctx, async (client, opts) => {
      const rv = await client.json("POST", "/risk-rule-assessments", { basePath: GOV_V1, body: riskRuleAssessBody(opts) });
      return rv.data;
    }));
}
