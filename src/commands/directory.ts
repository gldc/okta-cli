import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, subgroup } from "../cli/options";
import { defineResource, type ResourceSpec } from "./resource";
import { addRoleTarget, deleteRoleTarget, roleAssignmentBody, roleTargetGroupsAndApps, ROLE_TYPES, type RoleTargetOpts } from "./roles";

const AGENT_POOL_FIELDS = "id,name,type,agentCount";
// Deviation from the plan: AgentPoolUpdate has no top-level `scheduled` field (only a nested
// `schedule` object), so it's dropped from the default fields.
const AGENT_POOL_UPDATE_FIELDS = "id,name,status,enabled,targetVersion";
const IDENTITY_SOURCE_SESSION_FIELDS = "id,identitySourceId,status,importType,created";
const IDENTITY_SOURCE_USER_FIELDS = "externalId,profile.userName,profile.email";
// Deviation from the plan: GroupsResponseSchema double-nests the group profile under
// `profile.profile` (not `profile`).
const IDENTITY_SOURCE_GROUP_FIELDS = "externalId,id,profile.profile.displayName";
const CLIENT_ROLE_FIELDS = "id,type,label,status,assignmentType";
const OAUTH2_BASE = "/oauth2/v1";

export const UI_SCHEMAS: ResourceSpec = {
  name: "ui-schemas", description: "UI schemas for enrollment forms", path: "/meta/uischemas", singular: "UI schema",
  nameField: "id", defaultFields: "id,uiSchema.type,created", replaceable: true,
};

const AGENT_TYPES = ["AD", "IWA", "LDAP", "MFA", "OPP", "RUM", "Radius"];

function registerAgentPools(program: Command, ctx: Ctx): void {
  const ap = subgroup(program, "agent-pools", "Agent pools (AD/LDAP/IWA/... agent auto-update)");

  addOutputOptions(addVerbose(ap.command("list").description("List all agent pools")
    .addOption(new Option("--pool-type <t>", "agent type to search for").choices(AGENT_TYPES))
    .option("--limit-per-pool-type <n>", "maximum number of agent pools returned per pool type")), AGENT_POOL_FIELDS)
    .action(action(ctx, async (client, opts) => {
      const pools: any[] = await client.getAll("/agentPools", { query: { poolType: opts.poolType, limitPerPoolType: opts.limitPerPoolType } });
      return pools.map((p) => ({ ...p, agentCount: p.agents?.length }));
    }));

  addOutputOptions(addVerbose(ap.command("updates").description("List all updates for an agent pool").argument("<poolId>")
    .option("--scheduled", "only scheduled updates")), AGENT_POOL_UPDATE_FIELDS)
    .action(action(ctx, (client, opts, poolId) => client.getAll(`/agentPools/${poolId}/updates`, { query: { scheduled: opts.scheduled } })));

  addOutputOptions(addVerbose(ap.command("update").description("Retrieve an agent pool update by id").argument("<poolId>").argument("<updateId>")), AGENT_POOL_UPDATE_FIELDS)
    .action(action(ctx, (client, _o, poolId, updateId) => client.get(`/agentPools/${poolId}/updates/${updateId}`)));

  addOutputOptions(addVerbose(bodyOpts(ap.command("update-add").description("Create an agent pool update").argument("<poolId>"))), AGENT_POOL_UPDATE_FIELDS)
    .action(action(ctx, (client, opts, poolId) => client.json("POST", `/agentPools/${poolId}/updates`, { body: bodyFromOpts(opts) })));

  // Deviation from the plan: there's no PUT for an agent pool update - updateAgentPoolsUpdate
  // is a POST to the same /updates/{updateId} path.
  addOutputOptions(addVerbose(bodyOpts(ap.command("update-replace").description("Update an agent pool update").argument("<poolId>").argument("<updateId>"))), AGENT_POOL_UPDATE_FIELDS)
    .action(action(ctx, (client, opts, poolId, updateId) => client.json("POST", `/agentPools/${poolId}/updates/${updateId}`, { body: bodyFromOpts(opts) })));

  addVerbose(ap.command("update-delete").description("Delete an agent pool update").argument("<poolId>").argument("<updateId>"))
    .action(action(ctx, async (client, _o, poolId, updateId) => {
      await client.json("DELETE", `/agentPools/${poolId}/updates/${updateId}`);
      return `agent pool update ${updateId} deleted from pool ${poolId}`;
    }));

  for (const verb of ["activate", "deactivate", "pause", "resume", "retry", "stop"] as const) {
    addOutputOptions(addVerbose(ap.command(`update-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} an agent pool update`).argument("<poolId>").argument("<updateId>")), AGENT_POOL_UPDATE_FIELDS)
      .action(action(ctx, (client, _o, poolId, updateId) => client.json("POST", `/agentPools/${poolId}/updates/${updateId}/${verb}`)));
  }

  addOutputOptions(addVerbose(ap.command("update-settings").description("Retrieve an agent pool's auto-update settings").argument("<poolId>")), null)
    .action(action(ctx, (client, _o, poolId) => client.get(`/agentPools/${poolId}/updates/settings`)));

  // Deviation from the plan: updateAgentPoolsUpdateSettings is a POST, not a PUT.
  addOutputOptions(addVerbose(bodyOpts(ap.command("update-settings-set").description("Update an agent pool's auto-update settings").argument("<poolId>"))), null)
    .action(action(ctx, (client, opts, poolId) => client.json("POST", `/agentPools/${poolId}/updates/settings`, { body: bodyFromOpts(opts) })));
}

