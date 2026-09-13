import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts } from "../cli/options";
import { parseBody } from "../lib/body";
import { getGroup, getUser } from "../lib/lookup";
import type { OktaClient, RequestOptions } from "../okta/client";
import { ExitError } from "../okta/errors";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

export const ROLE_TYPES = ["SUPER_ADMIN", "ORG_ADMIN", "APP_ADMIN", "USER_ADMIN", "HELP_DESK_ADMIN", "READ_ONLY_ADMIN", "MOBILE_ADMIN", "API_ACCESS_MANAGEMENT_ADMIN", "REPORT_ADMIN", "GROUP_MEMBERSHIP_ADMIN", "ACCESS_CERTIFICATIONS_ADMIN", "ACCESS_REQUESTS_ADMIN", "CUSTOM"];
const ASSIGNMENT_FIELDS = "id,type,label,status,assignmentType";
const PERMISSION_FIELDS = "label,created,lastUpdated";
const SUBSCRIPTION_FIELDS = "notificationType,status,channels";
const BINDING_FIELDS = "id";
const RESOURCE_FIELDS = "id,orn";
const BINDING_MEMBER_FIELDS = "id,created,lastUpdated";
const ROLE_TARGET_ALL_FIELDS = "assignmentType,expiration,orn";

export const CUSTOM_ROLES: ResourceSpec = { name: "roles", description: "Admin roles: custom roles, resource sets, assignees", path: "/iam/roles", singular: "custom role", nameField: "label", defaultFields: "id,label,description", listKey: "roles" };
const RESOURCE_SETS: ResourceSpec = { name: "resource-sets", description: "Resource sets", path: "/iam/resource-sets", singular: "resource set", nameField: "label", defaultFields: "id,label,description", listKey: "resource-sets" };

export function roleAssignmentBody(opts: { type: string; role?: string; resourceSet?: string }): Record<string, unknown> {
  if (opts.type !== "CUSTOM") return { type: opts.type };
  if (!opts.role || !opts.resourceSet) throw new ExitError("CUSTOM roles need --role and --resource-set");
  return { type: "CUSTOM", role: opts.role, "resource-set": opts.resourceSet };
}

type Resolver = (client: OktaClient, value: string, field?: string) => Promise<any>;

// Shared by users/groups/oauth-clients role-target commands (roles.ts + directory.ts).
export interface RoleTargetOpts { group?: string; appName?: string; appId?: string }

function requireRoleTarget(opts: RoleTargetOpts): void {
  if (opts.group && opts.appName) throw new ExitError("Provide -g/--group or --app-name, not both");
  if (!opts.group && !opts.appName) throw new ExitError("Provide -g/--group or --app-name");
}

function catalogAppTargetPath(base: string, appName: string, appId?: string): string {
  return `${base}/targets/catalog/apps/${appName}${appId ? `/${appId}` : ""}`;
}

export async function roleTargetGroupsAndApps(client: OktaClient, base: string, reqOpts: RequestOptions = {}): Promise<{ groups: any[]; apps: any[] }> {
  const [groups, apps] = await Promise.all([
    client.getAll(`${base}/targets/groups`, reqOpts),
    client.getAll(`${base}/targets/catalog/apps`, reqOpts),
  ]);
  return { groups, apps };
}

export async function addRoleTarget(client: OktaClient, base: string, opts: RoleTargetOpts, reqOpts: RequestOptions = {}): Promise<string> {
  requireRoleTarget(opts);
  if (opts.group) {
    const group = await getGroup(client, opts.group);
    await client.json("PUT", `${base}/targets/groups/${group.id}`, reqOpts);
    return `group ${group.id} (${group.profile.name})`;
  }
  await client.json("PUT", catalogAppTargetPath(base, opts.appName!, opts.appId), reqOpts);
  return `app ${opts.appName}${opts.appId ? `/${opts.appId}` : ""}`;
}

export async function deleteRoleTarget(client: OktaClient, base: string, opts: RoleTargetOpts, reqOpts: RequestOptions = {}): Promise<string> {
  requireRoleTarget(opts);
  if (opts.group) {
    const group = await getGroup(client, opts.group);
    await client.json("DELETE", `${base}/targets/groups/${group.id}`, reqOpts);
    return `group ${group.id} (${group.profile.name})`;
  }
  await client.json("DELETE", catalogAppTargetPath(base, opts.appName!, opts.appId), reqOpts);
  return `app ${opts.appName}${opts.appId ? `/${opts.appId}` : ""}`;
}

