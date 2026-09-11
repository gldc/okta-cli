import { activeProfile } from "../config";
import { OktaClient } from "../okta/client";

export interface IO {
  out(text: string): void;
  err(text: string): void;
  prompt(question: string): string | null;
  exit(code: number): never;
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
    exit: (code) => process.exit(code),
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
