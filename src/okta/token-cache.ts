import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath } from "../config";

export interface CachedToken {
  accessToken: string;
  tokenType: "Bearer" | "DPoP";
  expiresAt: number;
}

type CacheFile = Record<string, CachedToken>;

// On-disk cache for OAuth access tokens, keyed by caller-supplied string (OAuthTokenSource uses
// `${url}|${clientId}|${scopes.join(" ")}`). Lives next to the config file as tokens.json so it
// follows OKTA_CLI_CONFIG the same way the config itself does. Tolerates a missing or corrupt
// file (treated as empty) rather than throwing - a stale/garbled cache should never block auth.
export class TokenCache {
  private readonly path: string;
  private readonly disabled: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env, path?: string) {
    this.path = path ?? join(dirname(configPath(env)), "tokens.json");
    this.disabled = env.OKTA_CLI_NO_TOKEN_CACHE === "1";
  }

  private async readAll(): Promise<CacheFile> {
    if (this.disabled) return {};
    try {
      const file = Bun.file(this.path);
      if (!(await file.exists())) return {};
      const text = await file.text();
      if (!text) return {};
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CacheFile) : {};
    } catch {
      return {};
    }
  }

  async get(key: string): Promise<CachedToken | undefined> {
    if (this.disabled) return undefined;
    const all = await this.readAll();
    return all[key];
  }

  async set(key: string, token: CachedToken): Promise<void> {
    if (this.disabled) return;
    const all = await this.readAll();
    all[key] = token;
    await Bun.write(this.path, JSON.stringify(all));
    await chmod(this.path, 0o600);
  }
}
