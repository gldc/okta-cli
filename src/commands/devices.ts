import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose } from "../cli/options";
import { getUser } from "../lib/lookup";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

const DEVICE_USERS_FIELDS = "user.id,user.profile.login,managementStatus,screenLockType,created";
const OS_ACCOUNT_FIELDS = "id,platform,resourceDisplayName.value,lastSeenAt,created";
// Deviation from the plan: UserDevice (the response schema for this endpoint) has no
// `managementStatus` field — that only exists on DeviceUser (`/devices/{id}/users`, the
// reverse lookup below). Dropped it here rather than printing an always-empty column.
const USER_DEVICES_FIELDS = "device.id,device.status,device.profile.displayName,device.profile.platform,created";

export const DEVICES: ResourceSpec = {
  name: "devices", description: "Devices (Okta Device Registration)", path: "/devices", singular: "device",
  nameField: "profile.displayName", defaultFields: "id,status,profile.displayName,profile.platform,profile.osVersion,lastUpdated",
  lifecycle: true, creatable: false, replaceable: false,
  listOptions: [
    { flags: "--search <expr>", param: "search", description: 'SCIM search, e.g. status eq "ACTIVE"' },
    { flags: "--expand <what>", param: "expand", description: "user or userSummary", choices: ["user", "userSummary"] },
  ],
};

// Deviation from the plan: the DeviceAssurance schema calls the timestamp field
// `lastUpdate`, not `lastUpdated`.
export const DEVICE_ASSURANCES: ResourceSpec = {
  name: "device-assurances", description: "Device assurance policies", path: "/device-assurances", singular: "device assurance policy",
  nameField: "name", defaultFields: "id,name,platform,lastUpdate",
};

export function registerDevices(program: Command, ctx: Ctx, usersCmd: Command): Command {
  const d = defineResource(program, ctx, DEVICES);

  for (const verb of ["suspend", "unsuspend"] as const) {
    addOutputOptions(addVerbose(d.command(verb).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} a device`).argument("<device>")), DEVICES.defaultFields)
      .action(action(ctx, async (client, _o, deviceArg) => {
        const device = await resourceGet(client, DEVICES, deviceArg);
        const rv = await client.json("POST", `/devices/${device.id}/lifecycle/${verb}`);
        return rv ?? `device ${device.id} (${device.profile?.displayName ?? ""}) ${verb}ed`;
      }));
  }

  addOutputOptions(addVerbose(d.command("users").description("List the users associated with a device").argument("<device>")), DEVICE_USERS_FIELDS)
    .action(action(ctx, async (client, _o, deviceArg) => client.getAll(`/devices/${(await resourceGet(client, DEVICES, deviceArg)).id}/users`)));

  addOutputOptions(addVerbose(d.command("os-accounts").description("List a device's OS accounts").argument("<device>")), OS_ACCOUNT_FIELDS)
    .action(action(ctx, async (client, _o, deviceArg) => client.getAll(`/devices/${(await resourceGet(client, DEVICES, deviceArg)).id}/os-accounts`)));

  addOutputOptions(addVerbose(d.command("os-account").description("Retrieve a device's OS account").argument("<device>").argument("<id>")), OS_ACCOUNT_FIELDS)
    .action(action(ctx, async (client, _o, deviceArg, id) => client.get(`/devices/${(await resourceGet(client, DEVICES, deviceArg)).id}/os-accounts/${id}`)));

  defineResource(program, ctx, DEVICE_ASSURANCES);

  addOutputOptions(addVerbose(usersCmd.command("devices").description("List a user's devices").argument("<user>")
    .option("-f, --user-lookup-field <field>", "profile field to match", "login")), USER_DEVICES_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => client.getAll(`/users/${(await getUser(client, userArg, opts.userLookupField)).id}/devices`)));

  return d;
}
