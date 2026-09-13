import { describe, expect, test } from "bun:test";
import { knownPath } from "../src/okta/spec-paths";
import type { Schema } from "../src/okta/types";

describe("spec paths", () => {
  test("known and unknown", () => {
    expect(knownPath("/users")).toBe(true);
    expect(knownPath("/users/abc/lifecycle/deactivate")).toBe(true);
    expect(knownPath("/api/v1/groups/00g1/users/00u1")).toBe(true);
    expect(knownPath("/eventHooks")).toBe(true);
    expect(knownPath("/nope/at/all")).toBe(false);
  });
  test("full paths outside /api/v1 are matched without an /api/v1 prefix", () => {
    expect(knownPath("/attack-protection/api/v1/authenticator-settings")).toBe(true);
    expect(knownPath("/integrations/api/v1/api-services")).toBe(true);
    expect(knownPath("/security/api/v1/security-events")).toBe(true);
    expect(knownPath("/privileged-access/api/v1/containers/x/resources")).toBe(true);
    expect(knownPath("/okta-personal-settings/api/v1/edit-feature")).toBe(true);
    expect(knownPath("/webauthn-registration/api/v1/enroll")).toBe(true);
  });
  test("schema types are usable", () => {
    const u: Schema<"User"> = { id: "x", profile: { login: "a@b" } } as Schema<"User">;
    expect(u.id).toBe("x");
  });
});
