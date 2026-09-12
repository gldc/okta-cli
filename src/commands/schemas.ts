import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, int, subgroup } from "../cli/options";
import { isPlainObject } from "../lib/dotted";
import { getApp, getUser } from "../lib/lookup";
import { defineResource, type ResourceSpec } from "./resource";

const PROPERTY_FIELDS = "name,scope,type,title,required,mutability";

export const LINKED_OBJECTS: ResourceSpec = { name: "linked-objects", description: "Linked object definitions (user relationships)", path: "/meta/schemas/user/linkedObjects", singular: "linked object definition", nameField: "primary.name", defaultFields: "primary.name,primary.title,associated.name,associated.title", replaceable: false, creatable: false, idField: "primary.name" };

export function flattenSchemaProperties(schema: any): any[] {
  const rows: any[] = [];
  for (const defScope of ["base", "custom"] as const) {
    const properties = schema?.definitions?.[defScope]?.properties ?? {};
    for (const [name, raw] of Object.entries<any>(properties)) {
      const p = isPlainObject(raw) ? raw : {};
      const { type, title, required, mutability, ...rest } = p;
      rows.push({ ...rest, name, scope: defScope, type, title, required: !!required, mutability });
    }
  }
  return rows.sort((a, b) => (a.scope === b.scope ? String(a.name).localeCompare(String(b.name)) : String(a.scope).localeCompare(String(b.scope))));
}

export interface SchemaPropertyOpts {
  name: string;
  type?: string;
  title?: string;
  description?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  enum?: string;
  itemsType?: string;
  schemaId?: string;
  mutability?: string;
  permissions?: string;
}

export function schemaPropertyBody(opts: SchemaPropertyOpts): Record<string, unknown> {
  const type = opts.type ?? "string";
  const [principal, permAction] = (opts.permissions ?? "SELF:READ_WRITE").split(":");
  const enumValues = opts.enum ? opts.enum.split(",") : undefined;
  const prop: Record<string, unknown> = {
    title: opts.title ?? opts.name,
    description: opts.description,
    type,
    required: !!opts.required,
    mutability: opts.mutability ?? "READ_WRITE",
    scope: "NONE",
    permissions: [{ principal, action: permAction }],
    minLength: opts.minLength,
    maxLength: opts.maxLength,
    enum: enumValues,
    oneOf: enumValues?.map((v) => ({ const: v, title: v })),
    items: type === "array" ? { type: opts.itemsType } : undefined,
  };
  for (const k of Object.keys(prop)) if (prop[k] === undefined) delete prop[k];
  return { definitions: { custom: { id: "#custom", type: "object", properties: { [opts.name]: prop } } } };
}

function removePropertyBody(name: string): Record<string, unknown> {
  return { definitions: { custom: { id: "#custom", type: "object", properties: { [name]: null } } } };
}

