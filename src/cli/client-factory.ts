import { readFile } from "node:fs/promises";
import type { OAuthProfileConfig, Profile } from "../config";
import { OktaClient, type ClientOptions } from "../okta/client";
import { ExitError } from "../okta/errors";
import { OAuthTokenSource, type OAuthProfile } from "../okta/oauth";
import { TokenCache } from "../okta/token-cache";

// The discriminant is the OAuth-only `auth: "oauth"` field - an SswsProfile never has it.
export function profileKind(profile: Profile): "ssws" | "oauth" {
  return "auth" in profile && profile.auth === "oauth" ? "oauth" : "ssws";
}

// A private key that arrived as text (an env var or a file's contents) is a JWK when it's
// JSON, else it's treated as a PEM string. Exported for reuse by `config new --client-id`
// (src/commands/config.ts), which stores a --private-key-file's contents the same way.
export function parseKeyText(text: string): JsonWebKey | string {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as JsonWebKey;
  } catch {
    // Not JSON - fall through to PEM.
  }
  return text;
}

async function resolvePrivateKey(profile: OAuthProfileConfig): Promise<JsonWebKey | string> {
  if (profile.privateKeyFile) return parseKeyText(await readFile(profile.privateKeyFile, "utf8"));
  if (typeof profile.privateKey === "string") return parseKeyText(profile.privateKey);
  if (profile.privateKey) return profile.privateKey;
  throw new ExitError(`OAuth profile for '${profile.url}' needs either privateKey or privateKeyFile`);
}

// Builds the OktaClient matching a config profile's auth kind. Used by Ctx.getClient
// (src/cli/context.ts) and reusable from config commands (e.g. `config test`).
// `privateKeyFile` is only read here, at client-build time - listing/editing profiles never
// touches the filesystem for a key they don't need yet.
export async function buildClient(profile: Profile, opts: ClientOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<OktaClient> {
  if (profileKind(profile) === "ssws") {
    const p = profile as { url: string; token: string };
    return new OktaClient(p.url, p.token, opts);
  }
  const p = profile as OAuthProfileConfig;
  const privateKey = await resolvePrivateKey(p);
  const oauthProfile: OAuthProfile = { url: p.url, clientId: p.clientId, privateKey, kid: p.kid, scopes: p.scopes, dpop: p.dpop };
  // Forwards the same verbosity/log the resulting OktaClient uses, so -v/-vvv also cover the
  // OAuth token request (oauth.ts), not just resource requests.
  const source = new OAuthTokenSource(oauthProfile, { cache: new TokenCache(env), verbosity: opts.verbosity, log: opts.log });
  return new OktaClient(p.url, { kind: "oauth", source }, opts);
}
