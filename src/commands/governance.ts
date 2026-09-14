import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, int, subgroup } from "../cli/options";
import type { Query } from "../okta/client";

// The Okta Identity Governance (OIG) surface lives outside /api/v1 entirely - every
// ResourceSpec/client.* call under `gov` passes one of these two explicitly as `basePath`.
export const GOV_V1 = "/governance/api/v1";
export const GOV_V2 = "/governance/api/v2";

const OPERATION_FIELDS = "id,type,status,created,completed,timeElapsedInSeconds";
// Deviation from the plan: the plan's quoted field list was `id,delegate,delegator,startTime,
// endTime,note`. `delegate`/`delegator` are `target-principal` objects (gov-schema.d.ts
// "target-principal": `{externalId, type: "OKTA_USER"}`) with no name/label field, so the
// generated types' obvious display property is `externalId` (the Okta user id) - dotted fields
// are used instead of printing `[object Object]`.
const DELEGATE_FIELDS = "id,delegate.externalId,delegator.externalId,startTime,endTime,note";
const TEAM_FIELDS = "id,name,created,lastUpdated";

export function registerGovernance(program: Command, ctx: Ctx): Command {
  const g = subgroup(program, "governance", "Okta Identity Governance (OIG): access certification, entitlements, access requests").alias("gov");

  const operations = subgroup(g, "operations", "Async governance operation status (v1)");
  addOutputOptions(addVerbose(operations.command("get").description("Get an async governance operation by id (async governance writes return one in _links)").argument("<operationId>")), OPERATION_FIELDS)
    .action(action(ctx, (client, _opts, operationId) => client.json("GET", `/operations/${encodeURIComponent(operationId)}`, { basePath: GOV_V1 })));

  const delegates = subgroup(g, "delegates", "Delegate appointments (who performs governance duties on whose behalf) (v1)");
  addOutputOptions(addVerbose(delegates.command("list").description("List delegate appointments")
    .option("-f, --filter <expr>", 'Okta filter expression (only delegatorId eq "<id>" is supported)')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)), DELEGATE_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      return client.getAll("/delegates", { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  const teams = subgroup(g, "teams", "Access request teams (v1)");
  addOutputOptions(addVerbose(teams.command("list").description("List access request teams")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)), TEAM_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      return client.getAll("/teams", { basePath: GOV_V1, listKey: "data", query, max: opts.limit });
    }));

  // Deviation from Task 1's plan: the plan's own comment here originally said every later
  // task would call its own registerGovernance<Family>(g, ctx) from inside this function,
  // imported from src/commands/governance-<family>.ts. That direction (governance.ts
  // importing a family file that itself imports GOV_V1/GOV_V2 back from governance.ts)
  // is a circular import, and since the family ResourceSpec objects reference GOV_V1 at
  // module-evaluation time (not inside a function), it fails hard at load with
  // "ReferenceError: Cannot access 'GOV_V1' before initialization" - confirmed by running
  // `bun run check` with governance-entitlements.ts wired this way. The rest of the
  // codebase already avoids exactly this shape (apps.ts never imports apps-extra.ts;
  // groups.ts never imports group-rules.ts) by wiring "extra" registrations from
  // src/cli/program.ts instead, one level up. Every registerGovernance<Family>(g, ctx)
  // call is wired from program.ts the same way - see the block after `registerGovernance`
  // there - not from here.

  return g;
}
