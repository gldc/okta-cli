import { Command, CommanderError } from "commander";
import { registerApps } from "../commands/apps";
import { registerConfig } from "../commands/config";
import { registerGroups } from "../commands/groups";
import { registerPw } from "../commands/pw";
import { registerUsers } from "../commands/users";
import { registerUsersBulk } from "../commands/users-bulk";
import { VERSION } from "../version";
import type { Ctx } from "./context";

export function buildProgram(ctx: Ctx): Command {
  const program = new Command("okta-cli")
    .description('Okta CLI helper.\n\nSee subcommands for help: "okta-cli users --help" etc.\n\nIf in doubt start with: "okta-cli config new --help"')
    .version(VERSION, "--version")
    .helpOption("-h, --help")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: (s) => ctx.io.out(s), writeErr: (s) => ctx.io.err(s) });
  program.command("version").description("Print version number and exit").action(() => ctx.io.out(VERSION + "\n"));
  registerConfig(program, ctx);
  const usersCmd = registerUsers(program, ctx);
  registerUsersBulk(usersCmd, ctx);
  registerPw(program, ctx);
  registerGroups(program, ctx);
  registerApps(program, ctx);
  // registerFeatures(program, ctx); registerEventhooks(program, ctx); ← Task 14
  // registerMisc(program, ctx);    ← Task 15
  return program;
}

export async function runCli(argv: string[], ctx: Ctx): Promise<number> {
  try {
    await buildProgram(ctx).parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    throw e;
  }
}
