import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, collect, int } from "../cli/options";
import { parseBody } from "../lib/body";
import type { Query } from "../okta/client";
import { ExitError } from "../okta/errors";
import { GOV_V1 } from "./governance";
import { defineResource, resourceList, type ResourceSpec } from "./resource";

export const GOV_ENTITLEMENTS: ResourceSpec = {
  name: "entitlements", description: "Entitlements (app-level permission definitions)", path: "/entitlements",
  basePath: GOV_V1, singular: "entitlement", nameField: "name", listKey: "data",
  defaultFields: "id,name,externalValue,dataType,multiValue,required,parentResourceOrn",
  filterRequired: true, limitOption: true, replaceable: true, creatable: true, deletable: true,
  listOptions: [{ flags: "--order-by <expr>", param: "orderBy", description: 'property + " asc"/" desc", e.g. "name asc"' }],
};

export const GOV_ENTITLEMENT_BUNDLES: ResourceSpec = {
  name: "entitlement-bundles", description: "Entitlement bundles (named groups of entitlement values)", path: "/entitlement-bundles",
  basePath: GOV_V1, singular: "entitlement bundle", nameField: "name", listKey: "data",
  defaultFields: "id,name,status,targetResourceOrn,description", limitOption: true,
  listOptions: [
    { flags: "--order-by <expr>", param: "orderBy", description: 'property + " asc"/" desc"' },
    { flags: "--include <what>", param: "include", description: "full_entitlements", choices: ["full_entitlements"] },
  ],
};

// GOV_GRANTS deliberately has no `listOptions` entry for `--include`: the spec's
// `grants-include-param` (unlike entitlement-bundles') accepts two values that must be
// combinable (`full_entitlements` and/or `metadata`), and the generic `ListOption`
// mechanism (resource.ts's `addListOptions`/`lookupQuery`) has no repeat-and-join support -
// a repeated flag just overwrites the previous value. `--include` is registered directly on
// the generated `list` command below instead, with a `collect` argParser, joined with `,`
// into one query parameter per the plan's Background section. TODO(coordinator): the
// comma-joined form is unverified live - confirm against a licensed tenant (runlayer.okta.com)
// before relying on it; widen `Query` (src/okta/client.ts) to accept `string[]` in a follow-up
// if Okta rejects it and expects repeated `include=` instead.
export const GOV_GRANTS: ResourceSpec = {
  name: "grants", description: "Access grants (principal -> resource/entitlement assignments)", path: "/grants",
  basePath: GOV_V1, singular: "grant", nameField: "id", idField: "id", listKey: "data",
  defaultFields: "id,status,grantType,action,targetPrincipalOrn,targetResourceOrn,entitlementBundleId",
  filterRequired: true, limitOption: true, deletable: false, replaceable: true, creatable: true,
};

const VALUE_FIELDS = "id,name,externalValue,entitlementId,parentResourceOrn";

// Builds the `entitlement-patch` array body: verbatim from -b (must be an array), or a
// single-op array from --op/--path/--value/--ref-type. `ENTITLEMENT-VALUE`'s `value` is an
// object (`{name,externalValue,description}`), not a plain string, so per the plan that
// refType requires -b instead of the flag triple.
function entitlementPatchBody(opts: Record<string, any>): unknown {
  if (opts.body !== undefined) {
    const body = parseBody(opts.body);
    if (!Array.isArray(body)) throw new ExitError("The body for this endpoint must be a JSON array of patch operations");
    return body;
  }
  if (opts.refType === "ENTITLEMENT-VALUE") throw new ExitError("Use -b for --ref-type ENTITLEMENT-VALUE (its value is an object, not a plain string)");
  if (!opts.op || !opts.path) throw new ExitError("Provide -b, or --op and --path (with --value)");
  return [{ op: opts.op, path: opts.path, value: opts.value, refType: opts.refType }];
}

