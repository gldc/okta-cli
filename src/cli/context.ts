import { activeProfile } from "../config";
import { OktaClient } from "../okta/client";

export interface IO {
  out(text: string): void;
  err(text: string): void;
  prompt(question: string): string | null;
  exit(code: number): never;
}

// Thrown by the default `io.exit` instead of calling `process.exit` directly.
// `process.exit` terminates the process immediately, discarding any output
// still buffered for an async destination (e.g. a pipe) — see main.ts. Throwing
// unwinds back to `runCli`, which turns this into the process exit code once
// the event loop (and therefore stdout/stderr) has actually drained.
export class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

export interface Ctx {
  io: IO;
  getClient(verbosity: number): Promise<OktaClient>;
  now(): Date;
  env: NodeJS.ProcessEnv;
}

export function defaultCtx(): Ctx {
  const io: IO = {
    out: (t) => { process.stdout.write(t); },
    err: (t) => { process.stderr.write(t); },
    prompt: (q) => prompt(q),
    exit: (code) => { throw new ExitSignal(code); },
  };
  return {
    io,
    env: process.env,
    now: () => new Date(),
    async getClient(verbosity) {
      const p = await activeProfile(process.env);
      return new OktaClient(p.url, p.token, { verbosity, log: (l) => io.err(l + "\n") });
    },
  };
}
