import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyOpts } from "../cli/options";
import { parseBody } from "../lib/body";
import { getGroup, getUser } from "../lib/lookup";
import type { OktaClient } from "../okta/client";
import { ExitError } from "../okta/errors";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

export const ROLE_TYPES = ["SUPER_ADMIN", "ORG_ADMIN", "APP_ADMIN", "USER_ADMIN", "HELP_DESK_ADMIN", "READ_ONLY_ADMIN", "MOBILE_ADMIN", "API_ACCESS_MANAGEMENT_ADMIN", "REPORT_ADMIN", "GROUP_MEMBERSHIP_ADMIN", "ACCESS_CERTIFICATIONS_ADMIN", "ACCESS_REQUESTS_ADMIN", "CUSTOM"];
const ASSIGNMENT_FIELDS = "id,type,label,status,assignmentType";
const PERMISSION_FIELDS = "label,created,lastUpdated";
const SUBSCRIPTION_FIELDS = "notificationType,status,channels";
const BINDING_FIELDS = "id";
const RESOURCE_FIELDS = "id,orn";

export const CUSTOM_ROLES: ResourceSpec = { name: "roles", description: "Admin roles: custom roles, resource sets, assignees", path: "/iam/roles", singular: "custom role", nameField: "label", defaultFields: "id,label,description", listKey: "roles" };
const RESOURCE_SETS: ResourceSpec = { name: "resource-sets", description: "Resource sets", path: "/iam/resource-sets", singular: "resource set", nameField: "label", defaultFields: "id,label,description", listKey: "resource-sets" };

export function roleAssignmentBody(opts: { type: string; role?: string; resourceSet?: string }): Record<string, unknown> {
  if (opts.type !== "CUSTOM") return { type: opts.type };
  if (!opts.role || !opts.resourceSet) throw new ExitError("CUSTOM roles need --role and --resource-set");
  return { type: "CUSTOM", role: opts.role, "resource-set": opts.resourceSet };
}

type Resolver = (client: OktaClient, value: string, field?: string) => Promise<any>;

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
}
