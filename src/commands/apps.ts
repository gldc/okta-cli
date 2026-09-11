import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { flatToNested, parseAssignments } from "../lib/dotted";
import { getApp, getGroup, getUser, retrieve, selectField } from "../lib/lookup";

export const APP_TYPES = ["bookmark", "template_basic_auth", "template_swa", "template_swa3field", "template_sps", "oidc_client", "template_wsfed"];
export const SIGNON_TYPES = ["BOOKMARK", "BASIC_AUTH", "BROWSER_PLUGIN", "SECURE_PASSWORD_STORE", "SAML_2_0", "WS_FEDERATION", "AUTO_LOGIN", "OPENID_CONNECT", "Custom"];
export const SIGNON_DEFAULTS: Record<string, string> = {
  bookmark: "BOOKMARK", template_basic_auth: "BASIC_AUTH", template_swa: "BROWSER_PLUGIN", template_swa3field: "BROWSER_PLUGIN",
  template_sps: "SECURE_PASSWORD_STORE", oidc_client: "OPENID_CONNECT", template_wsfed: "WS_FEDERATION",
};
export const APP_DEFAULTS: Record<string, [string, string][]> = { bookmark: [["sa.requestIntegration", "false"]] };
export const PREF_SHORTCUTS: [string, string][] = [["sa", "settings.app"], ["v", "visibility"], ["f", "features"], ["c", "credentials"]];

const unshorten = (key: string): string => {
  for (const [short, long] of PREF_SHORTCUTS) if (key.startsWith(`${short}.`)) return `${long}.${key.slice(short.length + 1)}`;
  return key;
};

export function buildAppBody(name: string | undefined, signonmode: string | undefined, label: string | undefined, sets: string[]): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [k, v] of [...(name ? APP_DEFAULTS[name] ?? [] : []), ...Object.entries(parseAssignments(sets))]) flat[unshorten(k)] = v;
  if (name && SIGNON_DEFAULTS[name]) signonmode = SIGNON_DEFAULTS[name];
  if (name !== undefined) flat.name = name;
  if (label !== undefined) flat.label = label;
  if (signonmode !== undefined) flat.signOnMode = signonmode;
  return flatToNested(flat);
}

const APPUSER_FIELDS = "id,credentials.userName,scope,status,syncState";
const appUserOpts = (cmd: Command) => cmd
  .requiredOption("-a, --app <label-or-id>").requiredOption("-u, --user <id-or-fieldvalue>")
  .option("-f, --user-lookup-field <FIELDNAME>", "Users are matched against the ID or this profile field; default: 'login'.", "login");
const appGroupOpts = (cmd: Command) => cmd.requiredOption("-a, --app <label-or-id>").requiredOption("-g, --group <name-or-id>");

