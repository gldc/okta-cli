import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { getOne, retrieve, selectField } from "../lib/lookup";

const FIELDS = "id,created,status,verificationStatus,name";

export function eventHookBody(url: string, name: string, events: string[]): Record<string, unknown> {
  return {
    name,
    events: { type: "EVENT_TYPE", items: events.flatMap((e) => e.split(",")).map((s) => s.trim()).filter(Boolean) },
    channel: { type: "HTTP", version: "1.0.0", config: { uri: url } },
  };
}

const hookOpts = (cmd: Command) => cmd
  .requiredOption("-u, --url <url>", "The URL where the events will be sent to by Okta")
  .requiredOption("-n, --name <name>", "A short name (description) of the event hook")
  .requiredOption("-e, --event <events>", "Event types (comma separated or multiple -e)", collect);
const getHook = (client: any, partial: string) => getOne(client, "eventHooks", partial, { selector: selectField("name", partial) });

export function registerEventhooks(program: Command, ctx: Ctx): Command {
  const g = subgroup(program, "eventhooks", "Event hook operations");

  addOutputOptions(addVerbose(g.command("list").description("Lists event hooks").argument("[partial_name]")), FIELDS)
    .action(action(ctx, (client, _o, partial?: string) => retrieve(client, "eventHooks", undefined, { selector: partial ? selectField("name", partial) : undefined })));

  addOutputOptions(addVerbose(g.command("get").description("Retrieves one event hook").argument("<partial_name>")), FIELDS)
    .action(action(ctx, (client, _o, partial) => getHook(client, partial)));

  addOutputOptions(addVerbose(hookOpts(g.command("add").description("Creates a new event hook"))), FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/eventHooks", { body: eventHookBody(opts.url, opts.name, opts.event) })));

  addOutputOptions(addVerbose(hookOpts(g.command("update").description("Updates an event hook").argument("<partial_name>"))), FIELDS)
    .action(action(ctx, async (client, opts, partial) => {
      const existing = await getHook(client, partial);
      return client.json("PUT", `/eventHooks/${existing.id}`, { body: eventHookBody(opts.url, opts.name, opts.event) });
    }));

  for (const verb of ["activate", "deactivate", "verify"] as const) {
    addOutputOptions(addVerbose(g.command(verb).description(`${verb[0]!.toUpperCase()}${verb.slice(1)}s an event hook`).argument("<partial_name>")), FIELDS)
      .action(action(ctx, async (client, _o, partial) => {
        const existing = await getHook(client, partial);
        return client.json("POST", `/eventHooks/${existing.id}/lifecycle/${verb}`);
      }));
  }

  addVerbose(g.command("delete").description("Deletes an event hook").argument("<partial_name>"))
    .action(action(ctx, async (client, _o, partial) => {
      const existing = await getHook(client, partial);
      await client.json("DELETE", `/eventHooks/${existing.id}`);
      return `event hook ${existing.id} (${existing.name}) deleted`;
    }));
  return g;
}
