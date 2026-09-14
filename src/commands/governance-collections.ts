import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, collect, int } from "../cli/options";
import { parseBody } from "../lib/body";
import { deepMerge, isPlainObject } from "../lib/dotted";
import type { Query } from "../okta/client";
import { ExitError } from "../okta/errors";
import { GOV_V1 } from "./governance";
import { defineResource, omitFields, resourceGet, type ResourceSpec } from "./resource";

export const GOV_COLLECTIONS: ResourceSpec = {
  name: "collections", description: "Collections (grouped resources with shared assignments)", path: "/collections",
  basePath: GOV_V1, singular: "collection", nameField: "name", listKey: "data",
  defaultFields: "id,name,description,orn,counts.principalAssignmentCount", limitOption: true,
  // `counts` (collection-counts) only appears when --include counts is passed, so that
  // column is blank otherwise.
  listOptions: [{ flags: "--include <what>", param: "include", description: "counts (populates the counts.* columns; blank otherwise)", choices: ["counts"] }],
};

const ASSIGNMENT_FIELDS = "id,assignmentType,collectionId,expirationTime,timeZone,principalProfile.email,principalProfile.status";
const RESOURCE_FIELDS = "resourceId,resourceOrn,resourceProfile.name,entitlementValueCount";

// Builds a POST body that's a bare array of `itemLabel` objects: -b passes an array through
// verbatim (rejected if it isn't one); with only -s, the single object `bodyFromOpts` builds
// from the dotted assignments is wrapped in a one-element array. Mirrors `entitlementPatchBody`
// in governance-entitlements.ts, adapted for a create body shaped as a bare array instead of a
// JSON-patch array.
function arrayBodyFromOpts(opts: Record<string, any>, itemLabel: string): unknown[] {
  if (opts.body !== undefined) {
    const body = parseBody(opts.body);
    if (!Array.isArray(body)) throw new ExitError(`The body for this endpoint must be a JSON array of ${itemLabel}`);
    return body;
  }
  return [bodyFromOpts(opts)];
}

// Builds the `assignment-patch` array body (no `refType`, unlike `entitlement-patch`/`patch-labels`).
function assignmentPatchBody(opts: Record<string, any>): unknown {
  if (opts.body !== undefined) {
    const body = parseBody(opts.body);
    if (!Array.isArray(body)) throw new ExitError("The body for this endpoint must be a JSON array of patch operations");
    return body;
  }
  if (!opts.op || !opts.path) throw new ExitError("Provide -b, or --op and --path (with --value)");
  return [{ op: opts.op, path: opts.path, value: opts.value }];
}