// Deviation from the plan: the identity-sources API has no list-all endpoint for users or
// groups (only create + single-item get/replace/update/delete by external id), so `users`
// and `groups` list subcommands don't exist - only the single-item `user`/`group` gets below.
function registerIdentitySources(program: Command, ctx: Ctx): void {
  const is = subgroup(program, "identity-sources", "Custom identity sources (bring-your-own-directory bulk imports)");

  addOutputOptions(addVerbose(is.command("sessions").description("List all sessions for an identity source").argument("<source>")), IDENTITY_SOURCE_SESSION_FIELDS)
    .action(action(ctx, (client, _o, source) => client.getAll(`/identity-sources/${source}/sessions`)));

  addOutputOptions(addVerbose(is.command("session-add").description("Create an identity source session").argument("<source>")), IDENTITY_SOURCE_SESSION_FIELDS)
    .action(action(ctx, (client, _o, source) => client.json("POST", `/identity-sources/${source}/sessions`)));

  addOutputOptions(addVerbose(is.command("session").description("Retrieve an identity source session").argument("<source>").argument("<session>")), IDENTITY_SOURCE_SESSION_FIELDS)
    .action(action(ctx, (client, _o, source, session) => client.get(`/identity-sources/${source}/sessions/${session}`)));

  addVerbose(is.command("session-delete").description("Delete an identity source session").argument("<source>").argument("<session>"))
    .action(action(ctx, async (client, _o, source, session) => {
      await client.json("DELETE", `/identity-sources/${source}/sessions/${session}`);
      return `identity source session ${session} deleted`;
    }));

  addVerbose(is.command("start-import").description("Start the import described by a session's uploaded bulk operations").argument("<source>").argument("<session>"))
    .action(action(ctx, async (client, _o, source, session) => {
      await client.json("POST", `/identity-sources/${source}/sessions/${session}/start-import`);
      return `import started for identity source ${source} session ${session}`;
    }));

  // Deviation from the plan: the wire path for both membership bulk operations is
  // `bulk-group-memberships-{upsert,delete}`, not `bulk-memberships-*`.
  const bulkOps: [string, string][] = [
    ["bulk-upsert", "bulk-upsert"], ["bulk-delete", "bulk-delete"],
    ["bulk-groups-upsert", "bulk-groups-upsert"], ["bulk-groups-delete", "bulk-groups-delete"],
    ["bulk-memberships-upsert", "bulk-group-memberships-upsert"], ["bulk-memberships-delete", "bulk-group-memberships-delete"],
  ];
  for (const [cmd, wire] of bulkOps) {
    addVerbose(bodyOpts(is.command(cmd).description(`Upload ${cmd.replace("bulk-", "")} data for an identity source session`).argument("<source>").argument("<session>")))
      .action(action(ctx, async (client, opts, source, session) => {
        await client.json("POST", `/identity-sources/${source}/sessions/${session}/${wire}`, { body: bodyFromOpts(opts) });
        return `${cmd} uploaded for identity source ${source} session ${session}`;
      }));
  }

  addOutputOptions(addVerbose(is.command("user").description("Retrieve an identity source user by external id").argument("<source>").argument("<externalId>")), IDENTITY_SOURCE_USER_FIELDS)
    .action(action(ctx, (client, _o, source, externalId) => client.get(`/identity-sources/${source}/users/${externalId}`)));

  addOutputOptions(addVerbose(is.command("group").description("Retrieve an identity source group by Okta group id or external id").argument("<source>").argument("<groupOrExternalId>")), IDENTITY_SOURCE_GROUP_FIELDS)
    .action(action(ctx, (client, _o, source, groupOrExternalId) => client.get(`/identity-sources/${source}/groups/${groupOrExternalId}`)));

  addOutputOptions(addVerbose(is.command("group-members").description("List the member external ids of an identity source group").argument("<source>").argument("<groupOrExternalId>")), "memberExternalId")
    .action(action(ctx, async (client, _o, source, groupOrExternalId) => {
      const rv = await client.get(`/identity-sources/${source}/groups/${groupOrExternalId}/membership`);
      return (rv.memberExternalIds ?? []).map((memberExternalId: string) => ({ memberExternalId }));
    }));

  addOutputOptions(addVerbose(bodyOpts(is.command("group-add").description("Create a group in an identity source").argument("<source>"))), IDENTITY_SOURCE_GROUP_FIELDS)
    .action(action(ctx, (client, opts, source) => client.json("POST", `/identity-sources/${source}/groups`, { body: bodyFromOpts(opts) })));

  addVerbose(is.command("group-member-delete").description("Delete a member from an identity source group's membership").argument("<source>").argument("<groupOrExternalId>").argument("<memberExternalId>"))
    .action(action(ctx, async (client, _o, source, groupOrExternalId, memberExternalId) => {
      await client.json("DELETE", `/identity-sources/${source}/groups/${groupOrExternalId}/membership/${memberExternalId}`);
      return `member ${memberExternalId} removed from identity source ${source} group ${groupOrExternalId}`;
    }));
}

