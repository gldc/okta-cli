import { afterEach, describe, expect, test } from "bun:test";
import { filterDicts } from "../src/lib/filter";
import { getApp, getGroup, getOne, getUser, retrieve, selectOktaGroup } from "../src/lib/lookup";
import { OktaClient } from "../src/okta/client";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());
const client = () => new OktaClient(srv.url, "tok", { sleep: async () => {} });

const groups = [
  { id: "00g1", type: "OKTA_GROUP", profile: { name: "Engineering" } },
  { id: "00g2", type: "APP_GROUP", profile: { name: "Engineering-app" } },
  { id: "00g3", type: "OKTA_GROUP", profile: { name: "Sales" } },
];

describe("lookup", () => {
  test("retrieve by id first, falls back to filtered list", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/groups/00g3", body: groups[2] },
      { method: "GET", path: /^\/api\/v1\/groups\/.+/, status: 404, body: { errorSummary: "nf" } },
      { method: "GET", path: "/api/v1/groups", body: groups },
    ]);
    expect(await retrieve(client(), "groups", "00g3")).toEqual(groups[2]);
    expect(await retrieve(client(), "groups", "eng", { selector: selectOktaGroup("eng") })).toEqual([groups[0]]);
  });
  test("getOne uniqueness errors", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/groups\/.+/, status: 404, body: {} },
      { method: "GET", path: "/api/v1/groups", body: groups },
    ]);
    expect(await getGroup(client(), "sales")).toEqual(groups[2]);
    await expect(getOne(client(), "groups", "e", { selector: (g) => g.profile.name.includes("E") })).rejects.toThrow("Name for groups must be unique. (found 2 matches).");
    await expect(getGroup(client(), "zzz")).rejects.toThrow("No matching groups found.");
  });
  test("getUser searches by lookup field; getApp matches label", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/users\/.+/, status: 404, body: {} },
      { method: "GET", path: "/api/v1/users", body: [{ id: "u1", profile: { login: "a@x" } }] },
      { method: "GET", path: /^\/api\/v1\/apps\/.+/, status: 404, body: {} },
      { method: "GET", path: "/api/v1/apps", body: [{ id: "a1", label: "Slack" }, { id: "a2", label: "Zoom" }] },
    ]);
    expect(await getUser(client(), "a@x", "email")).toEqual({ id: "u1", profile: { login: "a@x" } });
    expect(srv.calls.find((c) => c.path === "/api/v1/users")!.query.search).toBe('profile.email eq "a@x"');
    expect(await getApp(client(), "sla")).toEqual({ id: "a1", label: "Slack" });
  });
});

describe("filterDicts", () => {
  const items = [{ profile: { firstName: "Hans", city: "Berlin" } }, { profile: { firstName: "Hansi" } }];
  test("full match vs partial, case-insensitive, missing key excluded", () => {
    expect(filterDicts(items, { "profile.firstName": "hans" }, false)).toEqual([items[0]]);
    expect(filterDicts(items, { "profile.firstName": "hans" }, true)).toEqual(items);
    expect(filterDicts(items, { "profile.city": "ber.*" }, false)).toEqual([items[0]]);
    expect(filterDicts(items, {}, false)).toEqual(items);
  });
});