export function registerGovernanceCollections(g: Command, ctx: Ctx): void {
  const collections = defineResource(g, ctx, GOV_COLLECTIONS);

  addOutputOptions(addVerbose(collections.command("assignments-all").description("List assignments across all collections (org-wide, no collection argument)")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  ASSIGNMENT_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      return client.getAll("/collections/assignments", { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(collections.command("assignments").description("List assignments for one collection").argument("<collection>")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  ASSIGNMENT_FIELDS)
    .action(action(ctx, async (client, opts, collectionArg) => {
      const collection = await resourceGet(client, GOV_COLLECTIONS, collectionArg);
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      return client.getAll(`/collections/${collection.id}/assignments`, { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(bodyOpts(collections.command("assignment-add").description("Assign a collection to one or more principals (-b for a multi-item array, or -s for one)").argument("<collection>"))),
  ASSIGNMENT_FIELDS)
    .action(action(ctx, async (client, opts, collectionArg) => {
      const collection = await resourceGet(client, GOV_COLLECTIONS, collectionArg);
      const body = arrayBodyFromOpts(opts, "assigned principals (assigned-principal)");
      return client.json("POST", `/collections/${collection.id}/assignments`, { basePath: GOV_V1, body });
    }));

  addVerbose(
    collections.command("assignment-update").description("Update a collection assignment (JSON-patch-style array; -b for a multi-op array, or --op/--path/--value for one)")
      .argument("<collection>").argument("<assignmentId>")
      .option("-b, --body <json>", "JSON array of patch operations (assignment-patch, 1-100 items); FILE:<path> reads a file")
      .addOption(new Option("--op <op>", "ADD, REMOVE, or REPLACE").choices(["ADD", "REMOVE", "REPLACE"]))
      .option("--path <p>", 'JSON path, e.g. "/expirationTime" or "/timeZone"')
      .option("--value <v>", "new value"),
  )
    .action(action(ctx, async (client, opts, collectionArg, assignmentId) => {
      const collection = await resourceGet(client, GOV_COLLECTIONS, collectionArg);
      await client.json("PATCH", `/collections/${collection.id}/assignments/${encodeURIComponent(assignmentId)}`, { basePath: GOV_V1, body: assignmentPatchBody(opts) });
      return `assignment ${assignmentId} updated`;
    }));

  addVerbose(collections.command("assignment-delete").description("Delete a collection assignment").argument("<collection>").argument("<assignmentId>"))
    .action(action(ctx, async (client, _opts, collectionArg, assignmentId) => {
      const collection = await resourceGet(client, GOV_COLLECTIONS, collectionArg);
      await client.json("DELETE", `/collections/${collection.id}/assignments/${encodeURIComponent(assignmentId)}`, { basePath: GOV_V1 });
      return `assignment ${assignmentId} deleted`;
    }));

  // Declares only `filter` (no `limit`/`after`), so no --limit option here - still use getAll,
  // which is harmless (_links.next simply never appears).
  addOutputOptions(addVerbose(collections.command("catalog-users").description("List users assignable to a collection (no --limit: this endpoint declares only filter)").argument("<collection>")
    .option("-f, --filter <expr>", "Okta filter expression")),
  "id,email,firstName,lastName,login,status")
    .action(action(ctx, async (client, opts, collectionArg) => {
      const collection = await resourceGet(client, GOV_COLLECTIONS, collectionArg);
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      return client.getAll(`/collections/${collection.id}/catalog/users`, { basePath: GOV_V1, listKey: "data", query });
    }));

  addOutputOptions(addVerbose(collections.command("resources").description("List resources in a collection").argument("<collection>")
    .addOption(new Option("--include <what>", "entitlements and/or entitlementValueCount (repeatable, comma-joined into one query parameter)").choices(["entitlements", "entitlementValueCount"]).argParser(collect).default([]))
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  RESOURCE_FIELDS)
    .action(action(ctx, async (client, opts, collectionArg) => {
      const collection = await resourceGet(client, GOV_COLLECTIONS, collectionArg);
      const query: Query = {};
      if (opts.include?.length) query.include = opts.include.join(",");
      return client.getAll(`/collections/${collection.id}/resources`, { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(bodyOpts(collections.command("resource-add").description("Add one or more resources to a collection (-b for a multi-item array, or -s for one)").argument("<collection>"))),
  RESOURCE_FIELDS)
    .action(action(ctx, async (client, opts, collectionArg) => {
      const collection = await resourceGet(client, GOV_COLLECTIONS, collectionArg);
      const body = arrayBodyFromOpts(opts, "collection resources (collection-resource-creatable)");
      const rv = await client.json("POST", `/collections/${collection.id}/resources`, { basePath: GOV_V1, body });
      return rv.data;
    }));

  addOutputOptions(addVerbose(collections.command("resource").description("Get one collection resource").argument("<collection>").argument("<resourceId>")),
  RESOURCE_FIELDS)
    .action(action(ctx, async (client, _opts, collectionArg, resourceId) => {
      const collection = await resourceGet(client, GOV_COLLECTIONS, collectionArg);
      return client.json("GET", `/collections/${collection.id}/resources/${encodeURIComponent(resourceId)}`, { basePath: GOV_V1 });
    }));

  addOutputOptions(addVerbose(bodyOpts(collections.command("resource-replace").description("Replace (PUT) a collection resource; with only -s the current object is fetched and merged").argument("<collection>").argument("<resourceId>"))),
  RESOURCE_FIELDS)
    .action(action(ctx, async (client, opts, collectionArg, resourceId) => {
      const collection = await resourceGet(client, GOV_COLLECTIONS, collectionArg);
      let body = bodyFromOpts(opts);
      if (!opts.body && isPlainObject(body)) {
        const existing = await client.json("GET", `/collections/${collection.id}/resources/${encodeURIComponent(resourceId)}`, { basePath: GOV_V1 });
        body = deepMerge(omitFields(existing, ["_links", "resourceId", "resourceOrn"]), body as Record<string, unknown>);
      }
      return client.json("PUT", `/collections/${collection.id}/resources/${encodeURIComponent(resourceId)}`, { basePath: GOV_V1, body });
    }));

  addVerbose(collections.command("resource-delete").description("Remove a resource from a collection").argument("<collection>").argument("<resourceId>"))
    .action(action(ctx, async (client, _opts, collectionArg, resourceId) => {
      const collection = await resourceGet(client, GOV_COLLECTIONS, collectionArg);
      await client.json("DELETE", `/collections/${collection.id}/resources/${encodeURIComponent(resourceId)}`, { basePath: GOV_V1 });
      return `resource ${resourceId} removed from collection ${collection.id}`;
    }));
}