function targetOpts(cmd: Command): Command {
  return cmd.option("-g, --group <group>", "group id or unique name")
    .option("--app-name <name>", "OIN catalog app key name (APP_ADMIN roles)")
    .option("--app-id <appId>", "app instance id (with --app-name)");
}

function attachRoleTargets(parent: Command, ctx: Ctx, kind: "user" | "group", resolve: Resolver) {
  const basePlural = kind === "user" ? "users" : "groups";
  const lookupOpt = (cmd: Command) => kind === "user" ? cmd.option("-f, --user-lookup-field <field>", "profile field to match", "login") : cmd;

  addOutputOptions(addVerbose(lookupOpt(parent.command("role-targets").description(`List the group and app targets of a ${kind}'s role assignment`).argument(`<${kind}>`).argument("<assignmentId>"))), null)
    .action(action(ctx, async (client, opts, who, assignmentId) => {
      const id = (await resolve(client, who, opts.userLookupField)).id;
      return roleTargetGroupsAndApps(client, `/${basePlural}/${id}/roles/${assignmentId}`);
    }));

  addVerbose(targetOpts(lookupOpt(parent.command("role-target-add").description(`Add a group or app target to a ${kind}'s role assignment`).argument(`<${kind}>`).argument("<assignmentId>"))))
    .action(action(ctx, async (client, opts, who, assignmentId) => {
      const target = await resolve(client, who, opts.userLookupField);
      const label = await addRoleTarget(client, `/${basePlural}/${target.id}/roles/${assignmentId}`, opts as RoleTargetOpts);
      return `${label} added as a target of role assignment ${assignmentId} on ${kind} ${target.id}`;
    }));

  addVerbose(targetOpts(lookupOpt(parent.command("role-target-delete").description(`Remove a group or app target from a ${kind}'s role assignment`).argument(`<${kind}>`).argument("<assignmentId>"))))
    .action(action(ctx, async (client, opts, who, assignmentId) => {
      const target = await resolve(client, who, opts.userLookupField);
      const label = await deleteRoleTarget(client, `/${basePlural}/${target.id}/roles/${assignmentId}`, opts as RoleTargetOpts);
      return `${label} removed as a target of role assignment ${assignmentId} on ${kind} ${target.id}`;
    }));
}

function attachAssignments(parent: Command, ctx: Ctx, kind: "user" | "group", resolve: Resolver, nameOf: (x: any) => string) {
  const base = kind === "user" ? "users" : "groups";
  const lookupOpt = (cmd: Command) => kind === "user" ? cmd.option("-f, --user-lookup-field <field>", "profile field to match", "login") : cmd;
  addOutputOptions(addVerbose(lookupOpt(parent.command("roles").description(`List admin role assignments of a ${kind}`).argument(`<${kind}>`))), ASSIGNMENT_FIELDS)
    .action(action(ctx, async (client, opts, who) => client.getAll(`/${base}/${(await resolve(client, who, opts.userLookupField)).id}/roles`)));
  addOutputOptions(addVerbose(lookupOpt(parent.command("assign-role").description(`Assign an admin role to a ${kind}`).argument(`<${kind}>`)
    .addOption(new Option("-t, --type <ROLE_TYPE>", "role type").choices(ROLE_TYPES).makeOptionMandatory())
    .option("--role <id-or-label>", "custom role (with -t CUSTOM)").option("--resource-set <id>", "resource set (with -t CUSTOM)"))), ASSIGNMENT_FIELDS)
    .action(action(ctx, async (client, opts, who) => client.json("POST", `/${base}/${(await resolve(client, who, opts.userLookupField)).id}/roles`, { body: roleAssignmentBody(opts as { type: string; role?: string; resourceSet?: string }) })));
  addVerbose(lookupOpt(parent.command("unassign-role").description(`Remove an admin role assignment from a ${kind}`).argument(`<${kind}>`).argument("<assignment-id>")))
    .action(action(ctx, async (client, opts, who, rid) => {
      const target = await resolve(client, who, opts.userLookupField);
      await client.json("DELETE", `/${base}/${target.id}/roles/${rid}`);
      return `role assignment ${rid} removed from ${kind} ${target.id} (${nameOf(target)})`;
    }));
}

