import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, int, subgroup } from "../cli/options";

export const LOG_FIELDS = "published,eventType,outcome.result,actor.alternateId,client.ipAddress,displayMessage";

export function registerLogs(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "logs", "System log operations");
  addOutputOptions(addVerbose(g.command("list").description("Query the System Log (GET /logs)")
    .option("--since <iso8601>", "Events after this timestamp")
    .option("--until <iso8601>", "Events before this timestamp")
    .option("-f, --filter <expr>", 'SCIM filter, e.g. eventType eq "user.session.start"')
    .option("-q, --query <q>", "Keyword search")
    .addOption(new Option("--sort-order <order>", "sort order").choices(["ASCENDING", "DESCENDING"]).default("ASCENDING"))
    .option("-l, --limit <n>", "page size (max 1000)", int, 1000)
    .option("--max <n>", "stop after this many events in total (0 = unlimited)", int, 1000)), LOG_FIELDS)
    .action(action(ctx, (client, opts) => client.getAll("/logs", {
      query: { since: opts.since, until: opts.until, filter: opts.filter, q: opts.query, sortOrder: opts.sortOrder, limit: Math.min(1000, opts.limit) },
      max: opts.max > 0 ? opts.max : undefined,
    })));
}
