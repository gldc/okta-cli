import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose } from "../cli/options";
import { defineResource, type ResourceSpec } from "./resource";

export const USER_TYPES: ResourceSpec = { name: "user-types", description: "User types", path: "/meta/types/user", singular: "user type", nameField: "name", defaultFields: "id,name,displayName,default,description", creatable: false };

export function registerUserTypes(program: Command, ctx: Ctx): void {
  const g = defineResource(program, ctx, USER_TYPES);

  addOutputOptions(addVerbose(g.command("add").description("Create a user type")
    .requiredOption("-n, --name <name>").requiredOption("-d, --display-name <name>").option("--description <description>")), USER_TYPES.defaultFields)
    .action(action(ctx, (client, opts) => client.json("POST", "/meta/types/user", { body: { name: opts.name, displayName: opts.displayName, description: opts.description } })));
}
