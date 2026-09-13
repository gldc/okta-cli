import { Option, type Command } from "commander";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect } from "../cli/options";
import { parseBody } from "../lib/body";
import { mapConcurrent } from "../lib/concurrency";
import { parseAssignments } from "../lib/dotted";
import { toCsv } from "../lib/output";
import type { Method, OktaClient } from "../okta/client";

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);

export function registerMisc(program: Command, ctx: Ctx): void {
  addVerbose(program.command("dump").description("Dump basically everything into CSV files for further processing (includes DEPROVISIONED users)")
    .option("-d, --dir <dir>", "Save in this directory")
    .option("--no-user-list").option("--no-app-users").option("--no-group-users"))
    .action(action(ctx, async (client: OktaClient, opts) => {
      const dir: string = opts.dir ?? `okta-dump-${stamp(ctx.now())}`;
      mkdirSync(dir, { recursive: true });
      const save = (file: string, text: string) => Bun.write(join(dir, file), text);
      ctx.io.out("Please be patient, this can take several minutes.\n");
      if (opts.userList === false) ctx.io.out("Skipping list of users.\n");
      else {
        ctx.io.out("Saving user list ... ");
        const list = [...(await client.getAll("/users", { query: { limit: 1000 } })), ...(await client.getAll("/users", { query: { limit: 1000, search: 'status eq "DEPROVISIONED"' } }))];
        await save("users.csv", toCsv(list));
        ctx.io.out("done.\n");
      }
      for (const [what, skip] of [["group", opts.groupUsers === false], ["app", opts.appUsers === false]] as const) {
        ctx.io.out(`Saving ${what} list ... `);
        const items: any[] = await client.getAll(`/${what}s`);
        await save(`${what}s.csv`, toCsv(items));
        ctx.io.out("done.\n");
        if (skip) { ctx.io.out(`Skipping list of ${what} users.\n`); continue; }
        ctx.io.out(`Saving ${what} users ... `);
        const pairs = await mapConcurrent(items, 25, async (it) => (await client.getAll(`/${what}s/${it.id}/users`, { query: { limit: 1000 } })).map((u: any) => `${it.id},${u.id}`));
        await save(`${what}_users.csv`, [`${what},user`, ...pairs.flat()].join("\r\n") + "\r\n");
        ctx.io.out("done.\n");
      }
      return undefined;
    }));

  addOutputOptions(addVerbose(program.command("raw").description("Perform a request against the specified API endpoint").argument("<api_endpoint>")
    .addOption(new Option("-X, --http-method <method>", "HTTP method; default: get").choices(["get", "post", "put", "delete", "patch"]).default("get"))
    .option("-q, --query <field=value>", "Set a query field in the URL", collect, [])
    .option("-b, --body <json>", "Message body; use FILE:<filename> to read from file")
    .option("--base-path <path>", "Different base path than the default (/api/v1)")), null)
    .action(action(ctx, (client, opts, endpoint) => {
      const method = String(opts.httpMethod).toUpperCase() as Method;
      const query = parseAssignments(opts.query);
      const basePath = opts.basePath ? (opts.basePath.startsWith("/") ? opts.basePath : `/${opts.basePath}`) : undefined;
      const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
      return method === "GET" ? client.getAuto(path, { query, basePath }) : client.json(method, path, { query, body: parseBody(opts.body), basePath });
    }));
}
