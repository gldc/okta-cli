import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { flatToNested, parseAssignments } from "../lib/dotted";
import { filterDicts } from "../lib/filter";
import { getUser, retrieve } from "../lib/lookup";
import type { OktaClient } from "../okta/client";
import { ExitError, OktaApiError } from "../okta/errors";

export const USER_FIELDS = "id,status,profile.login,profile.firstName,profile.lastName,profile.email";

export interface AddUserParams {
  fields: Record<string, string>;
  overrideFields?: Record<string, string>;
  profileFields?: Record<string, string>;
  groupIds?: string[];
  activate: boolean;
  provider: boolean;
  nextlogin: boolean;
}

export async function addUser(client: OktaClient, p: AddUserParams): Promise<any> {
  const merged: Record<string, unknown> = { ...p.fields, ...(p.overrideFields ?? {}) };
  const dotted: Record<string, unknown> = Object.fromEntries(Object.entries(merged).filter(([k]) => k.includes(".")));
  for (const [k, v] of Object.entries(p.profileFields ?? {})) dotted[`profile.${k}`] = v;
  if (p.groupIds && p.groupIds.length) dotted.groupIds = p.groupIds;
  const query: Record<string, string> = { activate: p.activate ? "True" : "False", provider: p.provider ? "True" : "False" };
  if (p.nextlogin) query.nextlogin = "changePassword";
  return client.json("POST", "/users", { query, body: flatToNested(dotted) });
}

