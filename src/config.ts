import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ExitError } from "./okta/errors";

export interface Profile { url: string; token: string }
export interface Config { profiles: Record<string, Profile>; default?: string }

export function configPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.OKTA_CLI_CONFIG) return env.OKTA_CLI_CONFIG;
  if (platform === "darwin") return join(home, "Library", "Application Support", "okta-cli", "config.json");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "okta-cli", "okta-cli", "config.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "okta-cli", "config.json");
}

// A lone profile is the obvious default even if none was ever set explicitly (mirrors Python's
// load_config/_check_config, which persisted this same inference).
export function inferDefault(cfg: Config): void {
  const names = Object.keys(cfg.profiles);
  if (names.length === 1) cfg.default = names[0];
}

export async function loadConfig(path: string = configPath()): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new ExitError("okta-cli was not configured. Please run with 'config new' command.");
  const cfg = (await file.json()) as Config;
  cfg.profiles ??= {};
  inferDefault(cfg);
  return cfg;
}

export async function saveConfig(cfg: Config, path: string = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(cfg));
}

export function resolveProfile(cfg: Config): Profile {
  if (!cfg.default) throw new ExitError("Default context not configured. Please execute 'okta-cli config use-context CONTEXT'");
  const profile = cfg.profiles[cfg.default];
  if (!profile) throw new ExitError(`Default context '${cfg.default}' does not exist. Either add it or run 'use-context' command to configure a different one.`);
  if (!profile.url.startsWith("https://")) throw new ExitError("ERROR: configured Okta URL does not start with 'https://'. Please fix this.");
  return profile;
}

export async function activeProfile(env: NodeJS.ProcessEnv = process.env): Promise<Profile> {
  if (env.OKTA_URL && env.OKTA_TOKEN) return { url: env.OKTA_URL, token: env.OKTA_TOKEN };
  return resolveProfile(await loadConfig(configPath(env)));
}