function registerOauthClients(program: Command, ctx: Ctx): void {
  const oc = subgroup(program, "oauth-clients", "Admin role assignments on OAuth 2.0 clients");

  addOutputOptions(addVerbose(oc.command("roles").description("List admin role assignments of an OAuth 2.0 client").argument("<clientId>")), CLIENT_ROLE_FIELDS)
    .action(action(ctx, (client, _o, clientId) => client.getAll(`/clients/${clientId}/roles`, { basePath: OAUTH2_BASE })));

  addOutputOptions(addVerbose(oc.command("assign-role").description("Assign an admin role to an OAuth 2.0 client").argument("<clientId>")
    .addOption(new Option("-t, --type <ROLE_TYPE>", "role type").choices(ROLE_TYPES).makeOptionMandatory())
    .option("--role <id-or-label>", "custom role (with -t CUSTOM)").option("--resource-set <id>", "resource set (with -t CUSTOM)")), CLIENT_ROLE_FIELDS)
    .action(action(ctx, (client, opts, clientId) => client.json("POST", `/clients/${clientId}/roles`, { basePath: OAUTH2_BASE, body: roleAssignmentBody(opts as { type: string; role?: string; resourceSet?: string }) })));

  addVerbose(oc.command("unassign-role").description("Remove an admin role assignment from an OAuth 2.0 client").argument("<clientId>").argument("<assignmentId>"))
    .action(action(ctx, async (client, _o, clientId, assignmentId) => {
      await client.json("DELETE", `/clients/${clientId}/roles/${assignmentId}`, { basePath: OAUTH2_BASE });
      return `role assignment ${assignmentId} removed from OAuth 2.0 client ${clientId}`;
    }));

  addOutputOptions(addVerbose(oc.command("role-targets").description("List the group and app targets of an OAuth 2.0 client's role assignment").argument("<clientId>").argument("<assignmentId>")), null)
    .action(action(ctx, (client, _o, clientId, assignmentId) => roleTargetGroupsAndApps(client, `/clients/${clientId}/roles/${assignmentId}`, { basePath: OAUTH2_BASE })));

  const clientTargetOpts = (cmd: Command) => cmd.option("-g, --group <group>", "group id or unique name")
    .option("--app-name <name>", "OIN catalog app key name (APP_ADMIN roles)")
    .option("--app-id <appId>", "app instance id (with --app-name)");

  addVerbose(clientTargetOpts(oc.command("role-target-add").description("Add a group or app target to an OAuth 2.0 client's role assignment").argument("<clientId>").argument("<assignmentId>")))
    .action(action(ctx, async (client, opts, clientId, assignmentId) => {
      const label = await addRoleTarget(client, `/clients/${clientId}/roles/${assignmentId}`, opts as RoleTargetOpts, { basePath: OAUTH2_BASE });
      return `${label} added as a target of role assignment ${assignmentId} on client ${clientId}`;
    }));

  addVerbose(clientTargetOpts(oc.command("role-target-delete").description("Remove a group or app target from an OAuth 2.0 client's role assignment").argument("<clientId>").argument("<assignmentId>")))
    .action(action(ctx, async (client, opts, clientId, assignmentId) => {
      const label = await deleteRoleTarget(client, `/clients/${clientId}/roles/${assignmentId}`, opts as RoleTargetOpts, { basePath: OAUTH2_BASE });
      return `${label} removed as a target of role assignment ${assignmentId} on client ${clientId}`;
    }));
}

