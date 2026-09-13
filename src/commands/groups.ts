import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, subgroup, type Handler } from "../cli/options";
import { getGroup, getUser, retrieve, selectProfileField } from "../lib/lookup";
import type { OktaClient } from "../okta/client";

const GROUP_FIELDS = "id,type,profile.name";
const USER_FIELDS = "id,profile.login,profile.firstName,profile.lastName,profile.email";
const OWNER_FIELDS = "id,type,originType,displayName,resolved";

export const groupsList: Handler = async (client, opts, partialName?: string) => {
  const query: Record<string, string> = {};
  if (opts.filter) query.filter = opts.filter;
  if (opts.query) query.q = opts.query;
  const selector = partialName ? selectProfileField("name", partialName) : undefined;
  let rv: any[] = await retrieve(client, "groups", undefined, { selector, query });
  if (!opts.all) rv = rv.filter((g) => g.type === "OKTA_GROUP");
  return rv;
};

export const groupsAddUser: Handler = async (client, opts) => {
  const group = await getGroup(client, opts.group);
  const user = await getUser(client, opts.user, opts.userLookupField);
  await client.json("PUT", `/groups/${group.id}/users/${user.id}`);
  return `User ${user.id} (${user.profile.login}) added to group ${group.id} (${group.profile.name})`;
};

export const groupsRemoveUser: Handler = async (client, opts) => {
  const group = await getGroup(client, opts.group);
  const user = await getUser(client, opts.user, opts.userLookupField);
  await client.json("DELETE", `/groups/${group.id}/users/${user.id}`);
  return `User ${user.id} (${user.profile.login}) removed from group ${group.id} (${group.profile.name})`;
};

export const groupsClear = (ctx: Ctx): Handler => async (client: OktaClient, _opts, nameOrId: string) => {
  const group = await getGroup(client, nameOrId);
  const members: any[] = await client.getAll(`/groups/${group.id}/users`);
  members.sort((a, b) => String(a.profile.login).localeCompare(String(b.profile.login)));
  for (const u of members) {
    ctx.io.err(`Removing user ${u.profile.login} ... `);
    await client.json("DELETE", `/groups/${group.id}/users/${u.id}`);
    ctx.io.err("ok\n");
  }
  return `All users removed from group ${group.id} (${group.profile.name})`;
};

const userFlags = (cmd: Command) => cmd
  .requiredOption("-g, --group <GID-OR-UNIQUE>", "The group ID (or unique name part) of the group")
  .requiredOption("-u, --user <EXACT-MATCH>", "The user ID, or an exact match of the --user-lookup-field")
  .option("-f, --user-lookup-field <FIELDNAME>", "Matching is done against this profile field; default: 'login'.", "login");

export function registerGroups(program: Command, ctx: Ctx): Command {
  const g = subgroup(program, "groups", "Group operations");

  addOutputOptions(addVerbose(g.command("list").description("List all defined groups").argument("[partial_name]")
    .option("-f, --filter <expression>", "Okta filter expression")
    .option("-q, --query <query>", "Okta 'q' query (name starts with)")
    .option("-a, --all", "Include APP_GROUPs in list")), GROUP_FIELDS)
    .action(action(ctx, groupsList));

  addOutputOptions(addVerbose(g.command("add").description("Create a new group")
    .requiredOption("-n, --name <name>").option("-d, --description <description>")), GROUP_FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/groups", { body: { profile: { name: opts.name, description: opts.description ?? null } } })));

  addOutputOptions(addVerbose(g.command("apps").description("List all apps associated with a group").argument("<name-or-id>")), "id,name,label")
    .action(action(ctx, async (client, _o, nameOrId) => {
      const group = await getGroup(client, nameOrId);
      const rv: any[] = await client.getAll(`/groups/${group.id}/apps`);
      return rv.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }));

  addOutputOptions(addVerbose(g.command("delete").description("Delete a group (name substring match must be unique)").argument("<name-or-id>")), GROUP_FIELDS)
    .action(action(ctx, async (client, _o, nameOrId) => {
      const group = await getGroup(client, nameOrId);
      await client.json("DELETE", `/groups/${group.id}`);
      return `group ${group.id} deleted`;
    }));

  addOutputOptions(addVerbose(g.command("get").description("Print only one group").argument("<name-or-id>")), GROUP_FIELDS)
    .action(action(ctx, (client, _o, nameOrId) => getGroup(client, nameOrId)));

  addVerbose(userFlags(g.command("adduser").description("Adds a user to a group. Use -f to select users by any profile field."))).action(action(ctx, groupsAddUser));
  addVerbose(userFlags(g.command("removeuser").description("Removes a user from a group."))).action(action(ctx, groupsRemoveUser));

  addOutputOptions(addVerbose(g.command("users").description("List all users in a group").argument("<id-or-unique>")), USER_FIELDS)
    .action(action(ctx, async (client, _o, idOrUnique) => {
      const group = await getGroup(client, idOrUnique);
      const rv: any[] = await client.getAll(`/groups/${group.id}/users`);
      return rv.sort((a, b) => String(a.profile.login).toLowerCase().localeCompare(String(b.profile.login).toLowerCase()));
    }));

  addVerbose(g.command("clear").description("Remove all users from a group. This can take a while if the group is big.").argument("<name-or-id>")
    .option("-i, --id", "Use Okta group ID instead of the group name"))
    .action(action(ctx, groupsClear(ctx)));

  addOutputOptions(addVerbose(g.command("owners").description("List a group's owners").argument("<name-or-id>")), OWNER_FIELDS)
    .action(action(ctx, async (client, _o, nameOrId) => client.getAll(`/groups/${(await getGroup(client, nameOrId)).id}/owners`)));

  // Deviation from the plan: the AssignGroupOwnerRequestBody schema only has `id` and
  // `type`; there's no `originType` field on the request (it's a readonly response field).
  addOutputOptions(addVerbose(g.command("owner-add").description("Add an owner to a group").argument("<name-or-id>")
    .requiredOption("-u, --user <id-or-value>", "id of the new owner (or -f lookup value, when --type USER)")
    .option("-f, --user-lookup-field <field>", "profile field to match when --type USER", "login")
    .addOption(new Option("--type <type>", "owner type").choices(["USER", "GROUP"]).default("USER"))), OWNER_FIELDS)
    .action(action(ctx, async (client, opts, nameOrId) => {
      const group = await getGroup(client, nameOrId);
      const owner = opts.type === "GROUP" ? await getGroup(client, opts.user) : await getUser(client, opts.user, opts.userLookupField);
      return client.json("POST", `/groups/${group.id}/owners`, { body: { id: owner.id, type: opts.type } });
    }));

  addVerbose(g.command("owner-delete").description("Remove an owner from a group").argument("<name-or-id>").argument("<ownerId>"))
    .action(action(ctx, async (client, _o, nameOrId, ownerId) => {
      const group = await getGroup(client, nameOrId);
      await client.json("DELETE", `/groups/${group.id}/owners/${ownerId}`);
      return `owner ${ownerId} removed from group ${group.id} (${group.profile.name})`;
    }));

  return g;
}
