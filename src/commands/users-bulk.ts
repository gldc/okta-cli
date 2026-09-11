import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addVerbose, collect, int } from "../cli/options";
import { mapConcurrent } from "../lib/concurrency";
import { flatToNested, parseAssignments } from "../lib/dotted";
import { fileReader } from "../lib/files";
import { toSortedJson } from "../lib/output";
import { OktaApiError } from "../okta/errors";
import { addUser } from "./users";

type ErrTuple = [number, string, unknown];

export function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export async function writeBulkResults(ctx: Ctx, prefix: string, buckets: Record<string, unknown[]>): Promise<string> {
  const ts = timestamp(ctx.now());
  let rv = "";
  let total = 0;
  for (const [name, results] of Object.entries(buckets)) {
    total += results.length;
    if (results.length) {
      const file = `${prefix}-${ts}-${name}.json`;
      await Bun.write(file, toSortedJson(results));
      rv += `${String(results.length).padStart(4)} ${name.padEnd(6)} - ${file}\n`;
    } else rv += `${String(results.length).padStart(5)} ${name.padEnd(6)}\n`;
  }
  return rv + `${total} total`;
}

const toErr = (idx: number, e: unknown): ErrTuple =>
  e instanceof OktaApiError ? [idx, e.message, e.body] : [idx, e instanceof Error ? e.message : String(e), null];

const progress = (ctx: Ctx) => (done: number, total: number) => ctx.io.err(`\r${done}/${total}${done === total ? "\n" : ""}`);

export function registerUsersBulk(users: Command, ctx: Ctx): void {
  addVerbose(users.command("bulk-add").description("Bulk-ADD users from a CSV or Excel (.xlsx) file. Needs a 'profile.login' column; columns without a dot are ignored.").argument("<file>")
    .option("-s, --set <FIELD=value>", "set any user object field", collect, [])
    .option("--activate", "Set 'activation' flag, default: True").option("--no-activate")
    .option("--provider", "Set 'provider' flag, default: False").option("--no-provider")
    .option("--nextlogin", "User must change password, default: False").option("--no-nextlogin")
    .option("-g, --group <GROUP_ID>", "groups the user should be added to on creation", collect, [])
    .option("-i, --jump-to-index <IDX>", "Start with index IDX (0-based) and skip previous entries", int, 0)
    .option("-l, --limit <NUM>", "Stop after NUM updates", int, 0)
    .option("-w, --workers <NUM>", "use this many parallel requests, default: 25", int, 25))
    .action(action(ctx, async (client, opts, file) => {
      ctx.io.out("Bulk adding users might take a while. Please be patient.\n");
      const rows = await fileReader(file, { jumpToIndex: opts.jumpToIndex, limit: opts.limit });
      const added: unknown[] = [];
      const errors: ErrTuple[] = [];
      const overrides = parseAssignments(opts.set);
      await mapConcurrent(rows, opts.workers, async (row, i) => {
        const idx = i + opts.jumpToIndex;
        if (!(row["profile.login"] ?? "").trim()) { errors.push([idx, "missing profile.login column", null]); return; }
        try {
          added.push(await addUser(client, { fields: row, overrideFields: overrides, groupIds: opts.group, activate: opts.activate ?? true, provider: opts.provider ?? false, nextlogin: opts.nextlogin ?? false }));
        } catch (e) { errors.push(toErr(idx, e)); }
      }, progress(ctx));
      errors.sort((a, b) => a[0] - b[0]);
      return writeBulkResults(ctx, "okta-bulk-add", { added, errors });
    }));

  addVerbose(users.command("bulk-update").description("Bulk-update users from a CSV or Excel (.xlsx) file. Needs an 'id' or 'profile.login' column; columns without a dot are ignored.").argument("<file>")
    .option("-s, --set <FIELD=value>", "set any user object field", collect, [])
    .option("-i, --jump-to-index <IDX>", "Start with index IDX (0-based) and skip previous entries", int, 0)
    .option("-u, --jump-to-user <USER_ID>", "Same as --jump-to-index, but starts from a specific user ID / login")
    .option("-l, --limit <NUM>", "Stop after NUM updates", int, 0)
    .option("-w, --workers <NUM>", "use this many parallel requests, default: 25", int, 25))
    .action(action(ctx, async (client, opts, file) => {
      ctx.io.out("Bulk update might take a while. Please be patient.\n");
      const rows = await fileReader(file, { jumpToUser: opts.jumpToUser, jumpToIndex: opts.jumpToIndex, limit: opts.limit });
      const updated: unknown[] = [];
      const errors: ErrTuple[] = [];
      const defaults = parseAssignments(opts.set);
      await mapConcurrent(rows, opts.workers, async (row, i) => {
        const idx = i + opts.jumpToIndex;
        const { id, "profile.login": login, ...rest } = row;
        const userId = (id ?? "").trim() || (login ?? "").trim();
        if (!userId) { errors.push([idx, "missing id or profile.login column", null]); return; }
        const dotted = Object.fromEntries(Object.entries(rest).filter(([k]) => k.includes(".")));
        try { updated.push(await client.json("POST", `/users/${userId}`, { body: flatToNested(dotted, defaults) })); }
        catch (e) { errors.push(toErr(idx, e)); }
      }, progress(ctx));
      errors.sort((a, b) => a[0] - b[0]);
      return writeBulkResults(ctx, "okta-bulk-update", { updated, errors });
    }));
}
