import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, int, subgroup } from "../cli/options";
import type { Query } from "../okta/client";
import { GOV_V2 } from "./governance";

// AI security access reviews (v2). Unrelated to campaign `reviews` (governance-campaigns.ts) -
// see "Resolved ambiguities" #3 in the plan; do not conflate the two families.
const SAR_FIELDS = "id,status,name,endTime,created,lastUpdated";
const ACCESS_FIELDS = "id,type,name,resourceId,severity,remediationStatus";
const ANOMALY_FIELDS = "type,severity,subtext";
const ACTION_FIELDS = "actionType";
const HISTORY_FIELDS = "id,timestamp,systemGenerated,message,principalProfile.email";
const PRINCIPAL_FIELDS = "id,email,login,status,type,department,manager,role";
const STATS_FIELDS = "activeCount,pendingCount,errorCount,closedCount";
const AI_MESSAGE_FIELDS = "message";

// security-access-review-access-item-supported-action / security-access-review-action-type
// (gov-schema.d.ts, grepped 2026-09-14) - two distinct enums for the two distinct "act on it"
// commands below.
const ACCESS_ACTIONS = ["REVOKE_ACCESS", "RESTORE_ACCESS", "FLAG_FOR_MANUAL_REMEDIATION", "FLAG_FOR_MANUAL_RESTORATION"];
const REVIEW_ACTIONS = ["CLOSE_REVIEW", "RESTORE_ALL_ACCESS"];

