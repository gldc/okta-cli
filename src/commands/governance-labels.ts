import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, collect, int, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import type { Query } from "../okta/client";
import { ExitError } from "../okta/errors";
import { GOV_V1 } from "./governance";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

export const GOV_LABELS: ResourceSpec = {
  name: "labels", description: "Governance label categories and their values (v1)", path: "/labels",
  basePath: GOV_V1, singular: "label", nameField: "name", idField: "labelId", listKey: "data",
  defaultFields: "labelId,name,values", replaceable: false, queryOption: false, // PATCH only, no PUT
  // GET /v1/labels declares only `filter` - it 400s on `limit` ("Query parameter limit is
  // unexpected"), so no limitOption here even though every other list in this release has one.
};

// Builds the `patch-labels` array body: -b passes a multi-op array through verbatim; the
// --op/--path/--value/--ref-type triple builds a single-op array. LABEL-VALUE's `value` is an
// object (label-value-update), not a plain string, so that refType requires -b instead.
function labelPatchBody(opts: Record<string, any>): unknown {
  if (opts.body !== undefined) {
    const body = parseBody(opts.body);
    if (!Array.isArray(body)) throw new ExitError("The body for this endpoint must be a JSON array of patch operations");
    return body;
  }
  if (opts.refType === "LABEL-VALUE") throw new ExitError("Use -b for --ref-type LABEL-VALUE (its value is an object, not a plain string)");
  if (!opts.op || !opts.path) throw new ExitError("Provide -b, or --op and --path (with --value)");
  return [{ op: opts.op, path: opts.path, value: opts.value, refType: opts.refType }];
}

// Builds the `assign-resource-labels` body shared by `resource-labels assign`/`unassign`: -b
// passes the object through verbatim (validated: both fields must be non-empty arrays, so a
// short -b fails fast here instead of as a TypeError later, e.g. `unassign`'s
// `body.resourceOrns.length` in its result message); otherwise both --resource and
// --label-value (each repeatable) are required (the schema requires both fields).
function resourceLabelsBody(opts: Record<string, any>): { resourceOrns: string[]; labelValueIds: string[] } {
  if (opts.body !== undefined) {
    const body = parseBody(opts.body) as { resourceOrns?: string[]; labelValueIds?: string[] };
    if (!body.resourceOrns?.length || !body.labelValueIds?.length) throw new ExitError("Body must have non-empty resourceOrns and labelValueIds arrays (assign-resource-labels)");
    return body as { resourceOrns: string[]; labelValueIds: string[] };
  }
  const resourceOrns = (opts.resource as string[] | undefined) ?? [];
  const labelValueIds = (opts.labelValue as string[] | undefined) ?? [];
  if (!resourceOrns.length || !labelValueIds.length) throw new ExitError("Provide -b, or --resource and --label-value (both repeatable)");
  return { resourceOrns, labelValueIds };
}

