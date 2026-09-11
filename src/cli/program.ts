import { Command, CommanderError } from "commander";
import { registerApps } from "../commands/apps";
import { registerConfig } from "../commands/config";
import { registerEventhooks } from "../commands/eventhooks";
import { registerFeatures } from "../commands/features";
import { registerGroupRules } from "../commands/group-rules";
import { registerGroups } from "../commands/groups";
import { registerInlinehooks } from "../commands/inlinehooks";
import { registerLogs } from "../commands/logs";
import { registerMisc } from "../commands/misc";
import { registerOrg } from "../commands/org";
import { registerPlatform } from "../commands/platform";
import { registerPolicies } from "../commands/policies";
import { registerPw } from "../commands/pw";
import { registerRoles } from "../commands/roles";
import { registerSchemas } from "../commands/schemas";
import { registerTokens } from "../commands/tokens";
import { registerUserTypes } from "../commands/user-types";
import { registerUsers } from "../commands/users";
import { registerUsersBulk } from "../commands/users-bulk";
import { CommunicationError, ExitError, OktaApiError } from "../okta/errors";
import { VERSION } from "../version";
import { ExitSignal, type Ctx } from "./context";
import { mapError } from "./options";

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
  const groupsCmd = registerGroups(program, ctx);
  registerApps(program, ctx);
  registerFeatures(program, ctx);
  registerEventhooks(program, ctx);
  registerLogs(program, ctx);
  registerTokens(program, ctx);
  registerOrg(program, ctx);
  registerRoles(program, ctx, { users: usersCmd, groups: groupsCmd });
  registerPlatform(program, ctx);
  registerInlinehooks(program, ctx);
  registerSchemas(program, ctx, usersCmd);
  registerGroupRules(groupsCmd, ctx);
  registerUserTypes(program, ctx);
  registerPolicies(program, ctx);
  registerMisc(program, ctx);
  return program;
}

export async function runCli(argv: string[], ctx: Ctx): Promise<number> {
  try {
    await buildProgram(ctx).parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    if (e instanceof ExitSignal) return e.code;
    // An error thrown outside any command's action() — e.g. a custom option parser like
    // `int()` throwing while commander parses an argument, before any action() try/catch
    // is even entered. Map the same documented error classes action() maps, the same way.
    // Anything else re-throws unchanged (e.g. a test harness's own control-flow signal for
    // a *mocked* io.exit — action() already turned a real io.exit into one of the above).
    if (e instanceof ExitError || e instanceof CommunicationError || e instanceof OktaApiError) return mapError(ctx, e);
    throw e;
  }
}
