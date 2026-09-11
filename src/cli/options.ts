import { Command } from "commander";
import { formatResult } from "../lib/output";
import type { OktaClient } from "../okta/client";
import { CommunicationError, ExitError, OktaApiError } from "../okta/errors";
import type { Ctx } from "./context";

export const collect = (v: string, prev: string[]): string[] => [...prev, v];
export const count = (_: string, prev: number): number => prev + 1;
export const int = (v: string): number => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new ExitError(`Expected an integer, got '${v}'`);
  return n;
};

export function addVerbose(cmd: Command): Command {
  return cmd.option("-v, --verbose", "Increase verbosity (-vvvvv for full DEBUG logging)", count, 0);
}

export function addOutputOptions(cmd: Command, defaultFields: string | null): Command {
  cmd.option("-j, --json", "Print raw JSON output")
    .option("-y, --yaml", "Print raw YAML output")
    .option("--csv", "Print output as CSV format. Will ignore --output-fields parameter if set")
    .option("--csv-dialect <dialect>", "Use this CSV dialect with CSV output (excel, excel-tab, unix)", "excel")
    .option("--colwidth <n>", "Limit column width; default: unlimited", int);
  if (defaultFields) cmd.option("--output-fields <fields>", "Override default fields in table format", defaultFields);
  else cmd.option("--output-fields <fields>", "Fields to print in table format (default: JSON output)");
  return cmd;
}

export function subgroup(parent: Command, name: string, description: string): Command {
  return parent.command(name).description(description).helpOption("-h, --help");
}

export type Handler = (client: OktaClient, opts: Record<string, any>, ...args: string[]) => Promise<unknown> | unknown;

// Maps the documented error classes to their output + exit code (Global Constraints).
// Shared by `action()` (errors thrown from a command handler) and `runCli()` (errors
// thrown by commander itself while parsing option arguments, e.g. a custom parser
// like `int()` — those happen outside any `action()` call's try/catch).
export function mapError(ctx: Ctx, e: unknown): number {
  if (e instanceof ExitError) { ctx.io.err(`ERROR: ${e.message}\n`); return 255; }
  if (e instanceof CommunicationError) { ctx.io.err(`COMMUNICATION_ERROR: ${e.message}\n`); return 255; }
  if (e instanceof OktaApiError) {
    ctx.io.out(`OKTA_API_ERROR: ${e.errorCode}: ${e.message}\n`);
    for (const cause of e.errorCauses) for (const [k, v] of Object.entries(cause)) ctx.io.out(`${k}: ${v}\n`);
    return 253;
  }
  const err = e as Error;
  ctx.io.err(`${err.stack ?? String(err)}\n`);
  ctx.io.err(`\n*****************************************************************************\nCRITICAL_ERROR: ${err.name ?? typeof e}\n\nPlease report at the issues page with details of what you did. Thank you!\n-> https://github.com/gldc/okta-cli/issues\n*****************************************************************************\n\n`);
  return 254;
}

export function action(ctx: Ctx, handler: Handler, options: { client?: boolean } = {}) {
  return async (...cmdArgs: unknown[]): Promise<void> => {
    cmdArgs.pop(); // Command instance
    const opts = (cmdArgs.pop() ?? {}) as Record<string, any>;
    const args = cmdArgs as string[];
    try {
      const client = options.client === false ? (undefined as unknown as OktaClient) : await ctx.getClient(opts.verbose ?? 0);
      const rv = await handler(client, opts, ...args);
      const text = formatResult(rv, opts, (m) => ctx.io.err(m + "\n"));
      if (text !== undefined) ctx.io.out(text.endsWith("\n") ? text : text + "\n");
    } catch (e) {
      ctx.io.exit(mapError(ctx, e));
    }
  };
}
