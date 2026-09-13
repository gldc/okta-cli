import type { Ctx } from "../../src/cli/context";
import { runCli } from "../../src/cli/program";
import { OktaClient } from "../../src/okta/client";

export class ExitSentinel extends Error { constructor(public code: number) { super(`exit ${code}`); } }

export function testCtx(serverUrl: string) {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const answers: string[] = [];
  const ctx: Ctx = {
    env: {},
    now: () => new Date("2026-01-02T03:04:05Z"),
    io: {
      out: (t) => { out.push(t); },
      err: (t) => { err.push(t); },
      prompt: () => answers.shift() ?? null,
      exit: (code) => { exits.push(code); throw new ExitSentinel(code); },
    },
    async getClient(verbosity) {
      return new OktaClient(serverUrl, "tok", { sleep: async () => {}, verbosity, log: (l) => err.push(l + "\n") });
    },
  };
  return { ctx, out, err, exits, answers };
}

export async function runTest(argv: string[], ctx: Ctx): Promise<number> {
  try {
    return await runCli(argv, ctx);
  } catch (e) {
    if (e instanceof ExitSentinel) return e.code;
    throw e;
  }
}
