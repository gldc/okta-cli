import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import { getUser } from "../lib/lookup";
import { ExitError } from "../okta/errors";

const ORG_FIELDS = "id,companyName,subdomain,status,website";
const SUPPORT_FIELDS = "support,expiration";

export function registerOrg(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "org", "Org settings");
  addOutputOptions(addVerbose(g.command("get").description("Show org settings")), ORG_FIELDS).action(action(ctx, (client) => client.get("/org")));
  addOutputOptions(addVerbose(g.command("update").description("Partially update org settings (POST /org)")
    .option("-b, --body <json>", "JSON body").option("-s, --set <k=v>", "set a field", collect, [])), ORG_FIELDS)
    .action(action(ctx, (client, opts) => {
      const body = parseBody(opts.body, opts.set);
      if (body === undefined) throw new ExitError("Provide -b and/or -s");
      return client.json("POST", "/org", { body });
    }));
  addOutputOptions(addVerbose(g.command("contacts").description("List org contact types")), "contactType").action(action(ctx, (client) => client.getAll("/org/contacts")));
  addOutputOptions(addVerbose(g.command("contact").description("Show the user for a contact type (BILLING, TECHNICAL)").argument("<type>")), "userId")
    .action(action(ctx, (client, _o, type) => client.get(`/org/contacts/${type}`)));
  addOutputOptions(addVerbose(g.command("set-contact").description("Set the user for a contact type").argument("<type>")
    .requiredOption("-u, --user <user>", "user id or lookup value").option("-f, --user-lookup-field <field>", "profile field to match", "login")), "userId")
    .action(action(ctx, async (client, opts, type) => {
      const u = await getUser(client, opts.user, opts.userLookupField);
      return client.json("PUT", `/org/contacts/${type}`, { body: { userId: u.id } });
    }));
  addOutputOptions(addVerbose(g.command("support").description("Show Okta Support access setting")), SUPPORT_FIELDS).action(action(ctx, (client) => client.get("/org/privacy/oktaSupport")));
  for (const verb of ["grant", "extend", "revoke"] as const) {
    addOutputOptions(addVerbose(g.command(`support-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} Okta Support access`)), SUPPORT_FIELDS)
      .action(action(ctx, (client) => client.json("POST", `/org/privacy/oktaSupport/${verb}`)));
  }
}
