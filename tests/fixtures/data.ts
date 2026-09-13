import type { Route } from "./server";

export const users = [
  { id: "00u00000000000000001", status: "ACTIVE", profile: { login: "bob@x.com", email: "bob@x.com", firstName: "Bob", lastName: "B" } },
  { id: "00u00000000000000002", status: "ACTIVE", profile: { login: "alice@x.com", email: "alice@x.com", firstName: "Alice", lastName: "A" } },
];
export const groups = [
  { id: "00g1", type: "OKTA_GROUP", profile: { name: "Engineering", description: "eng" } },
  { id: "00g2", type: "APP_GROUP", profile: { name: "Engineering-app", description: null } },
  { id: "00g3", type: "OKTA_GROUP", profile: { name: "Sales", description: "s" } },
];
export const apps = [
  { id: "0oa1", name: "bookmark", label: "Zoom", status: "ACTIVE" },
  { id: "0oa2", name: "slack", label: "Slack", status: "ACTIVE" },
];

/** GET by id for known ids, 404 for unknown ids, list endpoints filtered by ?search= login when present. */
export function standardRoutes(): Route[] {
  const byId = (items: { id: string }[]) => (_req: Request, url: URL) => {
    const id = url.pathname.split("/").pop()!;
    const hit = items.find((i) => i.id === id);
    return hit ? Response.json(hit) : Response.json({ errorCode: "E0000007", errorSummary: `Not found: ${id}`, errorCauses: [] }, { status: 404 });
  };
  return [
    { method: "GET", path: /^\/api\/v1\/users\/[^/]+$/, handler: byId(users) },
    { method: "GET", path: /^\/api\/v1\/groups\/[^/]+$/, handler: byId(groups) },
    { method: "GET", path: /^\/api\/v1\/apps\/[^/]+$/, handler: byId(apps) },
    { method: "GET", path: "/api/v1/users", handler: (_r, url) => {
      const search = url.searchParams.get("search") ?? "";
      const m = search.match(/profile\.(\w+) eq "([^"]+)"/);
      return Response.json(m ? users.filter((u) => (u.profile as any)[m[1]!] === m[2]) : users);
    } },
    { method: "GET", path: "/api/v1/groups", body: groups },
    { method: "GET", path: "/api/v1/apps", body: apps },
  ];
}
