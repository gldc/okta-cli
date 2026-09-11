import type { OktaClient, Query } from "../okta/client";
import { ExitError, OktaApiError } from "../okta/errors";
import { getDotted } from "./dotted";

export type Selector = (item: any) => boolean;

export const selectProfileField = (field: string, value: string): Selector => {
  const v = value.toLowerCase();
  return (x) => String(x?.profile?.[field] ?? "").toLowerCase().includes(v);
};
export const selectOktaGroup = (value: string): Selector => {
  const byName = selectProfileField("name", value);
  return (x) => x?.type === "OKTA_GROUP" && byName(x);
};
export const selectField = (field: string, value: string): Selector => {
  const v = value.toLowerCase();
  return (x) => String(getDotted(x, field) ?? "").toLowerCase().includes(v);
};

export async function retrieve(client: OktaClient, thing: string, possibleId: string | undefined, opts: { selector?: Selector; query?: Query } = {}): Promise<any> {
  if (possibleId !== undefined && possibleId !== null && possibleId !== "") {
    try {
      return await client.get(`/${thing}/${encodeURIComponent(possibleId)}`);
    } catch (e) {
      if (!(e instanceof OktaApiError)) throw e;
    }
  }
  const things = await client.getAll(`/${thing}`, { query: opts.query });
  return opts.selector ? things.filter(opts.selector) : things;
}

export async function getOne(client: OktaClient, thing: string, possibleId: string | undefined, opts: { selector?: Selector; query?: Query } = {}): Promise<any> {
  const things = await retrieve(client, thing, possibleId, opts);
  if (!Array.isArray(things)) return things;
  if (things.length > 1) throw new ExitError(`Name for ${thing} must be unique. (found ${things.length} matches).`);
  if (things.length === 0) throw new ExitError(`No matching ${thing} found.`);
  return things[0];
}

export const getUser = (client: OktaClient, user: string, lookupField = "login") =>
  getOne(client, "users", user, { query: { search: `profile.${lookupField} eq "${user}"` } });
export const getGroup = (client: OktaClient, group: string) => getOne(client, "groups", group, { selector: selectOktaGroup(group) });
export const getApp = (client: OktaClient, app: string) => getOne(client, "apps", app, { selector: selectField("label", app) });