export function registerGovernanceSecurityReviews(g: Command, ctx: Ctx): void {
  const reviews = subgroup(g, "security-access-reviews", "AI security access reviews (v2) - unrelated to campaign 'reviews' (see 'gov reviews')");

  addOutputOptions(addVerbose(reviews.command("list").description("List security access reviews")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--order-by <expr>", 'property + " asc"/" desc"')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  SAR_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.orderBy) query.orderBy = opts.orderBy;
      return client.getAll("/security-access-reviews", { basePath: GOV_V2, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(bodyOpts(reviews.command("add").description("Create a security access review (-b and/or -s); required: principalId, name, reviewerSettings; async (202)"))),
  SAR_FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/security-access-reviews", { basePath: GOV_V2, body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(reviews.command("stats").description("Get counts of security access reviews by status")), STATS_FIELDS)
    .action(action(ctx, (client) => client.json("GET", "/security-access-reviews/stats", { basePath: GOV_V2 })));

  addOutputOptions(addVerbose(reviews.command("get").description("Get one security access review by id").argument("<reviewId>")), SAR_FIELDS)
    .action(action(ctx, (client, _opts, reviewId) => client.json("GET", `/security-access-reviews/${encodeURIComponent(reviewId)}`, { basePath: GOV_V2 })));

  addOutputOptions(addVerbose(bodyOpts(reviews.command("update").description("Update a security access review (-b and/or -s; object body: endTime?, reviewerSettings?)").argument("<reviewId>"))),
  SAR_FIELDS)
    .action(action(ctx, (client, opts, reviewId) => client.json("PATCH", `/security-access-reviews/${encodeURIComponent(reviewId)}`, { basePath: GOV_V2, body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(reviews.command("accesses").description("List a review's access items").argument("<reviewId>")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--order-by <expr>", 'property + " asc"/" desc"')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  ACCESS_FIELDS)
    .action(action(ctx, (client, opts, reviewId) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.orderBy) query.orderBy = opts.orderBy;
      return client.getAll(`/security-access-reviews/${encodeURIComponent(reviewId)}/accesses`, { basePath: GOV_V2, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(reviews.command("sub-accesses").description("List an access item's sub-access items").argument("<reviewId>").argument("<accessId>")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--order-by <expr>", 'property + " asc"/" desc"')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  ACCESS_FIELDS)
    .action(action(ctx, (client, opts, reviewId, accessId) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.orderBy) query.orderBy = opts.orderBy;
      return client.getAll(`/security-access-reviews/${encodeURIComponent(reviewId)}/accesses/${encodeURIComponent(accessId)}/sub-accesses`, { basePath: GOV_V2, listKey: "data", query, max: opts.limit });
    }));

  addVerbose(reviews.command("access-action").description("Act on an access or sub-access item (revoke/restore/flag); async (202)").argument("<reviewId>").argument("<targetId>")
    .addOption(new Option("--type <action>", "action to take").choices(ACCESS_ACTIONS).makeOptionMandatory()))
    .action(action(ctx, async (client, opts, reviewId, targetId) => {
      await client.json("POST", `/security-access-reviews/${encodeURIComponent(reviewId)}/accesses/${encodeURIComponent(targetId)}/actions`, { basePath: GOV_V2, body: { type: opts.type } });
      return `action ${opts.type} initiated on ${targetId}`;
    }));

  addOutputOptions(addVerbose(reviews.command("anomalies").description("List anomalies detected for an access or sub-access item").argument("<reviewId>").argument("<targetId>")), ANOMALY_FIELDS)
    .action(action(ctx, (client, _opts, reviewId, targetId) =>
      client.getAll(`/security-access-reviews/${encodeURIComponent(reviewId)}/accesses/${encodeURIComponent(targetId)}/anomalies`, { basePath: GOV_V2, listKey: "data" })));

  addOutputOptions(addVerbose(reviews.command("access-summary").description("Generate an AI summary for an access or sub-access item (POST, not a mutation)").argument("<reviewId>").argument("<targetId>")), AI_MESSAGE_FIELDS)
    .action(action(ctx, (client, _opts, reviewId, targetId) =>
      client.json("POST", `/security-access-reviews/${encodeURIComponent(reviewId)}/accesses/${encodeURIComponent(targetId)}/summary`, { basePath: GOV_V2 })));

  addOutputOptions(addVerbose(reviews.command("summary").description("Generate an AI summary for a security access review (POST, not a mutation)").argument("<reviewId>")), AI_MESSAGE_FIELDS)
    .action(action(ctx, (client, _opts, reviewId) => client.json("POST", `/security-access-reviews/${encodeURIComponent(reviewId)}/summary`, { basePath: GOV_V2 })));

  // Deliberate pairing: `actions` (GET, plural) lists what's possible; `action` (POST, singular)
  // executes one. The review-level body key is `actionType`; the access-level one (access-action
  // above) is `type` - an easy transposition, tested explicitly in the test file.
  addOutputOptions(addVerbose(reviews.command("actions").description("List possible actions for a security access review").argument("<reviewId>")), ACTION_FIELDS)
    .action(action(ctx, (client, _opts, reviewId) => client.getAll(`/security-access-reviews/${encodeURIComponent(reviewId)}/actions`, { basePath: GOV_V2, listKey: "data" })));

  addVerbose(reviews.command("action").description("Execute an action on a security access review (close it, or restore all access); async (202)").argument("<reviewId>")
    .addOption(new Option("--type <action>", "action to take").choices(REVIEW_ACTIONS).makeOptionMandatory()))
    .action(action(ctx, async (client, opts, reviewId) => {
      await client.json("POST", `/security-access-reviews/${encodeURIComponent(reviewId)}/actions`, { basePath: GOV_V2, body: { actionType: opts.type } });
      return `action ${opts.type} initiated on review ${reviewId}`;
    }));

  addVerbose(reviews.command("comment").description("Add a comment to a security access review").argument("<reviewId>")
    .requiredOption("--comment <text>", "comment text"))
    .action(action(ctx, async (client, opts, reviewId) => {
      await client.json("POST", `/security-access-reviews/${encodeURIComponent(reviewId)}/comment`, { basePath: GOV_V2, body: { comment: opts.comment } });
      return `comment added to review ${reviewId}`;
    }));

  addOutputOptions(addVerbose(reviews.command("history").description("List the history of a security access review (declares only after/limit - no filter/orderBy)").argument("<reviewId>")
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  HISTORY_FIELDS)
    .action(action(ctx, (client, opts, reviewId) => client.getAll(`/security-access-reviews/${encodeURIComponent(reviewId)}/history`, { basePath: GOV_V2, listKey: "data", max: opts.limit })));

  addOutputOptions(addVerbose(reviews.command("principal").description("Get the principal (subject) of a security access review").argument("<reviewId>")), PRINCIPAL_FIELDS)
    .action(action(ctx, (client, _opts, reviewId) => client.json("GET", `/security-access-reviews/${encodeURIComponent(reviewId)}/principal`, { basePath: GOV_V2 })));
}