export function registerApps(program: Command, ctx: Ctx): Command {
  const g = subgroup(program, "apps", "Application operations");

  addVerbose(g.command("add").description("Add a new application. EXAMPLE: okta-cli apps add -n bookmark -l my_bookmark -s sa.url=http://my.url")
    .addOption(new Option("-n, --name <type>", "The application name - Okta-internal field, NOT the label").choices(APP_TYPES))
    .addOption(new Option("-m, --signonmode <mode>", "Sign on mode of the app").choices(SIGNON_TYPES))
    .option("-l, --label <label>", "The application label")
    .option("-s, --set <k=v>", "Set app parameter; prefix shortcuts sa=settings.app, v=visibility, f=features, c=credentials", collect, []))
    .action(action(ctx, (client, opts) => client.json("POST", "/apps", { body: buildAppBody(opts.name, opts.signonmode, opts.label, opts.set) })));

  for (const verb of ["activate", "deactivate"] as const) {
    addVerbose(g.command(verb).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} an application`).argument("<label-or-id>"))
      .action(action(ctx, async (client, _o, labelOrId) => {
        const app = await getApp(client, labelOrId);
        await client.json("POST", `/apps/${app.id}/lifecycle/${verb}`);
        return `application ${app.id} (${app.label}) ${verb}d`;
      }));
  }

  addVerbose(g.command("delete").description("Delete an application (deactivate first)").argument("<label-or-id>"))
    .action(action(ctx, async (client, _o, labelOrId) => {
      const app = await getApp(client, labelOrId);
      await client.json("DELETE", `/apps/${app.id}`);
      return `application ${app.id} (${app.label}) deleted`;
    }));

  addOutputOptions(addVerbose(g.command("list").description("List all defined applications; optional argument filters by label substring ('-q' = starts-with, fast)").argument("[partial_name]")
    .option("-f, --filter <EXPRESSION>").option("-q, --query <q>")), "id,label")
    .action(action(ctx, async (client, opts, partial?: string) => {
      const query: Record<string, string> = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.query) query.q = opts.query;
      const rv = await retrieve(client, "apps", partial, { selector: partial ? selectField("label", partial) : undefined, query });
      const list: any[] = Array.isArray(rv) ? rv : [rv];
      return list.sort((a, b) => String(a.label).toLowerCase().localeCompare(String(b.label).toLowerCase()));
    }));

  addOutputOptions(addVerbose(g.command("users").description("List all users for an application").argument("<app>")), "status,id,credentials.userName,")
    .action(action(ctx, async (client, _o, appArg) => {
      const app = await getApp(client, appArg);
      const rv: any[] = await client.getAll(`/apps/${app.id}/users`);
      return rv.sort((a, b) => String(a.credentials?.userName).localeCompare(String(b.credentials?.userName)));
    }));

  addOutputOptions(addVerbose(g.command("get").description("Retrieves information about one specific application").argument("[partial_name]")), "id,name,label")
    .action(action(ctx, (client, _o, partial) => getApp(client, partial)));

  addOutputOptions(addVerbose(appUserOpts(g.command("getuser").description("Retrieves one assigned user of an application"))), APPUSER_FIELDS)
    .action(action(ctx, async (client, opts) => {
      const app = await getApp(client, opts.app);
      const user = await getUser(client, opts.user, opts.userLookupField);
      return client.get(`/apps/${app.id}/users/${user.id}`);
    }));

  addOutputOptions(addVerbose(appUserOpts(g.command("adduser").description("Add a user to an application")).option("-s, --set <k=v>", "app user fields", collect, [])), APPUSER_FIELDS)
    .action(action(ctx, async (client, opts) => {
      const app = await getApp(client, opts.app);
      const user = await getUser(client, opts.user, opts.userLookupField);
      const body = flatToNested({ ...parseAssignments(opts.set), id: user.id });
      return client.json("POST", `/apps/${app.id}/users`, { body });
    }));

  addVerbose(appUserOpts(g.command("removeuser").description("Removes a user from an application")))
    .action(action(ctx, async (client, opts) => {
      const app = await getApp(client, opts.app);
      const user = await getUser(client, opts.user, opts.userLookupField);
      await client.json("DELETE", `/apps/${app.id}/users/${user.id}`);
      return `User ${user.id} (${user.profile.login}) removed from app ${app.id} (${app.label})`;
    }));

  addOutputOptions(addVerbose(appGroupOpts(g.command("addgroup").description("Assigns a group to this app"))), null)
    .action(action(ctx, async (client, opts) => {
      const app = await getApp(client, opts.app);
      const group = await getGroup(client, opts.group);
      return client.json("PUT", `/apps/${app.id}/groups/${group.id}`);
    }));

  addVerbose(appGroupOpts(g.command("removegroup").description("Removes a group association from an app")))
    .action(action(ctx, async (client, opts) => {
      const app = await getApp(client, opts.app);
      const group = await getGroup(client, opts.group);
      await client.json("DELETE", `/apps/${app.id}/groups/${group.id}`);
      return `App ${app.id} (${app.label}) removed from group ${group.id} (${group.profile.name})`;
    }));

  addOutputOptions(addVerbose(g.command("groups").description("List the groups associated to an app").argument("<app>")), null)
    .action(action(ctx, async (client, _o, appArg) => {
      const app = await getApp(client, appArg);
      const rv: any[] = await client.getAll(`/apps/${app.id}/groups`);
      return rv.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }));

  return g;
}
