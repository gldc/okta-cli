import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, int, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import type { Query } from "../okta/client";
import { ExitError } from "../okta/errors";
import { GOV_V1 } from "./governance";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

export const GOV_CAMPAIGNS: ResourceSpec = {
  name: "campaigns", description: "Access certification campaigns (v1)", path: "/campaigns",
  basePath: GOV_V1, singular: "campaign", nameField: "name", listKey: "data",
  defaultFields: "id,status,name,scheduleType,startDate,endDate,reviewerType",
  limitOption: true, queryOption: false, replaceable: false, // no PUT/PATCH on /campaigns/{id}
  listOptions: [{ flags: "--order-by <expr>", param: "orderBy", description: 'property + " asc"/" desc", e.g. "created desc"' }],
};

// The list item (campaign-sparse) carries scheduleType/startDate/endDate/reviewerType, but the
// get/add representation (campaign-full) nests those under scheduleSettings/reviewerSettings
// and adds campaignType instead (gov-schema.d.ts "campaign-details-read-only", grepped
// 2026-09-14) - confirmed against the spec, matching the plan exactly. Those four columns
// render blank on `get`; `-j` shows the real (nested) shape. Default fields follow the repo
// convention of matching the *list* response - do not "fix" this with dotted fields that only
// exist on one side.
export const REVIEW_FIELDS = "id,campaignId,resourceId,decision,decided,remediationStatus,reviewerType,principalProfile.email,reviewerProfile.email";

// Builds the `reviews-reassign` body: verbatim from -b (rejecting it alongside any of the
// flags, since the two ways of building the body would otherwise silently race), or the
// object built from --reviewer/--review/--note/--reviewer-level (reviewerId, reviewIds, note
// all required by the schema).
function reassignBody(opts: Record<string, any>): unknown {
  const hasFlags = opts.reviewer !== undefined || (opts.review as string[] | undefined)?.length || opts.note !== undefined;
  if (opts.body !== undefined) {
    if (hasFlags) throw new ExitError("Use either -b or --reviewer/--review/--note");
    return parseBody(opts.body);
  }
  if (!opts.reviewer || !(opts.review as string[] | undefined)?.length || !opts.note) throw new ExitError("Provide -b, or --reviewer, --review (repeatable), and --note");
  const body: Record<string, unknown> = { reviewerId: opts.reviewer, reviewIds: opts.review, note: opts.note };
  if (opts.reviewerLevel) body.reviewerLevel = opts.reviewerLevel;
  return body;
}

export function registerGovernanceCampaigns(g: Command, ctx: Ctx): void {
  const campaigns = defineResource(g, ctx, GOV_CAMPAIGNS);

  addVerbose(campaigns.command("launch").description("Launch a campaign (202 async; poll gov operations get with the returned operation id)").argument("<campaign>"))
    .action(action(ctx, async (client, _opts, campaignArg) => {
      const campaign = await resourceGet(client, GOV_CAMPAIGNS, campaignArg);
      await client.json("POST", `/campaigns/${campaign.id}/launch`, { basePath: GOV_V1 });
      return `campaign ${campaign.id} (${campaign.name}) launched`;
    }));

  addVerbose(campaigns.command("end").description("End a campaign (202 async; poll gov operations get with the returned operation id)").argument("<campaign>")
    .option("--skip-remediation", "skip remediation in cases where remediationSetting.noResponse=DENY"))
    .action(action(ctx, async (client, opts, campaignArg) => {
      const campaign = await resourceGet(client, GOV_CAMPAIGNS, campaignArg);
      const body = opts.skipRemediation ? { skipRemediation: true } : undefined;
      await client.json("POST", `/campaigns/${campaign.id}/end`, { basePath: GOV_V1, body });
      return `campaign ${campaign.id} (${campaign.name}) ended`;
    }));

  addOutputOptions(addVerbose(campaigns.command("reviews-reassign").description("Reassign one or more campaign reviews to a new reviewer")
    .argument("<campaign>")
    .option("-b, --body <json>", "JSON body (reviews-reassign); FILE:<path> reads a file; mutually exclusive with --reviewer/--review/--note")
    .option("--reviewer <userId>", "Okta user id of the new reviewer")
    .option("--review <reviewId>", "review id to reassign (repeatable)", collect, [])
    .option("--note <text>", "note justifying the reassignment decision")
    .addOption(new Option("--reviewer-level <level>", "FIRST or SECOND; multi-level campaigns only").choices(["FIRST", "SECOND"]))),
  REVIEW_FIELDS)
    .action(action(ctx, async (client, opts, campaignArg) => {
      const campaign = await resourceGet(client, GOV_CAMPAIGNS, campaignArg);
      const body = reassignBody(opts);
      const rv = await client.json("POST", `/campaigns/${campaign.id}/reviews/reassign`, { basePath: GOV_V1, body });
      return rv.data;
    }));

  addOutputOptions(addVerbose(campaigns.command("reviews").description("List reviews for a campaign (convenience wrapper over the standalone 'gov reviews' group with campaignId prefilled)")
    .argument("<campaign>")
    .option("-f, --filter <expr>", 'additional Okta filter expression, AND-ed with campaignId eq "<id>"')
    .option("--order-by <expr>", 'property + " asc"/" desc"')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  REVIEW_FIELDS)
    .action(action(ctx, async (client, opts, campaignArg) => {
      const campaign = await resourceGet(client, GOV_CAMPAIGNS, campaignArg);
      const campaignFilter = `campaignId eq "${campaign.id}"`;
      const query: Query = { filter: opts.filter ? `(${opts.filter}) AND ${campaignFilter}` : campaignFilter };
      if (opts.orderBy) query.orderBy = opts.orderBy;
      return client.getAll("/reviews", { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  // Standalone reviews subgroup: `gov reviews …` is the plain /v1/reviews (campaign reviews)
  // endpoint, distinct from `gov campaigns reviews <campaign>` above (same endpoint, campaignId
  // prefilled) and from the unrelated v2 `gov security-access-reviews` family (Task 7).
  const reviews = subgroup(g, "reviews", "Campaign reviews (certification decisions) (v1)");

  addOutputOptions(addVerbose(reviews.command("list").description("List campaign reviews")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--order-by <expr>", 'property + " asc"/" desc"')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  REVIEW_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.orderBy) query.orderBy = opts.orderBy;
      return client.getAll("/reviews", { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(reviews.command("get").description("Get one campaign review by id").argument("<reviewId>")), REVIEW_FIELDS)
    .action(action(ctx, (client, _opts, reviewId) => client.json("GET", `/reviews/${encodeURIComponent(reviewId)}`, { basePath: GOV_V1 })));
}