export function usersUpdateBody(sets: string[], arraySets: string[], context?: string): Record<string, unknown> {
  const fields: Record<string, unknown> = parseAssignments(sets);
  for (const [k, v] of Object.entries(parseAssignments(arraySets))) fields[k] = v.split(",").map((s) => s.trim());
  const prefixed = context ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${context}.${k}`, v])) : fields;
  return flatToNested(prefixed);
}

const lookupFieldOpt = (cmd: Command) => cmd.option("-f, --user-lookup-field <FIELDNAME>", "Users are matched against the ID or this profile field; default: 'login'.", "login");
const sendEmailQuery = (flag: boolean | undefined) => (flag ? { sendEmail: "true" } : {});

export function registerUsers(program: Command, ctx: Ctx): Command {
  const g = subgroup(program, "users", "Add, update (etc.) users");

  addOutputOptions(addVerbose(g.command("list").description("Lists users (all or using various filters). Does not contain deprovisioned users unless -d.")
    .option("-m, --match <FIELD=VALUE>", "Filter for profile field values (slow, case-insensitive)", collect, [])
    .option("-p, --partial", "Accept partial matches for match queries.")
    .option("-f, --filter <expr>", "Add Okta filter query")
    .option("-s, --search <expr>", "Add Okta search query")
    .option("-q, --query <q>", "Add Okta query string (fast, case-sensitive, multiple fields)")
    .option("-d, --deprovisioned", "Return only deprovisioned users")), USER_FIELDS)
    .action(action(ctx, async (client, opts) => {
      const query: Record<string, string> = {};
      let search: string = opts.search ?? "";
      if (opts.deprovisioned) search = [search, 'status eq "DEPROVISIONED"'].filter(Boolean).join(" and ");
      if (search) query.search = search;
      if (opts.filter) query.filter = opts.filter;
      if (opts.query) query.q = opts.query;
      let rv: any[] = await retrieve(client, "users", undefined, { query });
      const filters = Object.fromEntries(Object.entries(parseAssignments(opts.match)).map(([k, v]) => [`profile.${k}`, v]));
      rv = filterDicts(rv, filters, Boolean(opts.partial));
      return rv.sort((a, b) => String(a.profile.login).localeCompare(String(b.profile.login)));
    }));

  addOutputOptions(addVerbose(g.command("get").description("Get one user uniquely using any profile field or ID").argument("<lookup_value>")
    .option("-f, --field <field>", "Look users up using this profile field (default: 'login')", "login")), USER_FIELDS)
    .action(action(ctx, async (client, opts, value) => {
      let rv: any[] | undefined;
      if (value.startsWith("0") && value.length === 20) {
        try { rv = [await client.get(`/users/${value}`)]; } catch (e) { if (!(e instanceof OktaApiError)) throw e; }
      }
      if (!rv) rv = await client.getAll("/users", { query: { search: `profile.${opts.field} eq "${value}"`, limit: 1000 } });
      if (rv.length === 0) throw new ExitError(`No user found with ${opts.field}=${value}`);
      if (rv.length > 1) throw new ExitError(`Criteria not unique, found ${rv.length} matches`);
      return rv[0];
    }));

  addOutputOptions(addVerbose(lookupFieldOpt(g.command("groups").description("List all groups belonging to a user").argument("<user>"))), "id,profile.name,profile.description")
    .action(action(ctx, async (client, opts, user) => {
      const u = await getUser(client, user, opts.userLookupField);
      const rv: any[] = await client.getAll(`/users/${u.id}/groups`);
      return rv.sort((a, b) => String(a.profile.name).localeCompare(String(b.profile.name)));
    }));

  addOutputOptions(addVerbose(lookupFieldOpt(g.command("apps").description("List all apps associated with a user").argument("<user>"))), "appInstanceId,appName,label")
    .action(action(ctx, async (client, opts, user) => {
      const u = await getUser(client, user, opts.userLookupField);
      const rv: any[] = await client.getAll(`/users/${u.id}/appLinks`);
      return rv.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }));

  const confirm = (loginOrId: string, question: string, skip: boolean) => {
    if (skip) return;
    if (ctx.io.prompt(question) !== loginOrId) throw new ExitError("Aborted.");
  };

  addVerbose(g.command("deactivate").description("Deactivate a user (DESTRUCTIVE OPERATION)").argument("<login_or_id>")
    .option("-e, --send-email", "Send email if set").option("--no-confirmation", "Don't ask - DANGER!!"))
    .action(action(ctx, async (client, opts, id) => {
      confirm(id, `DANGER!! Do you REALLY want to do this (maybe use 'suspend' instead)?\nThen enter '${id}': `, opts.confirmation === false);
      await client.json("POST", `/users/${id}/lifecycle/deactivate`, { query: sendEmailQuery(opts.sendEmail) });
      return `User ${id} deactivated.`;
    }));

  addOutputOptions(addVerbose(g.command("activate").description("Activate a user").argument("<login_or_id>").option("-e, --send-email", "Send email if set")), null)
    .action(action(ctx, (client, opts, id) => client.json("POST", `/users/${id}/lifecycle/activate`, { query: sendEmailQuery(opts.sendEmail) })));

  addOutputOptions(addVerbose(g.command("reactivate").description("Reactivate a user").argument("<login_or_id>").option("-e, --send-email", "Send email if set")), null)
    .action(action(ctx, (client, opts, id) => client.json("POST", `/users/${id}/lifecycle/reactivate`, { query: sendEmailQuery(opts.sendEmail) })));

  addVerbose(g.command("unlock").description("Unlock a locked user").argument("<login_or_id>"))
    .action(action(ctx, async (client, _o, id) => { await client.json("POST", `/users/${id}/lifecycle/unlock`); return `User '${id}' unlocked.`; }));

  addVerbose(g.command("delete").description("Delete a user (DESTRUCTIVE OPERATION)").argument("<login_or_id>")
    .option("-e, --send-email", "Send email if set").option("--no-confirmation", "Don't ask - DANGER!!"))
    .action(action(ctx, async (client, opts, id) => {
      confirm(id, `DANGER!! Do you REALLY want to do this?\nThen enter '${id}': `, opts.confirmation === false);
      await client.json("DELETE", `/users/${id}`, { query: sendEmailQuery(opts.sendEmail) });
      return `User ${id} deleted.`;
    }));

  addVerbose(g.command("suspend").description("Suspend a user").argument("<login_or_id>"))
    .action(action(ctx, (client, _o, id) => client.json("POST", `/users/${id}/lifecycle/suspend`)));

  addVerbose(g.command("update").description("Update a user object (POST partial update). Examples: -s profile.email=me@x.com | -S profile.multi=a,b | -c credentials.recovery_question -s question=Q -s answer=A").argument("<user_id>")
    .option("-s, --set <FIELD=value>", "set a field", collect, [])
    .option("-S, --array-set <FIELD=a,b>", "set an array field", collect, [])
    .option("-c, --context <prefix>", "Set a context (profile, credentials) to save typing"))
    .action(action(ctx, (client, opts, id) => client.json("POST", `/users/${id}`, { body: usersUpdateBody(opts.set, opts.arraySet, opts.context) })));

  addVerbose(g.command("add").description("Add a user to Okta. '-p login=x' equals '-s profile.login=x' (-p wins).")
    .option("-s, --set <FIELD=value>", "set any user object field", collect, [])
    .option("-p, --profile <FIELD=value>", "same as '-s profile.FIELD=value'", collect, [])
    .option("-g, --group <GROUP_ID>", "groups the user should be added to on creation", collect, [])
    .option("--activate", "Set 'activation' flag, default: True").option("--no-activate")
    .option("--provider", "Set 'provider' flag, default: False").option("--no-provider")
    .option("--nextlogin", "User must change password, default: False").option("--no-nextlogin"))
    .action(action(ctx, (client, opts) => addUser(client, {
      fields: parseAssignments(opts.set), profileFields: parseAssignments(opts.profile), groupIds: opts.group,
      activate: opts.activate ?? true, provider: opts.provider ?? false, nextlogin: opts.nextlogin ?? false,
    })));

  return g;
}
