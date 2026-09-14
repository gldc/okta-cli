import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, int, subgroup } from "../cli/options";
import type { Query } from "../okta/client";
import { GOV_V1 } from "./governance";

const PRINCIPAL_ENTITLEMENT_FIELDS = "id,name,externalValue,dataType,multiValue,required,parentResourceOrn,targetPrincipalOrn";
const ENTITLEMENT_HISTORY_FIELDS = "startDate,endDate,lifecycle";

// None of these five is a CRUD resource (no defineResource): principal-access is a single
// object keyed by a required filter, principal-entitlements is a list plus a differently-shaped
// history sub-resource, principal-settings has a PATCH but no GET.
export function registerGovernancePrincipals(g: Command, ctx: Ctx): void {
  const principalAccess = subgroup(g, "principal-access", "Effective access grant for one principal on one resource (v1)");
  // Deviation from the plan: the plan says "client.get + addOutputOptions(..., null)" (the
  // `rate-limits settings` precedent in tenant.ts), but `OktaClient.get(path, query)`
  // (src/okta/client.ts) has no basePath parameter - every governance endpoint needs one.
  // `client.json("GET", path, { basePath, query })` is what every other single-object
  // governance read in this codebase already uses (e.g. `gov operations get` in governance.ts,
  // `gov entitlements value` in governance-entitlements.ts), so this follows the same pattern.
  addOutputOptions(addVerbose(principalAccess.command("get").description("Get one principal's effective access to one resource")
    .requiredOption("-f, --filter <expr>", "Okta SCIM filter expression (required by this endpoint)")), null)
    .action(action(ctx, (client, opts) => client.json("GET", "/principal-access", { basePath: GOV_V1, query: { filter: opts.filter } })));

  const principalEntitlements = subgroup(g, "principal-entitlements", "Effective entitlements for principals (v1)");

  addOutputOptions(addVerbose(principalEntitlements.command("list").description("List effective entitlements across principals")
    .requiredOption("-f, --filter <expr>", "Okta SCIM filter expression (required by this endpoint)")
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)),
  PRINCIPAL_ENTITLEMENT_FIELDS)
    .action(action(ctx, (client, opts) => client.getAll("/principal-entitlements", { basePath: GOV_V1, listKey: "data", query: { filter: opts.filter }, max: opts.limit })));

  // The array key on this one is `entitlementHistory`, not `data` (gov-schema.d.ts
  // "principal-entitlements-history", grepped 2026-09-14) - matches the plan.
  addOutputOptions(addVerbose(principalEntitlements.command("history").description("List a principal's entitlement history over time (array key is entitlementHistory, not data)")
    .requiredOption("-f, --filter <expr>", "Okta SCIM filter expression (required by this endpoint)")
    .addOption(new Option("--include <what>", "counts (populates metadata.total; use -j to see it, the table drops it)").choices(["counts"]))
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter; server-side max is 100 here)", int)),
  ENTITLEMENT_HISTORY_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = { filter: opts.filter };
      if (opts.include) query.include = opts.include;
      return client.getAll("/principal-entitlements/history", { basePath: GOV_V1, listKey: "entitlementHistory", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(principalEntitlements.command("changes").description("Get one principal-entitlements-change record by its (opaque) id").argument("<principalEntitlementsChangeId>")), null)
    .action(action(ctx, (client, _opts, id) => client.json("GET", `/principal-entitlements-changes/${encodeURIComponent(id)}`, { basePath: GOV_V1 })));

  const principalSettings = subgroup(g, "principal-settings", 'Per-principal governance settings (delegate appointments); no GET here - use "gov delegates list --filter \'delegatorId eq \\"<id>\\"\'" to read them (v1)');
  addOutputOptions(addVerbose(bodyOpts(principalSettings.command("update").description("Update a principal's delegate appointments (object body: {delegates:{appointments:[...]}}, max 1 appointment); id is an ORN or Okta id")
    .argument("<targetPrincipalId>"))), null)
    .action(action(ctx, (client, opts, id) => client.json("PATCH", `/principal-settings/${encodeURIComponent(id)}`, { basePath: GOV_V1, body: bodyFromOpts(opts) })));
}
