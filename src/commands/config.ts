import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { buildClient, parseKeyText, profileKind } from "../cli/client-factory";
import type { Ctx } from "../cli/context";
import { action, addVerbose, subgroup } from "../cli/options";
import { activeProfile, type Config, type OAuthProfileConfig, type Profile, configPath, inferDefault, loadConfig, saveConfig } from "../config";
import { ExitError } from "../okta/errors";

// SSWS shows `***<last4>` (today's behaviour, unchanged); OAuth has no token to mask, so it
// shows the client id instead.
function authColumn(p: Profile): string {
  return profileKind(p) === "oauth" ? `oauth:${(p as { clientId: string }).clientId}` : `***${(p as { token: string }).token.slice(-4)}`;
}

// Builds an OAuth profile for `config new --client-id`. The key file's contents are stored
// inline (as a JWK object when the file is JSON, else as a PEM string - same rule client-factory
// applies at request time) unless --keep-file-ref asks to keep only the path.
async function oauthProfile(opts: Record<string, any>, url: string): Promise<OAuthProfileConfig> {
  if (!opts.privateKeyFile) throw new ExitError("--private-key-file is required when using --client-id");
  if (!opts.scopes) throw new ExitError("--scopes is required when using --client-id");
  const profile: OAuthProfileConfig = { url, auth: "oauth", clientId: opts.clientId, scopes: opts.scopes.split(/\s+/).filter(Boolean) };
  if (opts.kid) profile.kid = opts.kid;
  if (opts.dpop) profile.dpop = true;
  if (opts.keepFileRef) profile.privateKeyFile = opts.privateKeyFile;
  else profile.privateKey = parseKeyText(await readFile(opts.privateKeyFile, "utf8"));
  return profile;
}

export function registerConfig(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "config", "Manage okta-cli configuration");
  const path = () => configPath(ctx.env);
  const ask = (value: string | undefined, label: string): string => {
    if (value) return value;
    const v = ctx.io.prompt(`${label}: `);
    if (!v) throw new ExitError(`${label} is required`);
    return v;
  };

  g.command("new").description("Create a new configuration profile")
    .option("-n, --name <name>", "Name of the configuration to add.")
    .option("-u, --url <url>", "The base URL of Okta, e.g. 'https://my.okta.com'.")
    .option("-t, --token <token>", "The API token to use (SSWS), mutually exclusive with --client-id")
    .option("--client-id <id>", "OAuth 2.0 service app client ID, mutually exclusive with -t/--token")
    .option("--private-key-file <path>", "path to the service app's private key (PEM or JWK JSON)")
    .option("--kid <kid>", "key id (JWK 'kid'), if the private key doesn't carry one")
    .option("--scopes <scopes>", 'space-separated okta.* scopes, e.g. "okta.users.read okta.groups.read"')
    .option("--dpop", "the service app requires DPoP-bound tokens")
    .option("--keep-file-ref", "store only the --private-key-file path, not its contents")
    .action(action(ctx, async (_c, opts) => {
      if (opts.token && opts.clientId) throw new ExitError("Use either -t or --client-id");
      const name = ask(opts.name, "Name");
      const url = ask(opts.url, "Url").toLowerCase();
      if (!url.startsWith("https://")) throw new ExitError("url must start with 'https://'");
      const file = Bun.file(path());
      const cfg: Config = (await file.exists()) ? ((await file.json()) as Config) : { profiles: {} };
      cfg.profiles ??= {};
      // Infer+persist a default from the state as it existed before this profile was added
      // (a lone pre-existing profile becomes default), then again after adding it (a fresh
      // file's first-ever profile becomes default) — matches loadConfig's inference exactly.
      inferDefault(cfg);
      cfg.profiles[name] = opts.clientId ? await oauthProfile(opts, url) : { url, token: ask(opts.token, "Token") };
      inferDefault(cfg);
      await saveConfig(cfg, path());
      return `Profile '${name}' added.`;
    }, { client: false }));

  g.command("list").description("List all configuration profiles")
    .action(action(ctx, async () => {
      const cfg = await loadConfig(path());
      return Object.entries(cfg.profiles)
        .map(([name, p]) => `${name}  ${p.url}  ${authColumn(p)}${name === cfg.default ? "  (CURRENT)" : ""}`)
        .join("\n");
    }, { client: false }));

  g.command("use-context").description("Set a config profile as default profile").argument("<profile-name>")
    .action(action(ctx, async (_c, _o, name) => {
      const cfg = await loadConfig(path());
      if (!cfg.profiles[name]) throw new ExitError(`Unknown profile name: '${name}'.`);
      cfg.default = name;
      await saveConfig(cfg, path());
      return `Default profile set to '${name}'.`;
    }, { client: false }));

  g.command("delete").description("Delete a config profile").argument("<profile-name>")
    .action(action(ctx, async (_c, _o, name) => {
      const cfg = await loadConfig(path());
      if (!cfg.profiles[name]) throw new ExitError(`Unknown profile name: '${name}'.`);
      delete cfg.profiles[name];
      const lines = [`Profile '${name}' deleted.`];
      if (cfg.default === name) {
        const remaining = Object.keys(cfg.profiles);
        if (remaining.length) { cfg.default = remaining[0]; lines.push(`New default profile: ${remaining[0]}`); }
        else { delete cfg.default; lines.push("No more profiles left."); }
      }
      await saveConfig(cfg, path());
      return lines.join("\n");
    }, { client: false }));

  g.command("file").description("Print the locations of the configuration file")
    .action(action(ctx, () => path(), { client: false }));

  g.command("current-context").description("Print the current default profile")
    .action(action(ctx, async () => {
      const cfg = await loadConfig(path());
      return cfg.default ? `Current profile set to '${cfg.default}'.` : "No profile set.";
    }, { client: false }));

  // Reuses `activeProfile` - the same OKTA_* env override / config-file resolution
  // `ctx.getClient` uses for every other command - so this exercises exactly what a real
  // command would authenticate with.
  addVerbose(g.command("test").description("Check that the current profile can authenticate (GET /org)"))
    .action(action(ctx, async (_c, opts) => {
      const profile = await activeProfile(ctx.env);
      const client = await buildClient(profile, { verbosity: opts.verbose ?? 0, log: (l) => ctx.io.err(l + "\n") }, ctx.env);
      const org = await client.get("/org");
      return `OK ${org.companyName} (${profileKind(profile)})`;
    }, { client: false }));
}