export function registerGovernanceLabels(g: Command, ctx: Ctx): void {
  const labels = defineResource(g, ctx, GOV_LABELS);

  addOutputOptions(addVerbose(
    labels.command("update").description("Update a label's name (LABEL-CATEGORY) or one of its values (LABEL-VALUE); -b for a multi-op array, or --op/--path/--value for one")
      .argument("<label>")
      .option("-b, --body <json>", "JSON array of patch operations (patch-labels, 1-10 items); FILE:<path> reads a file")
      .addOption(new Option("--op <op>", "ADD, REMOVE, or REPLACE").choices(["ADD", "REMOVE", "REPLACE"]))
      .option("--path <p>", 'JSON path, e.g. "/name" (LABEL-CATEGORY), or "/values/-" (ADD) / "/values/{id}" (REMOVE, REPLACE) (LABEL-VALUE)')
      .option("--value <v>", "new value; a plain string, only valid when --ref-type is LABEL-CATEGORY")
      .addOption(new Option("--ref-type <type>", "LABEL-CATEGORY (default) or LABEL-VALUE; LABEL-VALUE requires -b").choices(["LABEL-CATEGORY", "LABEL-VALUE"]).default("LABEL-CATEGORY")),
  ), GOV_LABELS.defaultFields)
    .action(action(ctx, async (client, opts, label) => {
      // Validate before resolving the name-or-id (like resourceGet's other callers) so a bad
      // -b/--op/--path/--ref-type combination fails without an extra network round-trip.
      const body = labelPatchBody(opts);
      const existing = await resourceGet(client, GOV_LABELS, label);
      return client.json("PATCH", `/labels/${encodeURIComponent(existing.labelId)}`, { basePath: GOV_V1, body });
    }));

  const resourceLabels = subgroup(g, "resource-labels", "Labels assigned to resources (v1)");
  const RESOURCE_LABEL_FIELDS = "orn,profile.name,profile.id,labels";

  addOutputOptions(addVerbose(resourceLabels.command("list").description("List resources and their assigned labels")
    .requiredOption("-f, --filter <expr>", "Okta filter expression (required by this endpoint; the orn is validated server-side)")
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  RESOURCE_LABEL_FIELDS)
    .action(action(ctx, (client, opts) => client.getAll("/resource-labels", { basePath: GOV_V1, listKey: "data", query: { filter: opts.filter }, max: opts.limit })));

  addOutputOptions(addVerbose(resourceLabels.command("assign").description("Assign label values to resources (assign-resource-labels: resourceOrns and labelValueIds are both required)")
    .option("--resource <orn>", "resource ORN (repeatable)", collect, [])
    .option("--label-value <id>", "label value id (repeatable)", collect, [])
    .option("-b, --body <json>", "JSON body (assign-resource-labels); FILE:<path> reads a file; overrides --resource/--label-value")),
  RESOURCE_LABEL_FIELDS)
    .action(action(ctx, async (client, opts) => {
      const rv = await client.json("POST", "/resource-labels/assign", { basePath: GOV_V1, body: resourceLabelsBody(opts) });
      return rv.data;
    }));

  addVerbose(resourceLabels.command("unassign").description("Unassign label values from resources")
    .option("--resource <orn>", "resource ORN (repeatable)", collect, [])
    .option("--label-value <id>", "label value id (repeatable)", collect, [])
    .option("-b, --body <json>", "JSON body (assign-resource-labels); FILE:<path> reads a file; overrides --resource/--label-value"))
    .action(action(ctx, async (client, opts) => {
      const body = resourceLabelsBody(opts);
      await client.json("POST", "/resource-labels/unassign", { basePath: GOV_V1, body });
      return `labels unassigned from ${body.resourceOrns.length} resource(s)`;
    }));

  const resourceOwners = subgroup(g, "resource-owners", "Resource owners (principals responsible for a resource) (v1)");

  addOutputOptions(addVerbose(resourceOwners.command("list").description("List resources and their owners")
    .requiredOption("-f, --filter <expr>", "Okta filter expression (required by this endpoint)")
    .addOption(new Option("--include <what>", "parent_resource_owner").choices(["parent_resource_owner"]))
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  "parentResourceOrn,resource.orn,resource.type,principals")
    .action(action(ctx, (client, opts) => {
      const query: Query = { filter: opts.filter };
      if (opts.include) query.include = opts.include;
      return client.getAll("/resource-owners", { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(bodyOpts(resourceOwners.command("set").description("Configure (upsert) the owners of one or more resources (resource-owners-updatable: resourceOrns required; principalOrns omitted/empty clears current owners)"))),
  "parentResourceOrn,resource.orn,resource.type,principals")
    .action(action(ctx, async (client, opts) => {
      const rv = await client.json("POST", "/resource-owners", { basePath: GOV_V1, body: bodyFromOpts(opts) });
      return rv.data;
    }));

  addVerbose(resourceOwners.command("remove").description("Remove one or more principals as owners of a resource")
    .option("-b, --body <json>", "JSON body (resource-owners-patch); FILE:<path> reads a file; overrides --resource/--principal")
    .option("--resource <orn>", "resource ORN")
    .option("--principal <orn>", "principal ORN to remove as owner (repeatable, max 5)", collect, []))
    .action(action(ctx, async (client, opts) => {
      let body: Record<string, unknown>;
      if (opts.body !== undefined) {
        body = parseBody(opts.body) as Record<string, unknown>;
        // Otherwise a short -b silently sends a bad PATCH and the result message below prints
        // the literal string "undefined" instead of failing.
        if (typeof body.resourceOrn !== "string") throw new ExitError("Body must have a resourceOrn string field (resource-owners-patch)");
      } else {
        const principals = (opts.principal as string[] | undefined) ?? [];
        if (!opts.resource || !principals.length) throw new ExitError("Provide -b, or --resource and --principal (repeatable)");
        if (principals.length > 5) throw new ExitError("At most 5 --principal values (resource-owners-patch allows a maximum of 5 ops)");
        body = { resourceOrn: opts.resource, data: principals.map((p) => ({ op: "REMOVE", path: "/principalOrn", value: p })) };
      }
      await client.json("PATCH", "/resource-owners", { basePath: GOV_V1, body });
      return `owner(s) removed from ${body.resourceOrn}`;
    }));

  // The envelope also carries a top-level parentResourceOrn, which getAll drops from the
  // printed array - use -j on a single-resourceType filter if you need it.
  addOutputOptions(addVerbose(resourceOwners.command("catalog-resources").description("List resources without an assigned owner (envelope's top-level parentResourceOrn is dropped; use -j to inspect the raw response if needed)")
    .requiredOption("-f, --filter <expr>", "Okta filter expression (required by this endpoint)")
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  "id,type,orn,profile.name")
    .action(action(ctx, (client, opts) => client.getAll("/resource-owners/catalog/resources", { basePath: GOV_V1, listKey: "data", query: { filter: opts.filter }, max: opts.limit })));
}
