import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { parseAssignments } from "../lib/dotted";
import { filterDicts } from "../lib/filter";
import { getOne, retrieve, selectField } from "../lib/lookup";

const FIELDS = "id,status,stage.value,type,name";
const byName = (a: any, b: any) => String(a.name).localeCompare(String(b.name));
const nameOpt = (cmd: Command) => cmd.argument("[partial_name]").option("-f, --partial-name-field <field>", "match the argument against this field", "name");
const getFeature = (client: any, opts: any, partial: string | undefined) => getOne(client, "features", partial, { selector: selectField(opts.partialNameField, partial ?? "") });

export function registerFeatures(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "features", "Feature operations");

  addOutputOptions(addVerbose(nameOpt(g.command("list").description("Lists tenant features"))
    .option("-m, --match <k=v>", "regex filters on fields", collect, [])
    .option("-p, --partial", "Accept partial matches for match queries (default: true)", true)
    .option("--no-partial")), FIELDS)
    .action(action(ctx, async (client, opts, partial?: string) => {
      const rv: any[] = await retrieve(client, "features", undefined, { selector: partial ? selectField(opts.partialNameField, partial) : undefined });
      return filterDicts(rv, parseAssignments(opts.match), opts.partial ?? true).sort(byName);
    }));

  addOutputOptions(addVerbose(nameOpt(g.command("get").description("Retrieves information about one specific feature"))), FIELDS)
    .action(action(ctx, (client, opts, partial) => getFeature(client, opts, partial)));

  for (const mode of ["enable", "disable"] as const) {
    addOutputOptions(addVerbose(nameOpt(g.command(mode).description(`${mode[0]!.toUpperCase()}${mode.slice(1)} a feature`)).option("--force", "force mode")), FIELDS)
      .action(action(ctx, async (client, opts, partial) => {
        const f = await getFeature(client, opts, partial);
        return client.json("POST", `/features/${f.id}/${mode}`, { query: opts.force ? { mode: "force" } : {} });
      }));
  }
  for (const rel of ["dependents", "dependencies"] as const) {
    addOutputOptions(addVerbose(nameOpt(g.command(rel).description(rel === "dependents" ? "List features depending on this one" : "List dependencies of this feature")).option("--force", "(ignored, kept for compatibility)")), FIELDS)
      .action(action(ctx, async (client, opts, partial) => {
        const f = await getFeature(client, opts, partial);
        const rv: any[] = await client.getAll(`/features/${f.id}/${rel}`);
        return rv.sort(byName);
      }));
  }
}
