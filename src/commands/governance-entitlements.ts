import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, collect, int } from "../cli/options";
import { parseBody } from "../lib/body";
import { isPlainObject } from "../lib/dotted";
import type { OktaClient, Query } from "../okta/client";
import { ExitError } from "../okta/errors";
import { GOV_V1 } from "./governance";
import { defineResource, resourceList, type ResourceSpec } from "./resource";

// `entitlement-updatable` (the PUT body schema) requires `id`, but `defineResource`'s replace
// merge base strips every field in REPLACE_OMIT_DEFAULT (including `id`) before merging in -s/-b.
// Re-add it from the fetched object, same fix as GOV_ENTITLEMENT_BUNDLES below.
async function entitlementReplaceBody(_client: OktaClient, existing: any, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { ...body, id: existing.id };
}

export const GOV_ENTITLEMENTS: ResourceSpec = {
  name: "entitlements", description: "Entitlements (app-level permission definitions) (v1)", path: "/entitlements",
  basePath: GOV_V1, singular: "entitlement", nameField: "name", listKey: "data",
  defaultFields: "id,name,externalValue,dataType,multiValue,required,parentResourceOrn",
  filterRequired: true, limitOption: true, queryOption: false, replaceable: true, creatable: true, deletable: true,
  listOptions: [{ flags: "--order-by <expr>", param: "orderBy", description: 'property + " asc"/" desc", e.g. "name asc"' }],
  beforeReplace: entitlementReplaceBody,
};

// `entitlement-bundle-updatable` (the PUT body schema) requires `id`, `targetResourceOrn`, and
// `target` - all stripped from (or never merged into) the replace body by defineResource's
// default merge base / omit list. Re-add them from the fetched object.
// entitlement-bundle-updatable requires id, targetResourceOrn, target AND a non-empty
// entitlements list, but a plain GET of a bundle omits `entitlements` (only
// `?include=full_entitlements` returns them) - so a -s-only replace must re-fetch them and
// reduce to the writable `{ id, values: [{ id }] }` shape, or Okta answers "Bundle can not be
// created or updated with an empty entitlement(s)" (seen live).
async function entitlementBundleReplaceBody(client: OktaClient, existing: any, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let entitlements = body.entitlements;
  if (!Array.isArray(entitlements) || entitlements.length === 0) {
    const full = await client.json("GET", `/entitlement-bundles/${encodeURIComponent(existing.id)}`, { basePath: GOV_V1, query: { include: "full_entitlements" } });
    entitlements = ((full.entitlements ?? []) as any[]).map((e) => ({ id: e.id, values: ((e.values ?? []) as any[]).map((v) => ({ id: v.id })) }));
  }
  return { ...body, id: existing.id, targetResourceOrn: existing.targetResourceOrn, target: existing.target, entitlements };
}

export const GOV_ENTITLEMENT_BUNDLES: ResourceSpec = {
  name: "entitlement-bundles", description: "Entitlement bundles (named groups of entitlement values) (v1)", path: "/entitlement-bundles",
  basePath: GOV_V1, singular: "entitlement bundle", nameField: "name", listKey: "data",
  defaultFields: "id,name,status,targetResourceOrn,description", limitOption: true, queryOption: false,
  listOptions: [
    { flags: "--order-by <expr>", param: "orderBy", description: 'property + " asc"/" desc"' },
    { flags: "--include <what>", param: "include", description: "full_entitlements", choices: ["full_entitlements"] },
  ],
  beforeReplace: entitlementBundleReplaceBody,
};

// GOV_GRANTS deliberately has no `listOptions` entry for `--include`: the spec's
// `grants-include-param` (unlike entitlement-bundles') accepts two combinable values
// (`full_entitlements` and/or `metadata`), and the generic `ListOption` mechanism
// (resource.ts's `addListOptions`/`lookupQuery`) has no repeat-and-collect support - a
// repeated flag just overwrites the previous value. `--include` is registered directly on
// the generated `list` command below instead, with a `collect` argParser, and the collected
// array is passed straight through as `Query.include` (buildUrl appends one `include=` per
// element). Verified live against runlayer.okta.com: the comma-joined form 400s (`Query param
// enum ("full_entitlements,metadata") is not valid`); the repeated-param form
// (`include=full_entitlements&include=metadata`) returns 200.
export const GOV_GRANTS: ResourceSpec = {
  name: "grants", description: "Access grants (principal -> resource/entitlement assignments) (v1)", path: "/grants",
  basePath: GOV_V1, singular: "grant", nameField: "id", idField: "id", listKey: "data",
  // `entitlementBundleId` only exists on ENTITLEMENT-BUNDLE grants - dropped from the default
  // columns (live: prints a "field ... never filled or non-existant" WARNING for every
  // CUSTOM/ENTITLEMENT grant otherwise). Still visible with -j.
  defaultFields: "id,status,grantType,action,targetPrincipalOrn,targetResourceOrn",
  filterRequired: true, limitOption: true, queryOption: false, deletable: false, replaceable: true, creatable: true,
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

  // See the comment above GOV_GRANTS: the repeatable `--include` can't be expressed through
  // `ResourceSpec.listOptions`, so it's added straight onto the `list` command defineResource
  // already built, and that command's action is replaced with an equivalent that also folds
  // `--include` into the query as an array (one `include=` query param per element).
  const grantsList = grants.commands.find((c) => c.name() === "list")!;
  grantsList.addOption(new Option("--include <what>", "full_entitlements and/or metadata (repeatable)")
    .choices(["full_entitlements", "metadata"])
    .argParser(collect)
    .default([]));
  grantsList.action(action(ctx, (client, opts, partial?: string) => {
    const query: Query = {};
    if (opts.filter) query.filter = opts.filter;
    if (opts.include?.length) query.include = opts.include;
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
      const body = bodyFromOpts(opts);
      if (!isPlainObject(body)) throw new ExitError("grants patch body must be a JSON object");
      if (body.id === undefined) body.id = grantId;
      return client.json("PATCH", `/grants/${encodeURIComponent(grantId)}`, { basePath: GOV_V1, body });
    }));
}
