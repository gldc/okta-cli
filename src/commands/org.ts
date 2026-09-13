import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, collect, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import { getUser } from "../lib/lookup";
import { ExitError } from "../okta/errors";

const ORG_FIELDS = "id,companyName,subdomain,status,website";
const SUPPORT_FIELDS = "support,expiration";
// Deviation from the plan: OktaSupportCase has no top-level `status`/`accessLevel`/`updated`
// fields - only `caseNumber`, `subject`, and nested `impersonation`/`selfAssigned` statuses.
const SUPPORT_CASE_FIELDS = "caseNumber,subject,impersonation.status,impersonation.expiration";

function enabledDisabledBody(opts: { enabled?: boolean; disabled?: boolean }, field: string): Record<string, boolean> {
  if (!opts.enabled && !opts.disabled) throw new ExitError("Provide --enabled or --disabled");
  return { [field]: !!opts.enabled };
}

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

  addOutputOptions(addVerbose(g.command("preferences").description("Show org preferences")), null).action(action(ctx, (client) => client.get("/org/preferences")));
  addOutputOptions(addVerbose(g.command("footer").addOption(new Option("--show", "show the end-user footer").conflicts("hide")).addOption(new Option("--hide", "hide the end-user footer").conflicts("show")).description("Show or hide the Okta End-User Dashboard footer")), null)
    .action(action(ctx, (client, opts) => {
      if (!opts.show && !opts.hide) throw new ExitError("Provide --show or --hide");
      return client.json("POST", `/org/preferences/${opts.show ? "showEndUserFooter" : "hideEndUserFooter"}`);
    }));

  addOutputOptions(addVerbose(g.command("third-party-admin").description("Show the third-party admin setting")), null).action(action(ctx, (client) => client.get("/org/orgSettings/thirdPartyAdminSetting")));
  addOutputOptions(addVerbose(g.command("third-party-admin-set").addOption(new Option("--enabled", "enable third-party admins").conflicts("disabled")).addOption(new Option("--disabled", "disable third-party admins").conflicts("enabled")).description("Update the third-party admin setting")), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/org/orgSettings/thirdPartyAdminSetting", { body: enabledDisabledBody(opts, "thirdPartyAdmin") })));

  addOutputOptions(addVerbose(g.command("communication").description("Show Okta communication email settings")), null).action(action(ctx, (client) => client.get("/org/privacy/oktaCommunication")));
  for (const [verb, wire] of [["opt-in", "optIn"], ["opt-out", "optOut"]] as const) {
    addOutputOptions(addVerbose(g.command(`communication-${verb}`).description(`Opt org users ${verb === "opt-in" ? "in to" : "out of"} Okta communication emails`)), null)
      .action(action(ctx, (client) => client.json("POST", `/org/privacy/oktaCommunication/${wire}`)));
  }

  addOutputOptions(addVerbose(g.command("aerial").description("Show Okta Aerial consent details")), null).action(action(ctx, (client) => client.get("/org/privacy/aerial")));
  addOutputOptions(addVerbose(bodyOpts(g.command("aerial-grant").description("Grant Okta Aerial access to your org"))), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/org/privacy/aerial/grant", { body: bodyFromOpts(opts) })));
  addOutputOptions(addVerbose(g.command("aerial-revoke").description("Revoke Okta Aerial access to your org")), null)
    .action(action(ctx, (client) => client.json("POST", "/org/privacy/aerial/revoke")));

  addOutputOptions(addVerbose(g.command("support-cases").description("List Okta Support cases")), SUPPORT_CASE_FIELDS)
    .action(action(ctx, (client) => client.getAll("/org/privacy/oktaSupport/cases", { listKey: "supportCases" })));
  // Deviation from the plan: there's no GET for a single support case in the spec (only the
  // PATCH below), so there's no `support-case` get command.
  addOutputOptions(addVerbose(bodyOpts(g.command("support-case-set").description("Update an Okta Support case").argument("<caseNumber>"))), SUPPORT_CASE_FIELDS)
    .action(action(ctx, (client, opts, caseNumber) => client.json("PATCH", `/org/privacy/oktaSupport/cases/${caseNumber}`, { body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(bodyOpts(g.command("email-bounces-remove").description("Remove email addresses from the email-service bounce list"))), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/org/email/bounces/remove-list", { body: bodyFromOpts(opts) })));

  addOutputOptions(addVerbose(g.command("admin-app-assignment").description("Show the auto-assign admin app setting")), null).action(action(ctx, (client) => client.get("/org/settings/autoAssignAdminAppSetting")));
  addOutputOptions(addVerbose(g.command("admin-app-assignment-set").addOption(new Option("--enabled", "enable auto-assign").conflicts("disabled")).addOption(new Option("--disabled", "disable auto-assign").conflicts("enabled")).description("Update the auto-assign admin app setting")), null)
    .action(action(ctx, (client, opts) => client.json("POST", "/org/settings/autoAssignAdminAppSetting", { body: enabledDisabledBody(opts, "autoAssignAdminAppSetting") })));

  addOutputOptions(addVerbose(g.command("client-privileges").description("Show the default public client app role setting")), null).action(action(ctx, (client) => client.get("/org/settings/clientPrivilegesSetting")));
  addOutputOptions(addVerbose(g.command("client-privileges-set").addOption(new Option("--enabled", "assign super admin by default to new public client apps").conflicts("disabled")).addOption(new Option("--disabled", "don't assign super admin by default").conflicts("enabled")).description("Update the default public client app role setting")), null)
    .action(action(ctx, (client, opts) => client.json("PUT", "/org/settings/clientPrivilegesSetting", { body: enabledDisabledBody(opts, "clientPrivilegesSetting") })));

  // Deviation from the plan: `/api/v1/orgs` has no GET in the spec (only POST to create a
  // child org), so there's no `children` list command.
}
