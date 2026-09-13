import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import { deepMerge, getDotted, isPlainObject } from "../lib/dotted";
import { selectField } from "../lib/lookup";
import type { OktaClient, Query } from "../okta/client";
import { ExitError, OktaApiError } from "../okta/errors";

export interface ListOption { flags: string; param: string; description: string; required?: boolean; requiredForList?: boolean; choices?: string[]; transform?: (v: string) => string }
export interface ResourceSpec {
  name: string; description: string; path: string; singular: string; nameField: string; defaultFields: string;
  lifecycle?: boolean; deletable?: boolean; replaceable?: boolean; creatable?: boolean; listKey?: string; listOptions?: ListOption[]; sortBy?: string; idField?: string;
}

const optKey = (flags: string) => {
  const long = flags.split(",").map((s) => s.trim()).find((s) => s.startsWith("--"))!;
  return long.replace(/^--/, "").split(" ")[0]!.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
};

export function lookupQuery(spec: ResourceSpec, opts: Record<string, any>): Query {
  const q: Query = {};
  for (const lo of spec.listOptions ?? []) { const v = opts[optKey(lo.flags)]; if (v !== undefined) q[lo.param] = lo.transform ? lo.transform(String(v)) : v; }
  return q;
}

function addListOptions(cmd: Command, spec: ResourceSpec, forList = false): Command {
  for (const lo of spec.listOptions ?? []) {
    const o = new Option(lo.flags, lo.description);
    if (lo.choices) o.choices(lo.choices);
    if (lo.required || (forList && lo.requiredForList)) o.makeOptionMandatory();
    cmd.addOption(o);
  }
  return cmd;
}

const nameOf = (spec: ResourceSpec, item: any) => String(getDotted(item, spec.nameField) ?? "");
const idOf = (spec: ResourceSpec, item: any) => String(getDotted(item, spec.idField ?? "id") ?? "");

export async function resourceList(client: OktaClient, spec: ResourceSpec, partial: string | undefined, query: Query = {}): Promise<any[]> {
  let items: any[] = await client.getAll(spec.path, { query, listKey: spec.listKey });
  if (partial) items = items.filter(selectField(spec.nameField, partial));
  const key = spec.sortBy ?? spec.nameField;
  return items.sort((a, b) => {
    const av = getDotted(a, key);
    const bv = getDotted(b, key);
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    return String(av ?? "").toLowerCase().localeCompare(String(bv ?? "").toLowerCase());
  });
}

export async function resourceGet(client: OktaClient, spec: ResourceSpec, nameOrId: string, query: Query = {}): Promise<any> {
  try { return await client.get(`${spec.path}/${encodeURIComponent(nameOrId)}`); }
  catch (e) { if (!(e instanceof OktaApiError)) throw e; }
  const matches = await resourceList(client, spec, nameOrId, query);
  if (matches.length > 1) throw new ExitError(`Name for ${spec.singular} must be unique. (found ${matches.length} matches).`);
  if (matches.length === 0) throw new ExitError(`No matching ${spec.singular} found.`);
  return matches[0];
}

export function defineResource(parent: Command, ctx: Ctx, spec: ResourceSpec): Command {
  const g = subgroup(parent, spec.name, spec.description);
  const out = (cmd: Command, forList = false) => addOutputOptions(addVerbose(addListOptions(cmd, spec, forList)), spec.defaultFields);

  out(g.command("list").description(`List ${spec.singular}s (optional argument: substring of ${spec.nameField})`).argument("[partial_name]")
    .option("-f, --filter <expr>", "Okta filter expression").option("-q, --query <q>", "Okta 'q' query"), true)
    .action(action(ctx, (client, opts, partial?: string) => {
      const query = lookupQuery(spec, opts);
      if (opts.filter) query.filter = opts.filter;
      if (opts.query) query.q = opts.query;
      return resourceList(client, spec, partial, query);
    }));

  out(g.command("get").description(`Get one ${spec.singular} by id or unique ${spec.nameField} substring`).argument("<name-or-id>"))
    .action(action(ctx, (client, opts, nameOrId) => resourceGet(client, spec, nameOrId, lookupQuery(spec, opts))));

  if (spec.creatable !== false) {
    out(g.command("add").description(`Create a ${spec.singular} from a JSON body (-b) and/or dotted assignments (-s)`)
      .option("-b, --body <json>", "JSON body; FILE:<path> reads a file").option("-s, --set <k=v>", "set a (dotted) field", collect, []))
      .action(action(ctx, (client, opts) => {
        const body = parseBody(opts.body, opts.set);
        if (body === undefined) throw new ExitError("Provide -b and/or -s");
        return client.json("POST", spec.path, { body });
      }));
  }

  if (spec.replaceable !== false) {
    out(g.command("replace").description(`Replace (PUT) a ${spec.singular}; with only -s the current object is fetched and merged`).argument("<name-or-id>")
      .option("-b, --body <json>", "JSON body; FILE:<path> reads a file").option("-s, --set <k=v>", "set a (dotted) field", collect, []))
      .action(action(ctx, async (client, opts, nameOrId) => {
        const existing = await resourceGet(client, spec, nameOrId, lookupQuery(spec, opts));
        let body = parseBody(opts.body, opts.set);
        if (body === undefined) throw new ExitError("Provide -b and/or -s");
        if (!opts.body && isPlainObject(body)) body = deepMerge(existing, body);
        return client.json("PUT", `${spec.path}/${idOf(spec, existing)}`, { body });
      }));
  }

  if (spec.deletable !== false) {
    addVerbose(addListOptions(g.command("delete").description(`Delete a ${spec.singular}`).argument("<name-or-id>"), spec))
      .action(action(ctx, async (client, opts, nameOrId) => {
        const item = await resourceGet(client, spec, nameOrId, lookupQuery(spec, opts));
        const id = idOf(spec, item);
        await client.json("DELETE", `${spec.path}/${id}`);
        return `${spec.singular} ${id} (${nameOf(spec, item)}) deleted`;
      }));
  }

  if (spec.lifecycle) {
    for (const verb of ["activate", "deactivate"] as const) {
      out(g.command(verb).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} a ${spec.singular}`).argument("<name-or-id>"))
        .action(action(ctx, async (client, opts, nameOrId) => {
          const item = await resourceGet(client, spec, nameOrId, lookupQuery(spec, opts));
          const id = idOf(spec, item);
          const rv = await client.json("POST", `${spec.path}/${id}/lifecycle/${verb}`);
          return rv ?? `${spec.singular} ${id} (${nameOf(spec, item)}) ${verb}d`;
        }));
    }
  }
  return g;
}