function registerFirstPartyApp(program: Command, ctx: Ctx): void {
  const fpa = subgroup(program, "first-party-app", "Settings for an Okta first-party app (e.g. Admin Console)");
  addOutputOptions(addVerbose(fpa.command("get").description("Retrieve the settings for an Okta first-party app").argument("<appName>")), null)
    .action(action(ctx, (client, _o, appName) => client.get(`/first-party-app-settings/${appName}`)));
  addOutputOptions(addVerbose(bodyOpts(fpa.command("set").description("Replace the settings for an Okta first-party app").argument("<appName>"))), null)
    .action(action(ctx, (client, opts, appName) => client.json("PUT", `/first-party-app-settings/${appName}`, { body: bodyFromOpts(opts) })));
}

function registerDirectories(program: Command, ctx: Ctx): void {
  const d = subgroup(program, "directories", "Active Directory / LDAP bidirectional group management");
  addOutputOptions(addVerbose(bodyOpts(d.command("groups-modify").description("Update an external directory group's membership directly in AD/LDAP").argument("<appInstanceId>"))), null)
    .action(action(ctx, (client, opts, appInstanceId) => client.json("POST", `/directories/${appInstanceId}/groups/modify`, { body: bodyFromOpts(opts) })));
  addOutputOptions(addVerbose(bodyOpts(d.command("group-query").description("Submit an AD group attribute query").argument("<appInstanceId>").argument("<groupId>"))), null)
    .action(action(ctx, (client, opts, appInstanceId, groupId) => client.json("POST", `/directories/${appInstanceId}/groups/${groupId}/query`, { body: bodyFromOpts(opts) })));
  addOutputOptions(addVerbose(d.command("group-query-result").description("Retrieve the results of an AD group attribute query").argument("<appInstanceId>").argument("<groupId>").argument("<resultId>")), null)
    .action(action(ctx, (client, _o, appInstanceId, groupId, resultId) => client.get(`/directories/${appInstanceId}/groups/${groupId}/query/${resultId}`)));
}

export function registerDirectory(program: Command, ctx: Ctx): void {
  registerAgentPools(program, ctx);
  registerIdentitySources(program, ctx);
  registerOauthClients(program, ctx);
  defineResource(program, ctx, UI_SCHEMAS);
  registerFirstPartyApp(program, ctx);
  registerDirectories(program, ctx);
}
