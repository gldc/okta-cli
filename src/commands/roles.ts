import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose } from "../cli/options";
import { getGroup, getUser } from "../lib/lookup";
import type { OktaClient } from "../okta/client";
import { ExitError } from "../okta/errors";
import { defineResource, type ResourceSpec } from "./resource";

export const ROLE_TYPES = ["SUPER_ADMIN", "ORG_ADMIN", "APP_ADMIN", "USER_ADMIN", "HELP_DESK_ADMIN", "READ_ONLY_ADMIN", "MOBILE_ADMIN", "API_ACCESS_MANAGEMENT_ADMIN", "REPORT_ADMIN", "GROUP_MEMBERSHIP_ADMIN", "ACCESS_CERTIFICATIONS_ADMIN", "ACCESS_REQUESTS_ADMIN", "CUSTOM"];
const ASSIGNMENT_FIELDS = "id,type,label,status,assignmentType";

export const CUSTOM_ROLES: ResourceSpec = { name: "roles", description: "Admin roles: custom roles, resource sets, assignees", path: "/iam/roles", singular: "custom role", nameField: "label", defaultFields: "id,label,description", listKey: "roles" };

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
}
