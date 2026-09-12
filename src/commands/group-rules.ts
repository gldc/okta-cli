import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect } from "../cli/options";
import { defineResource, lookupQuery, resourceGet, type ResourceSpec } from "./resource";

export const GROUP_RULES: ResourceSpec = { name: "rules", description: "Group rules", path: "/groups/rules", singular: "group rule", nameField: "name", defaultFields: "id,status,type,name", lifecycle: true, creatable: false, deletable: false,
  listOptions: [{ flags: "--search <text>", param: "search", description: "name search" }] };

export function groupRuleBody(opts: { name: string; expression: string; group: string[]; excludeUser?: string[] }): Record<string, unknown> {
  const conditions: Record<string, unknown> = { expression: { type: "urn:okta:expression:1.0", value: opts.expression } };
  if (opts.excludeUser && opts.excludeUser.length > 0) conditions.people = { users: { exclude: opts.excludeUser } };
  return { type: "group_rule", name: opts.name, conditions, actions: { assignUserToGroups: { groupIds: opts.group } } };
}

export function registerGroupRules(groupsCmd: Command, ctx: Ctx): void {
  const g = defineResource(groupsCmd, ctx, GROUP_RULES);

  addOutputOptions(addVerbose(g.command("add").description("Create a group rule")
    .requiredOption("-n, --name <name>").requiredOption("-e, --expression <okta-expression>")
    .requiredOption("-g, --group <groupId>", "target group id, repeatable", collect)
    .option("--exclude-user <userId>", "user id to exclude from the rule, repeatable", collect, [])), GROUP_RULES.defaultFields)
    .action(action(ctx, (client, opts) => client.json("POST", "/groups/rules", { body: groupRuleBody(opts as Parameters<typeof groupRuleBody>[0]) })));

  addVerbose(g.command("delete").description(`Delete a ${GROUP_RULES.singular}`).argument("<name-or-id>")
    .option("--remove-users", "remove users from the rule's target groups on delete"))
    .action(action(ctx, async (client, opts, nameOrId) => {
      const item = await resourceGet(client, GROUP_RULES, nameOrId, lookupQuery(GROUP_RULES, opts));
      await client.json("DELETE", `/groups/rules/${item.id}`, { query: opts.removeUsers ? { removeUsers: true } : {} });
      return `${GROUP_RULES.singular} ${item.id} (${item.name ?? ""}) deleted`;
    }));
}