export function registerSchemas(program: Command, ctx: Ctx, usersCmd: Command): void {
  const schemas = subgroup(program, "schemas", "Profile schemas (user, group, app)");
  const userGrp = subgroup(schemas, "user", "User profile schema");
  const groupGrp = subgroup(schemas, "group", "Group profile schema");
  const appGrp = subgroup(schemas, "app", "App profile schema");

  addOutputOptions(addVerbose(userGrp.command("get").description("Get the user profile schema").argument("[schemaId]", "profile schema id", "default")), null)
    .action(action(ctx, (client, _o, schemaId) => client.get(`/meta/schemas/user/${schemaId}`)));

  addOutputOptions(addVerbose(userGrp.command("properties").description("List base and custom profile properties").argument("[schemaId]", "profile schema id", "default")), PROPERTY_FIELDS)
    .action(action(ctx, async (client, _o, schemaId) => flattenSchemaProperties(await client.get(`/meta/schemas/user/${schemaId}`))));

  addOutputOptions(addVerbose(userGrp.command("add-property").description("Add a custom property to the user profile schema")
    .requiredOption("-n, --name <name>")
    .addOption(new Option("-t, --type <type>", "property type").choices(["string", "boolean", "integer", "number", "array"]).default("string"))
    .option("--title <title>").option("--description <description>").option("--required")
    .option("--min-length <n>", "minimum string length", int).option("--max-length <n>", "maximum string length", int)
    .option("--enum <a,b,c>", "comma separated allowed values")
    .option("--items-type <type>", "item type (for --type array)", "string")
    .option("--schema-id <id>", "profile schema id", "default")
    .addOption(new Option("--mutability <mutability>", "mutability").choices(["READ_WRITE", "READ_ONLY"]).default("READ_WRITE"))
    .option("--permissions <PRINCIPAL:ACTION>", "permission entry", "SELF:READ_WRITE")), PROPERTY_FIELDS)
    .action(action(ctx, async (client, opts) => {
      const schemaId = opts.schemaId ?? "default";
      const rsp = await client.json("POST", `/meta/schemas/user/${schemaId}`, { body: schemaPropertyBody(opts as SchemaPropertyOpts) });
      return flattenSchemaProperties(rsp);
    }));

  addVerbose(userGrp.command("remove-property").description("Remove a custom property from the user profile schema")
    .requiredOption("-n, --name <name>").option("--schema-id <id>", "profile schema id", "default"))
    .action(action(ctx, async (client, opts) => {
      const schemaId = opts.schemaId ?? "default";
      await client.json("POST", `/meta/schemas/user/${schemaId}`, { body: removePropertyBody(opts.name) });
      return `custom property ${opts.name} removed from schema ${schemaId}`;
    }));

  addOutputOptions(addVerbose(groupGrp.command("get").description("Get the group profile schema")), null)
    .action(action(ctx, (client) => client.get("/meta/schemas/group/default")));

  addOutputOptions(addVerbose(groupGrp.command("properties").description("List group profile properties")), PROPERTY_FIELDS)
    .action(action(ctx, async (client) => flattenSchemaProperties(await client.get("/meta/schemas/group/default"))));

  addOutputOptions(addVerbose(appGrp.command("get").description("Get an app's profile schema").argument("<app>")), null)
    .action(action(ctx, async (client, _o, appArg) => {
      const app = await getApp(client, appArg);
      return client.get(`/meta/schemas/apps/${app.id}/default`);
    }));

  addOutputOptions(addVerbose(appGrp.command("properties").description("List an app's profile properties").argument("<app>")), PROPERTY_FIELDS)
    .action(action(ctx, async (client, _o, appArg) => {
      const app = await getApp(client, appArg);
      return flattenSchemaProperties(await client.get(`/meta/schemas/apps/${app.id}/default`));
    }));

  const lo = defineResource(program, ctx, LINKED_OBJECTS);
  addOutputOptions(addVerbose(lo.command("add").description("Create a linked object definition")
    .requiredOption("--primary-name <name>").requiredOption("--primary-title <title>")
    .requiredOption("--associated-name <name>").requiredOption("--associated-title <title>")
    .option("--primary-description <description>").option("--associated-description <description>")), LINKED_OBJECTS.defaultFields)
    .action(action(ctx, (client, opts) => client.json("POST", "/meta/schemas/user/linkedObjects", {
      body: {
        primary: { name: opts.primaryName, title: opts.primaryTitle, description: opts.primaryDescription, type: "USER" },
        associated: { name: opts.associatedName, title: opts.associatedTitle, description: opts.associatedDescription, type: "USER" },
      },
    })));

  addOutputOptions(addVerbose(usersCmd.command("linked").description("List a user's linked objects for a relationship name").argument("<user>").argument("<relationship>")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login")), "_links.self.href")
    .action(action(ctx, async (client, opts, userArg, relationship) => {
      const user = await getUser(client, userArg, opts.userLookupField);
      const rsp = await client.request("GET", `/users/${user.id}/linkedObjects/${relationship}`);
      return rsp.json();
    }));

  addVerbose(usersCmd.command("link").description("Link a user to a primary user via a relationship name").argument("<user>")
    .requiredOption("--to <primary-user>", "the primary user").requiredOption("--rel <primaryRelationshipName>", "the primary relationship name")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login"))
    .action(action(ctx, async (client, opts, userArg) => {
      const user = await getUser(client, userArg, opts.userLookupField);
      const primary = await getUser(client, opts.to, opts.userLookupField);
      await client.json("PUT", `/users/${user.id}/linkedObjects/${opts.rel}/${primary.id}`);
      return `user ${user.id} linked to ${primary.id} via ${opts.rel}`;
    }));

  addVerbose(usersCmd.command("unlink").description("Remove a linked-object relationship from a user").argument("<user>").argument("<relationship>")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login"))
    .action(action(ctx, async (client, opts, userArg, relationship) => {
      const user = await getUser(client, userArg, opts.userLookupField);
      await client.json("DELETE", `/users/${user.id}/linkedObjects/${relationship}`);
      return `relationship ${relationship} removed from user ${user.id}`;
    }));
}
