import type { Command } from "commander";
import { profileKind } from "../cli/client-factory";
import type { Ctx } from "../cli/context";
import { action, subgroup } from "../cli/options";
import { type Config, type Profile, configPath, inferDefault, loadConfig, saveConfig } from "../config";
import { ExitError } from "../okta/errors";

// SSWS shows `***<last4>` (today's behaviour, unchanged); OAuth has no token to mask, so it
// shows the client id instead.
function authColumn(p: Profile): string {
  return profileKind(p) === "oauth" ? `oauth:${(p as { clientId: string }).clientId}` : `***${(p as { token: string }).token.slice(-4)}`;
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
    .option("-t, --token <token>", "The API token to use")
    .action(action(ctx, async (_c, opts) => {
      const name = ask(opts.name, "Name");
      const url = ask(opts.url, "Url").toLowerCase();
      const token = ask(opts.token, "Token");
      if (!url.startsWith("https://")) throw new ExitError("url must start with 'https://'");
      const file = Bun.file(path());
      const cfg: Config = (await file.exists()) ? ((await file.json()) as Config) : { profiles: {} };
      cfg.profiles ??= {};
      // Infer+persist a default from the state as it existed before this profile was added
      // (a lone pre-existing profile becomes default), then again after adding it (a fresh
      // file's first-ever profile becomes default) — matches loadConfig's inference exactly.
      inferDefault(cfg);
      cfg.profiles[name] = { url, token };
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
}