export function registerRoles(program: Command, ctx: Ctx, groups: { users: Command; groups: Command }): void {
  const g = defineResource(program, ctx, CUSTOM_ROLES);
  addOutputOptions(addVerbose(g.command("assignees").description("List users that have admin role assignments")), "id,orn")
    .action(action(ctx, (client) => client.getAll("/iam/assignees/users", { listKey: "value" })));
  addOutputOptions(addVerbose(g.command("resource-sets").description("List resource sets").argument("[partial]")), "id,label,description")
    .action(action(ctx, async (client, _o, partial?: string) => {
      const all: any[] = await client.getAll("/iam/resource-sets", { listKey: "resource-sets" });
      return partial ? all.filter((r) => String(r.label).toLowerCase().includes(partial.toLowerCase())) : all;
    }));
  attachAssignments(groups.users, ctx, "user", (c, v, f) => getUser(c, v, f), (u) => u.profile.login);
  attachAssignments(groups.groups, ctx, "group", (c, v) => getGroup(c, v), (g) => g.profile.name);
  attachRoleTargets(groups.users, ctx, "user", (c, v, f) => getUser(c, v, f));
  attachRoleTargets(groups.groups, ctx, "group", (c, v) => getGroup(c, v));

  addOutputOptions(addVerbose(groups.users.command("role-governance").description("Retrieve the governance sources of a user's role assignment").argument("<user>").argument("<assignmentId>").argument("[grantId]")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login")
    .option("--resources", "list the resources of the grant (requires grantId)")), null)
    .action(action(ctx, async (client, opts, user, assignmentId, grantId?: string) => {
      if (opts.resources && !grantId) throw new ExitError("--resources requires a grantId");
      const id = (await getUser(client, user, opts.userLookupField)).id;
      const base = `/users/${id}/roles/${assignmentId}/governance`;
      if (!grantId) return client.get(base);
      return client.get(opts.resources ? `${base}/${grantId}/resources` : `${base}/${grantId}`);
    }));

  addOutputOptions(addVerbose(groups.users.command("role-targets-all").description("Retrieve all role targets for a user's role assignment, by assignment type").argument("<user>").argument("<roleIdOrEncoded>")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login")), ROLE_TARGET_ALL_FIELDS)
    .action(action(ctx, async (client, opts, user, roleIdOrEncoded) => client.getAll(`/users/${(await getUser(client, user, opts.userLookupField)).id}/roles/${roleIdOrEncoded}/targets`)));

  addOutputOptions(addVerbose(g.command("permissions").description("List a custom role's permissions").argument("<role>")), PERMISSION_FIELDS)
    .action(action(ctx, async (client, _o, roleArg) => client.getAll(`/iam/roles/${(await resourceGet(client, CUSTOM_ROLES, roleArg)).id}/permissions`, { listKey: "permissions" })));

  // Deviation from the plan: createRolePermission returns 204 No Content, so this always
  // reports the fallback confirmation string rather than printing the (nonexistent) permission.
  addVerbose(bodyOpts(g.command("permission-add").description("Create (or replace) a permission on a custom role").argument("<role>").argument("<permissionType>")))
    .action(action(ctx, async (client, opts, roleArg, permissionType) => {
      const role = await resourceGet(client, CUSTOM_ROLES, roleArg);
      const body = parseBody(opts.body, opts.set);
      await client.json("POST", `/iam/roles/${role.id}/permissions/${permissionType}`, { body });
      return `permission ${permissionType} added to custom role ${role.id} (${role.label})`;
    }));

  addVerbose(g.command("permission-delete").description("Delete a permission from a custom role").argument("<role>").argument("<permissionType>"))
    .action(action(ctx, async (client, _o, roleArg, permissionType) => {
      const role = await resourceGet(client, CUSTOM_ROLES, roleArg);
      await client.json("DELETE", `/iam/roles/${role.id}/permissions/${permissionType}`);
      return `permission ${permissionType} deleted from custom role ${role.id} (${role.label})`;
    }));

  addOutputOptions(addVerbose(g.command("subscriptions").description("List a role type's notification subscriptions").argument("<roleType>")), SUBSCRIPTION_FIELDS)
    .action(action(ctx, async (client, _o, roleType) => client.getAll(`/roles/${roleType}/subscriptions`)));

  addOutputOptions(addVerbose(g.command("subscription").description("Retrieve a role type's notification subscription").argument("<roleType>").argument("<notificationType>")), SUBSCRIPTION_FIELDS)
    .action(action(ctx, (client, _o, roleType, notificationType) => client.get(`/roles/${roleType}/subscriptions/${notificationType}`)));

  // Deviation from the plan: subscribe/unsubscribe return 200 with no content, so these
  // always report the fallback confirmation string.
  for (const [verb, prep] of [["subscribe", "to"], ["unsubscribe", "from"]] as const) {
    addVerbose(g.command(verb).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} a role type from a notification type`).argument("<roleType>").argument("<notificationType>"))
      .action(action(ctx, async (client, _o, roleType, notificationType) => {
        await client.json("POST", `/roles/${roleType}/subscriptions/${notificationType}/${verb}`);
        return `role ${roleType} ${verb}d ${prep} ${notificationType}`;
      }));
  }

  addOutputOptions(addVerbose(g.command("resource-set-bindings").description("List the role bindings on a resource set").argument("<resourceSet>")), BINDING_FIELDS)
    .action(action(ctx, async (client, _o, resourceSetArg) => {
      const rs = await resourceGet(client, RESOURCE_SETS, resourceSetArg);
      return client.getAll(`/iam/resource-sets/${rs.id}/bindings`, { listKey: "roles" });
    }));

  addOutputOptions(addVerbose(g.command("resource-set-resources").description("List the resources in a resource set").argument("<resourceSet>")), RESOURCE_FIELDS)
    .action(action(ctx, async (client, _o, resourceSetArg) => {
      const rs = await resourceGet(client, RESOURCE_SETS, resourceSetArg);
      return client.getAll(`/iam/resource-sets/${rs.id}/resources`, { listKey: "resources" });
    }));

  addOutputOptions(addVerbose(g.command("resource-set-binding").description("Retrieve a role's binding on a resource set").argument("<resourceSet>").argument("<role>")), BINDING_FIELDS)
    .action(action(ctx, async (client, _o, resourceSetArg, role) => client.get(`/iam/resource-sets/${(await resourceGet(client, RESOURCE_SETS, resourceSetArg)).id}/bindings/${role}`)));

  addOutputOptions(addVerbose(bodyOpts(g.command("resource-set-binding-add").description("Create a role resource set binding").argument("<resourceSet>"))), BINDING_FIELDS)
    .action(action(ctx, async (client, opts, resourceSetArg) => client.json("POST", `/iam/resource-sets/${(await resourceGet(client, RESOURCE_SETS, resourceSetArg)).id}/bindings`, { body: bodyFromOpts(opts) })));

  addVerbose(g.command("resource-set-binding-delete").description("Delete a role resource set binding").argument("<resourceSet>").argument("<role>"))
    .action(action(ctx, async (client, _o, resourceSetArg, role) => {
      const rs = await resourceGet(client, RESOURCE_SETS, resourceSetArg);
      await client.json("DELETE", `/iam/resource-sets/${rs.id}/bindings/${role}`);
      return `role resource set binding ${role} deleted from resource set ${rs.id} (${rs.label})`;
    }));

  addOutputOptions(addVerbose(g.command("resource-set-binding-members").description("List the members of a role resource set binding").argument("<resourceSet>").argument("<role>")), BINDING_MEMBER_FIELDS)
    .action(action(ctx, async (client, _o, resourceSetArg, role) => client.getAll(`/iam/resource-sets/${(await resourceGet(client, RESOURCE_SETS, resourceSetArg)).id}/bindings/${role}/members`, { listKey: "members" })));

  addOutputOptions(addVerbose(g.command("resource-set-binding-member").description("Retrieve a role resource set binding member").argument("<resourceSet>").argument("<role>").argument("<memberId>")), BINDING_MEMBER_FIELDS)
    .action(action(ctx, async (client, _o, resourceSetArg, role, memberId) => client.get(`/iam/resource-sets/${(await resourceGet(client, RESOURCE_SETS, resourceSetArg)).id}/bindings/${role}/members/${memberId}`)));

  addOutputOptions(addVerbose(bodyOpts(g.command("resource-set-binding-members-add").description("Add members to a role resource set binding").argument("<resourceSet>").argument("<role>"))), null)
    .action(action(ctx, async (client, opts, resourceSetArg, role) => client.json("PATCH", `/iam/resource-sets/${(await resourceGet(client, RESOURCE_SETS, resourceSetArg)).id}/bindings/${role}/members`, { body: bodyFromOpts(opts) })));

  addVerbose(g.command("resource-set-binding-member-delete").description("Remove a member from a role resource set binding").argument("<resourceSet>").argument("<role>").argument("<memberId>"))
    .action(action(ctx, async (client, _o, resourceSetArg, role, memberId) => {
      const rs = await resourceGet(client, RESOURCE_SETS, resourceSetArg);
      await client.json("DELETE", `/iam/resource-sets/${rs.id}/bindings/${role}/members/${memberId}`);
      return `member ${memberId} removed from role resource set binding ${role} on resource set ${rs.id} (${rs.label})`;
    }));

  addOutputOptions(addVerbose(g.command("resource-set-resource").description("Retrieve a resource set resource").argument("<resourceSet>").argument("<resourceId>")), RESOURCE_FIELDS)
    .action(action(ctx, async (client, _o, resourceSetArg, resourceId) => client.get(`/iam/resource-sets/${(await resourceGet(client, RESOURCE_SETS, resourceSetArg)).id}/resources/${resourceId}`)));

  addOutputOptions(addVerbose(bodyOpts(g.command("resource-set-resource-set").description("Replace the conditions of a resource set resource").argument("<resourceSet>").argument("<resourceId>"))), RESOURCE_FIELDS)
    .action(action(ctx, async (client, opts, resourceSetArg, resourceId) => client.json("PUT", `/iam/resource-sets/${(await resourceGet(client, RESOURCE_SETS, resourceSetArg)).id}/resources/${resourceId}`, { body: bodyFromOpts(opts) })));

  addVerbose(g.command("resource-set-resource-delete").description("Delete a resource set resource").argument("<resourceSet>").argument("<resourceId>"))
    .action(action(ctx, async (client, _o, resourceSetArg, resourceId) => {
      const rs = await resourceGet(client, RESOURCE_SETS, resourceSetArg);
      await client.json("DELETE", `/iam/resource-sets/${rs.id}/resources/${resourceId}`);
      return `resource ${resourceId} deleted from resource set ${rs.id} (${rs.label})`;
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("resource-set-resources-add").description("Add resources to a resource set").argument("<resourceSet>"))), null)
    .action(action(ctx, async (client, opts, resourceSetArg) => client.json("PATCH", `/iam/resource-sets/${(await resourceGet(client, RESOURCE_SETS, resourceSetArg)).id}/resources`, { body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(g.command("governance-bundles").description("List all governance bundles")), "id,name,description")
    .action(action(ctx, (client) => client.getAll("/iam/governance/bundles", { listKey: "bundles" })));

  addOutputOptions(addVerbose(g.command("governance-bundle").description("Retrieve a governance bundle").argument("<bundleId>")), "id,name,description,status")
    .action(action(ctx, (client, _o, bundleId) => client.get(`/iam/governance/bundles/${bundleId}`)));

  addOutputOptions(addVerbose(g.command("governance-bundle-entitlements").description("List the entitlements in a governance bundle").argument("<bundleId>")), "id,name,role,description")
    .action(action(ctx, (client, _o, bundleId) => client.getAll(`/iam/governance/bundles/${bundleId}/entitlements`, { listKey: "entitlements" })));

  addOutputOptions(addVerbose(g.command("governance-entitlement-values").description("List the values for a governance bundle entitlement").argument("<bundleId>").argument("<entitlementId>")), "id,name,value")
    .action(action(ctx, (client, _o, bundleId, entitlementId) => client.getAll(`/iam/governance/bundles/${bundleId}/entitlements/${entitlementId}/values`, { listKey: "entitlementValues" })));

  addOutputOptions(addVerbose(g.command("governance-opt-in").description("Opt the Admin Console into entitlement management")), null)
    .action(action(ctx, (client) => client.json("POST", "/iam/governance/optIn")));

  addOutputOptions(addVerbose(g.command("governance-opt-out").description("Opt the Admin Console out of entitlement management")), null)
    .action(action(ctx, (client) => client.json("POST", "/iam/governance/optOut")));
}
