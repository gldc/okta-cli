import { ExitSignal, type Ctx } from "../cli/context";
import { OktaClient, type Method, type RequestOptions } from "../okta/client";
import { ExitError } from "../okta/errors";
import type { ToolDef } from "./catalog";

// Wraps an already-built client without re-running auth: Object.create(client) preserves the
// prototype chain (and therefore private fields captured by the original constructor) while
// letting us override request()/upload() on the instance. `super` calls go through
// OktaClient.prototype.request.call(client, ...) so they run with the original client's `this`.
export function readOnlyClient(client: OktaClient): OktaClient {
  const wrapper = Object.create(client) as OktaClient;
  wrapper.request = async (method: Method, path: string, opts?: RequestOptions) => {
    if (method !== "GET") throw new ExitError(`read-only mode: refusing ${method} ${path}`);
    return OktaClient.prototype.request.call(client, method, path, opts);
  };
  wrapper.upload = async (path: string) => {
    throw new ExitError(`read-only mode: refusing upload to ${path}`);
  };
  return wrapper;
}

export interface InvokeDeps {
  getClient: () => Promise<OktaClient>;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  // `src/cli/program.ts` imports `registerMcp` (src/commands/mcp.ts), which reaches this module -
  // a static top-level import of `runCli` back from program.ts would be a cycle. Callers may pass
  // it explicitly; otherwise it's loaded lazily on first use.
  runCli?: (argv: string[], ctx: Ctx) => Promise<number>;
}

let cachedRunCli: ((argv: string[], ctx: Ctx) => Promise<number>) | undefined;
async function defaultRunCli(argv: string[], ctx: Ctx): Promise<number> {
  cachedRunCli ??= (await import("../cli/program")).runCli;
  return cachedRunCli(argv, ctx);
}

export interface InvokeResult {
  code: number;
  stdout: string;
  stderr: string;
}

function optionTokens(def: ToolDef, input: Record<string, unknown>, opt: ToolDef["opts"][number]): string[] {
  const v = input[opt.attr];
  if (v === undefined || v === null) return [];
  switch (opt.kind) {
    case "boolean":
      if (opt.negatedLong) return v === true ? [opt.long] : v === false ? [opt.negatedLong] : [];
      if (opt.negate) return v === false ? [opt.long] : [];
      return v === true ? [opt.long] : [];
    case "string":
      if (opt.isPath) throw new ExitError(`${opt.attr} is a local file path and is rejected in MCP mode`);
      if (typeof v !== "string" && typeof v !== "number") throw new ExitError(`${opt.attr} must be a string`);
      return [`${opt.long}=${v}`];
    case "integer": {
      if (typeof v !== "number" || !Number.isInteger(v)) throw new ExitError(`${opt.attr} must be an integer`);
      return [`${opt.long}=${v}`];
    }
    case "string[]": {
      const arr = Array.isArray(v) ? v : [v];
      return arr.map((item) => `${opt.long}=${String(item)}`);
    }
    case "body": {
      if (typeof v === "string") {
        if (v.startsWith("FILE:")) throw new ExitError("FILE: bodies are not allowed in MCP mode");
        return [`${opt.long}=${v}`];
      }
      return [`${opt.long}=${JSON.stringify(v)}`];
    }
    default:
      return [];
  }
}

export function buildArgv(def: ToolDef, input: Record<string, unknown>): string[] {
  const knownKeys = new Set<string>([...def.args.map((a) => a.key), ...def.opts.map((o) => o.attr)]);
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) throw new ExitError(`unknown argument: ${key}`);
  }

  const optionArgv: string[] = [];
  for (const opt of def.opts) optionArgv.push(...optionTokens(def, input, opt));
  if (def.hasJson) optionArgv.push("--json");
  if (def.hasNoConfirmation) optionArgv.push("--no-confirmation");

  const positionalArgv: string[] = [];
  let sawMissingOptional = false;
  for (const arg of def.args) {
    const v = input[arg.key];
    if (v === undefined || v === null) {
      if (arg.required) throw new ExitError(`missing positional argument ${arg.name}`);
      sawMissingOptional = true;
      continue;
    }
    if (sawMissingOptional) throw new ExitError(`missing positional argument before ${arg.name}`);
    if (arg.isPath) throw new ExitError(`${arg.name} is a local file path and is rejected in MCP mode`);
    if (arg.variadic) {
      const arr = Array.isArray(v) ? v : [v];
      positionalArgv.push(...arr.map((item) => String(item)));
    } else {
      positionalArgv.push(String(v));
    }
  }

  return positionalArgv.length > 0
    ? [...def.path, ...optionArgv, "--", ...positionalArgv]
    : [...def.path, ...optionArgv];
}

export async function invokeTool(def: ToolDef, input: Record<string, unknown>, deps: InvokeDeps): Promise<InvokeResult> {
  let argv: string[];
  try {
    argv = buildArgv(def, input);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { code: 255, stdout: "", stderr: `ERROR: ${message}\n` };
  }

  const out: string[] = [];
  const err: string[] = [];
  const ctx: Ctx = {
    env: deps.env,
    now: deps.now ?? (() => new Date()),
    io: {
      out: (t) => { out.push(t); },
      err: (t) => { err.push(t); },
      prompt: () => null,
      exit: (code) => { throw new ExitSignal(code); },
    },
    getClient: () => deps.getClient(),
  };

  try {
    const code = await (deps.runCli ?? defaultRunCli)(argv, ctx);
    return { code, stdout: out.join(""), stderr: err.join("") };
  } catch (e) {
    return { code: 254, stdout: out.join(""), stderr: String(e) };
  }
}

export function toCallToolResult(r: InvokeResult): { content: { type: "text"; text: string }[]; isError?: boolean } {
  if (r.code !== 0) {
    const text = `exit code ${r.code}\n${(r.stdout + r.stderr).trim()}`;
    return { content: [{ type: "text", text }], isError: true };
  }
  const text = r.stdout.trim() || "ok";
  return { content: [{ type: "text", text }] };
}