export function registerGovernanceEntitlements(g: Command, ctx: Ctx): void {
  const entitlements = defineResource(g, ctx, GOV_ENTITLEMENTS);

  addOutputOptions(addVerbose(entitlements.command("values-all").description("List entitlement values across all entitlements")
    .requiredOption("-f, --filter <expr>", "Okta SCIM filter expression (required by this endpoint)")
    .option("--order-by <expr>", 'property + " asc"/" desc", e.g. "name asc"')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)), VALUE_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = { filter: opts.filter };
      if (opts.orderBy) query.orderBy = opts.orderBy;
      return client.getAll("/entitlements/values", { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(entitlements.command("values").description("List one entitlement's values").argument("<entitlementId>")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--order-by <expr>", 'property + " asc"/" desc"')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)), VALUE_FIELDS)
    .action(action(ctx, (client, opts, entitlementId) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.orderBy) query.orderBy = opts.orderBy;
      return client.getAll(`/entitlements/${encodeURIComponent(entitlementId)}/values`, { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(entitlements.command("value").description("Get one entitlement value").argument("<entitlementId>").argument("<valueId>")), VALUE_FIELDS)
    .action(action(ctx, (client, _opts, entitlementId, valueId) =>
      client.json("GET", `/entitlements/${encodeURIComponent(entitlementId)}/values/${encodeURIComponent(valueId)}`, { basePath: GOV_V1 })));

  addOutputOptions(addVerbose(
    entitlements.command("patch").description("Update an entitlement's name/description or one of its values (JSON-patch-style array; -b for a multi-op array, or --op/--path/--value for one)").argument("<entitlementId>")
      .option("-b, --body <json>", "JSON array of patch operations (entitlement-patch); FILE:<path> reads a file")
      .addOption(new Option("--op <op>", "ADD, REMOVE, or REPLACE").choices(["ADD", "REMOVE", "REPLACE"]))
      .option("--path <p>", 'JSON path, e.g. "/name"/"/description" (ENTITLEMENT), or "/values/-" (ADD) / "/values/{id}" (REMOVE, REPLACE) (ENTITLEMENT-VALUE)')
      .option("--value <v>", "new value; a plain string, only valid when --ref-type is ENTITLEMENT")
      .addOption(new Option("--ref-type <type>", "ENTITLEMENT (default) or ENTITLEMENT-VALUE; ENTITLEMENT-VALUE requires -b").choices(["ENTITLEMENT", "ENTITLEMENT-VALUE"]).default("ENTITLEMENT")),
  ), GOV_ENTITLEMENTS.defaultFields)
    .action(action(ctx, (client, opts, entitlementId) =>
      client.json("PATCH", `/entitlements/${encodeURIComponent(entitlementId)}`, { basePath: GOV_V1, body: entitlementPatchBody(opts) })));

  defineResource(g, ctx, GOV_ENTITLEMENT_BUNDLES);

  const grants = defineResource(g, ctx, GOV_GRANTS);
  grants.commands.find((c) => c.name() === "add")!
    .description("Create a grant (-b and/or -s); grantType is one of ENTITLEMENT-BUNDLE, CUSTOM, POLICY, ENTITLEMENT (each requires different fields per the governance API docs)");

  // See the comment above GOV_GRANTS: the repeatable, comma-joined `--include` can't be
  // expressed through `ResourceSpec.listOptions`, so it's added straight onto the `list`
  // command defineResource already built, and that command's action is replaced with an
  // equivalent that also folds `--include` into the query.
  const grantsList = grants.commands.find((c) => c.name() === "list")!;
  grantsList.addOption(new Option("--include <what>", "full_entitlements and/or metadata (repeatable, comma-joined into one query parameter)")
    .choices(["full_entitlements", "metadata"])
    .argParser(collect)
    .default([]));
  grantsList.action(action(ctx, (client, opts, partial?: string) => {
    const query: Query = {};
    if (opts.filter) query.filter = opts.filter;
    if (opts.query) query.q = opts.query;
    if (opts.include?.length) query.include = opts.include.join(",");
    return resourceList(client, GOV_GRANTS, partial, query, opts.limit);
  }));

  // GET /v1/grants and GET /v1/grants/{id} are `oneOf` (`grants-list`|`grants-list-with-
  // entitlements`, `grant-full`|`grant-full-with-entitlements`) selected by
  // `include=full_entitlements`; the default fields exist in both variants, so no branching
  // is needed here.
  addOutputOptions(addVerbose(bodyOpts(grants.command("patch")
    .description("Update a grant's schedule settings (object body: {id, scheduleSettings}; id defaults to the positional grantId if omitted)")
    .argument("<grantId>"))), GOV_GRANTS.defaultFields)
    .action(action(ctx, (client, opts, grantId) => {
      const body = bodyFromOpts(opts) as Record<string, unknown>;
      if (body.id === undefined) body.id = grantId;
      return client.json("PATCH", `/grants/${encodeURIComponent(grantId)}`, { basePath: GOV_V1, body });
    }));
}
