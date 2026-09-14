import { type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, int, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import type { Query } from "../okta/client";
import { ExitError } from "../okta/errors";
import { GOV_V1, GOV_V2 } from "./governance";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

export const GOV_REQUEST_TYPES: ResourceSpec = {
  name: "request-types", description: "Access request types (request templates)", path: "/request-types",
  basePath: GOV_V1, singular: "request type", nameField: "name", listKey: "data",
  defaultFields: "id,status,name,description,lastUpdated", limitOption: true, replaceable: false, // no PUT/PATCH on /request-types/{id}
  listOptions: [{ flags: "--order-by <expr>", param: "orderBy", description: 'property + " asc"/" desc"' }],
};

// See "Resolved ambiguities" #1 in the plan: v1 request-sparse and v2 request-sparse-2 differ
// materially (v2 drops requestTypeId/subject/permalinkId and adds the grant/revocation
// lifecycle), so both APIs ship as separate subgroups - `requests` is v2 (current surface),
// `requests-v1` is the superseded v1 surface.
const REQUEST_V2_FIELDS = "id,status,grantStatus,revocationStatus,created,resolved,requestedFor.externalId,requested.entryId";
const REQUEST_V1_FIELDS = "id,requestStatus,type,subject,requestTypeId,created,resolved";
const ENTRY_FIELDS = "id,name,label,parent,description";
const REQUEST_FIELD_FIELDS = "id,label,type,required,readOnly,value";

// Builds a request-message-creatable body ({message}): verbatim from -b (rejecting it
// alongside --message, since the two ways of building the body would otherwise silently
// race - same rule as campaigns.ts's reassignBody), or {message: opts.message}.
function messageBody(opts: Record<string, any>): unknown {
  if (opts.body !== undefined) {
    if (opts.message !== undefined) throw new ExitError("Use either -b or --message");
    return parseBody(opts.body);
  }
  if (!opts.message) throw new ExitError("Provide -b, or --message");
  return { message: opts.message };
}

export function registerGovernanceRequests(g: Command, ctx: Ctx): void {
  const requestTypes = defineResource(g, ctx, GOV_REQUEST_TYPES);
  requestTypes.commands.find((c) => c.name() === "add")!
    .description("Create a request type (-b and/or -s); required: name, ownerId, resourceSettings, approvalSettings");

  addOutputOptions(addVerbose(requestTypes.command("publish").description("Publish a request type (makes it requestable)").argument("<request-type>")), GOV_REQUEST_TYPES.defaultFields)
    .action(action(ctx, async (client, _opts, arg) => {
      const rt = await resourceGet(client, GOV_REQUEST_TYPES, arg);
      return client.json("POST", `/request-types/${encodeURIComponent(rt.id)}/publish`, { basePath: GOV_V1 });
    }));

  addOutputOptions(addVerbose(requestTypes.command("unpublish").description("Unpublish a request type (note: the path is /un-publish, hyphenated)").argument("<request-type>")), GOV_REQUEST_TYPES.defaultFields)
    .action(action(ctx, async (client, _opts, arg) => {
      const rt = await resourceGet(client, GOV_REQUEST_TYPES, arg);
      return client.json("POST", `/request-types/${encodeURIComponent(rt.id)}/un-publish`, { basePath: GOV_V1 });
    }));

  // `requests` - v2 (current surface). See "Resolved ambiguities" #1.
  const requests = subgroup(g, "requests", "Access requests (v2 API; use requests-v1 for the superseded v1 surface)");

  addOutputOptions(addVerbose(requests.command("list").description("List access requests (v2)")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--order-by <expr>", 'property + " asc"/" desc"')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  REQUEST_V2_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.orderBy) query.orderBy = opts.orderBy;
      return client.getAll("/requests", { basePath: GOV_V2, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(requests.command("get").description("Get one access request by id (v2)").argument("<requestId>")), REQUEST_V2_FIELDS)
    .action(action(ctx, (client, _opts, requestId) => client.json("GET", `/requests/${encodeURIComponent(requestId)}`, { basePath: GOV_V2 })));

  addOutputOptions(addVerbose(bodyOpts(requests.command("add").description("Create an access request (v2; -b and/or -s); required: requested, requestedFor; 202 async"))),
  REQUEST_V2_FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/requests", { basePath: GOV_V2, body: bodyFromOpts(opts) })));

  addVerbose(requests.command("message").description("Post a message to an access request (v2)").argument("<requestId>")
    .option("-b, --body <json>", "JSON body (request-message-creatable); FILE:<path> reads a file; mutually exclusive with --message")
    .option("--message <text>", 'message text (newlines as "\\n")'))
    .action(action(ctx, async (client, opts, requestId) => {
      await client.json("POST", `/requests/${encodeURIComponent(requestId)}/messages`, { basePath: GOV_V2, body: messageBody(opts) });
      return `message posted to request ${requestId}`;
    }));

  // `requests-v1` - superseded v1 surface. See "Resolved ambiguities" #1.
  const requestsV1 = subgroup(g, "requests-v1", "Access requests (v1 API; superseded by 'requests')");

  addOutputOptions(addVerbose(requestsV1.command("list").description("List access requests (v1)")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--order-by <expr>", 'property + " asc"/" desc"')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  REQUEST_V1_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.orderBy) query.orderBy = opts.orderBy;
      return client.getAll("/requests", { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(requestsV1.command("get").description("Get one access request by id (v1)").argument("<requestId>")), REQUEST_V1_FIELDS)
    .action(action(ctx, (client, _opts, requestId) => client.json("GET", `/requests/${encodeURIComponent(requestId)}`, { basePath: GOV_V1 })));

  addOutputOptions(addVerbose(bodyOpts(requestsV1.command("add").description("Create an access request (v1; -b and/or -s); required: requestTypeId, subject"))),
  REQUEST_V1_FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/requests", { basePath: GOV_V1, body: bodyFromOpts(opts) })));

  addVerbose(requestsV1.command("message").description("Post a message to an access request (v1)").argument("<requestId>")
    .option("-b, --body <json>", "JSON body (request-message-creatable); FILE:<path> reads a file; mutually exclusive with --message")
    .option("--message <text>", 'message text (newlines as "\\n")'))
    .action(action(ctx, async (client, opts, requestId) => {
      await client.json("POST", `/requests/${encodeURIComponent(requestId)}/messages`, { basePath: GOV_V1, body: messageBody(opts) });
      return `message posted to request ${requestId}`;
    }));

  // `catalog` - v2 request catalog. `entries`/`user-entries` require `-f/--filter`: the spec's
  // filter only supports the `parent` property (`eq`/`pr`) and undocumented results follow if
  // it's omitted or doesn't reference `parent` - confirmed live-shaped in gov-schema.d.ts
  // ("listAllDefaultEntriesV2"/"listAllDefaultUserEntriesV2": filter is a required query param).
  const catalog = subgroup(g, "catalog", "Request catalog entries (v2)");

  addOutputOptions(addVerbose(catalog.command("entries").description("List catalog entries (filter must reference the parent property, e.g. \"not(parent pr)\" for top-level entries)")
    .requiredOption("-f, --filter <expr>", "Okta filter expression (required; must reference parent)")
    .option("--match <text>", "fuzzy-match entries by name/description (3-50 chars)")
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  ENTRY_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = { filter: opts.filter };
      if (opts.match) query.match = opts.match;
      return client.getAll("/catalogs/default/entries", { basePath: GOV_V2, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(catalog.command("entry").description("Get one catalog entry").argument("<entryId>")), ENTRY_FIELDS)
    .action(action(ctx, (client, _opts, entryId) => client.json("GET", `/catalogs/default/entries/${encodeURIComponent(entryId)}`, { basePath: GOV_V2 })));

  addOutputOptions(addVerbose(catalog.command("user-entries").description("List catalog entries requestable by a user (filter must reference the parent property)")
    .argument("<userId>")
    .requiredOption("-f, --filter <expr>", "Okta filter expression (required; must reference parent)")
    .option("--match <text>", "fuzzy-match entries by name/description (3-50 chars)")
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  ENTRY_FIELDS)
    .action(action(ctx, (client, opts, userId) => {
      const query: Query = { filter: opts.filter };
      if (opts.match) query.match = opts.match;
      return client.getAll(`/catalogs/default/user/${encodeURIComponent(userId)}/entries`, { basePath: GOV_V2, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(catalog.command("request-fields").description("List the request fields for a catalog entry, as evaluated for a specific user (metadata.riskAssessment is dropped by the table - use -j)")
    .argument("<entryId>").argument("<userId>")),
  REQUEST_FIELD_FIELDS)
    .action(action(ctx, (client, _opts, entryId, userId) =>
      client.getAll(`/catalogs/default/entries/${encodeURIComponent(entryId)}/users/${encodeURIComponent(userId)}/request-fields`, { basePath: GOV_V2, listKey: "data" })));
}
