import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, int, subgroup } from "../cli/options";
import { deepMerge, getDotted, isPlainObject } from "../lib/dotted";
import { selectField } from "../lib/lookup";
import type { OktaClient, Query } from "../okta/client";
import { ExitError, OktaApiError } from "../okta/errors";

export interface ListOption { flags: string; param: string; description: string; required?: boolean; requiredForList?: boolean; choices?: string[]; transform?: (v: string) => string }
export interface ResourceSpec {
  name: string; description: string; path: string; singular: string; nameField: string; defaultFields: string;
  lifecycle?: boolean; deletable?: boolean; replaceable?: boolean; creatable?: boolean; listKey?: string; listOptions?: ListOption[]; sortBy?: string; idField?: string;
  // API base other than /api/v1 (e.g. "/governance/api/v1"), passed through to every `client`
  // call this spec drives.
  basePath?: string;
  // The list endpoint 400s without a `filter` query parameter. Swaps `list`'s `-f/--filter`
  // option for a commander requiredOption with no default value (a default would silently mask
  // the 400), and makes `resourceGet`'s by-id-404 fallback throw instead of issuing a filterless
  // list.
  filterRequired?: boolean;
  // Adds a `--limit <n>` option to `list` that caps `resourceList`'s result client-side
  // (`getAll`'s `max`) - never sent as a `limit` query parameter.
  limitOption?: boolean;
  // Extra top-level read-only fields to strip from the GET representation before it's used as
  // the PUT merge base in `replace` (on top of the fields every resource strips - see
  // REPLACE_OMIT_DEFAULT below).
  replaceOmit?: string[];
  // Last chance to adjust a `replace` body (e.g. fetch data the PUT requires but the merge
  // can't produce, or reject a body missing a write-only field) before it's sent.
  beforeReplace?: (client: OktaClient, existing: any, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

// Read-only fields every resource's GET representation carries but no PUT (replace) body
// accepts - stripped from the merge base before `deepMerge(existing, body)`.
const REPLACE_OMIT_DEFAULT = ["id", "created", "lastUpdated", "createdBy", "lastUpdatedBy", "_links", "_embedded"];

export function omitFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out = { ...obj };
  for (const f of fields) delete out[f];
  return out;
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

export async function resourceList(client: OktaClient, spec: ResourceSpec, partial: string | undefined, query: Query = {}, max?: number): Promise<any[]> {
  let items: any[] = await client.getAll(spec.path, { query, listKey: spec.listKey, basePath: spec.basePath, max });
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
  try { return await client.json("GET", `${spec.path}/${encodeURIComponent(nameOrId)}`, { basePath: spec.basePath }); }
  catch (e) {
    if (!(e instanceof OktaApiError)) throw e;
    // A filter-required list 400s without one, so a filterless fallback list is never useful -
    // fail with a clear message instead (see ResourceSpec.filterRequired).
    if (spec.filterRequired) throw new ExitError(`${spec.singular} must be given by id (${spec.path} requires a filter, so name lookup isn't possible).`);
  }
  const matches = await resourceList(client, spec, nameOrId, query);
  if (matches.length > 1) throw new ExitError(`Name for ${spec.singular} must be unique. (found ${matches.length} matches).`);
  if (matches.length === 0) throw new ExitError(`No matching ${spec.singular} found.`);
  return matches[0];
}

// Maps --format to the Content-Type a certificate-publish endpoint (apps/idps CSR publish)
// accepts for each certificate encoding (confirmed against Okta's developer docs).
export const CSR_PUBLISH_CONTENT_TYPES: Record<string, string> = {
  pem: "application/x-pem-file",
  der: "application/pkix-cert",
  cer: "application/x-x509-ca-cert",
};

// Publishes a CSR by sending the raw certificate bytes with the Content-Type matching
// `format` - shared by `apps csr-publish` and `idps csr-publish`.
export async function publishCsr(client: OktaClient, path: string, file: string, format: string): Promise<any> {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const rsp = await client.request("POST", path, { body: bytes, headers: { "Content-Type": CSR_PUBLISH_CONTENT_TYPES[format]! } });
  return client.parseJson(rsp);
}

// Resolves a nested (non-top-level) resource by id, falling back to a unique substring
// match on `nameField` across the collection at `path` - shared by scopes/claims/policies/rules
// (auth-servers.ts) and policy rules (policies.ts).
export async function getNested(client: OktaClient, path: string, arg: string, nameField: string, singular: string, basePath?: string): Promise<any> {
  try {
    return await client.json("GET", `${path}/${encodeURIComponent(arg)}`, { basePath });
  } catch (e) {
    if (!(e instanceof OktaApiError)) throw e;
  }
  const items: any[] = await client.getAll(path, { basePath });
  const matches = items.filter(selectField(nameField, arg));
  if (matches.length > 1) throw new ExitError(`Name for ${singular} must be unique. (found ${matches.length} matches).`);
  if (matches.length === 0) throw new ExitError(`No matching ${singular} found.`);
  return matches[0];
}

export function defineResource(parent: Command, ctx: Ctx, spec: ResourceSpec): Command {
  const g = subgroup(parent, spec.name, spec.description);
  const out = (cmd: Command, forList = false) => addOutputOptions(addVerbose(addListOptions(cmd, spec, forList)), spec.defaultFields);

  const listCmd = g.command("list").description(`List ${spec.singular}s (optional argument: substring of ${spec.nameField})`).argument("[partial_name]");
  if (spec.filterRequired) listCmd.requiredOption("-f, --filter <expr>", "Okta SCIM filter expression (required by this endpoint)");
  else listCmd.option("-f, --filter <expr>", "Okta filter expression");
  listCmd.option("-q, --query <q>", "Okta 'q' query");
  if (spec.limitOption) listCmd.option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int);
  out(listCmd, true)
    .action(action(ctx, (client, opts, partial?: string) => {
      const query = lookupQuery(spec, opts);
      if (opts.filter) query.filter = opts.filter;
      if (opts.query) query.q = opts.query;
      return resourceList(client, spec, partial, query, opts.limit);
    }));

  out(g.command("get").description(`Get one ${spec.singular} by id or unique ${spec.nameField} substring`).argument("<name-or-id>"))
    .action(action(ctx, (client, opts, nameOrId) => resourceGet(client, spec, nameOrId, lookupQuery(spec, opts))));

  if (spec.creatable !== false) {
    out(bodyOpts(g.command("add").description(`Create a ${spec.singular} from a JSON body (-b) and/or dotted assignments (-s)`)))
      .action(action(ctx, (client, opts) => client.json("POST", spec.path, { body: bodyFromOpts(opts), basePath: spec.basePath })));
  }

  if (spec.replaceable !== false) {
    out(bodyOpts(g.command("replace").description(`Replace (PUT) a ${spec.singular}; with only -s the current object is fetched and merged`).argument("<name-or-id>")))
      .action(action(ctx, async (client, opts, nameOrId) => {
        const existing = await resourceGet(client, spec, nameOrId, lookupQuery(spec, opts));
        let body = bodyFromOpts(opts);
        if (!opts.body && isPlainObject(body)) {
          const base = omitFields(existing, [...REPLACE_OMIT_DEFAULT, ...(spec.replaceOmit ?? [])]);
          body = deepMerge(base, body);
        }
        if (spec.beforeReplace) body = await spec.beforeReplace(client, existing, body as Record<string, unknown>);
        return client.json("PUT", `${spec.path}/${idOf(spec, existing)}`, { body, basePath: spec.basePath });
      }));
  }

  if (spec.deletable !== false) {
    addVerbose(addListOptions(g.command("delete").description(`Delete a ${spec.singular}`).argument("<name-or-id>"), spec))
      .action(action(ctx, async (client, opts, nameOrId) => {
        const item = await resourceGet(client, spec, nameOrId, lookupQuery(spec, opts));
        const id = idOf(spec, item);
        await client.json("DELETE", `${spec.path}/${id}`, { basePath: spec.basePath });
        return `${spec.singular} ${id} (${nameOf(spec, item)}) deleted`;
      }));
  }

  if (spec.lifecycle) {
    for (const verb of ["activate", "deactivate"] as const) {
      out(g.command(verb).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} a ${spec.singular}`).argument("<name-or-id>"))
        .action(action(ctx, async (client, opts, nameOrId) => {
          const item = await resourceGet(client, spec, nameOrId, lookupQuery(spec, opts));
          const id = idOf(spec, item);
          const rv = await client.json("POST", `${spec.path}/${id}/lifecycle/${verb}`, { basePath: spec.basePath });
          return rv ?? `${spec.singular} ${id} (${nameOf(spec, item)}) ${verb}d`;
        }));
    }
  }
  return g;
}
