import type { Command } from "commander";

export interface ToolArg {
  name: string;
  required: boolean;
  variadic: boolean;
}

export interface ToolOpt {
  attr: string;
  long: string;
  kind: "boolean" | "string" | "integer" | "string[]" | "body";
  negate: boolean;
  required: boolean;
  choices?: string[];
  description: string;
  default?: unknown;
}

export interface ToolDef {
  name: string;
  path: string[];
  description: string;
  args: ToolArg[];
  opts: ToolOpt[];
  hasJson: boolean;
  hasNoConfirmation: boolean;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export const EXCLUDED_GROUPS = new Set(["config", "version", "mcp"]);
export const EXCLUDED_OPTS = new Set(["json", "yaml", "csv", "csvDialect", "colwidth", "outputFields", "verbose", "confirmation", "help"]);

export const WRITE_VERBS = [
  "add", "adduser", "create", "update", "replace", "patch", "delete", "remove", "removeuser", "revoke",
  "activate", "deactivate", "reactivate", "suspend", "unsuspend", "unlock", "reset", "set", "assign", "unassign",
  "clear", "expire", "link", "unlink", "publish", "rotate", "generate", "import", "bulk", "subscribe",
  "unsubscribe", "reorder", "allow", "disallow", "upload", "logo", "sync", "execute", "run", "retry", "enable",
  "disable", "promote", "opt", "verify", "send", "test", "cancel", "approve", "deny", "reassign", "resend",
  "close", "reopen", "launch", "end", "start", "stop", "move", "clone", "trigger", "invoke", "register",
  "deregister", "enroll", "unenroll", "grant", "exchange", "migrate", "rename", "preview", "dr", "failover",
];

const DESTRUCTIVE_RE = /(^|-)(delete|remove|removeuser|revoke|deactivate|suspend|clear|expire|unlink|unassign|unsubscribe|reset|cancel|deny|end|stop|unenroll|deregister)($|-)/;

export function toolName(path: string[]): string {
  return path.map((p) => p.replace(/-/g, "_")).join("_");
}

export function humanReadableArgName(arg: { name(): string; required: boolean; variadic: boolean }): string {
  const name = arg.name() + (arg.variadic ? "..." : "");
  return arg.required ? `<${name}>` : `[${name}]`;
}

export function isReadOnly(leaf: Command, path: string[]): boolean {
  const hasJson = leaf.options.some((o) => o.attributeName() === "json");
  if (!hasJson) return false;
  if (leaf.options.some((o) => o.long === "--body" || o.long === "--set")) return false;
  const leafName = path[path.length - 1] ?? "";
  const tokens = leafName.split("-");
  if (tokens.some((t) => WRITE_VERBS.includes(t))) return false;
  return true;
}

function optKind(opt: Command["options"][number]): ToolOpt["kind"] {
  if (opt.long === "--body") return "body";
  if (opt.negate) return "boolean";
  if (!opt.required && !opt.optional) return "boolean";
  const parseArgName = (opt.parseArg as { name?: string } | undefined)?.name;
  if (parseArgName === "int") return "integer";
  if (parseArgName === "collect" || parseArgName === "collectScope" || opt.variadic) return "string[]";
  return "string";
}

function schemaForOpt(opt: ToolOpt): Record<string, unknown> {
  let schema: Record<string, unknown>;
  switch (opt.kind) {
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "string":
      schema = { type: "string" };
      break;
    case "integer":
      schema = { type: "integer" };
      break;
    case "string[]":
      schema = { type: "array", items: { type: "string" } };
      break;
    case "body":
      return {
        anyOf: [{ type: "object" }, { type: "array" }, { type: "string" }],
        description: `${opt.description} Pass a JSON value; FILE: paths are not allowed.`,
      };
  }
  if (opt.choices) schema.enum = opt.choices;
  schema.description = opt.description;
  return schema;
}

function buildOpts(leaf: Command): ToolOpt[] {
  const out: ToolOpt[] = [];
  for (const opt of leaf.options) {
    const attr = opt.attributeName();
    if (EXCLUDED_OPTS.has(attr)) continue;
    const parseArgName = (opt.parseArg as { name?: string } | undefined)?.name;
    if (parseArgName === "count") continue;
    const kind = optKind(opt);
    const toolOpt: ToolOpt = {
      attr,
      long: opt.long ?? "",
      kind,
      negate: opt.negate,
      required: opt.mandatory,
      description: opt.description,
    };
    if (opt.argChoices) toolOpt.choices = opt.argChoices;
    if (opt.negate) toolOpt.default = true;
    else if (opt.defaultValue !== undefined && !(Array.isArray(opt.defaultValue) && opt.defaultValue.length === 0)) {
      toolOpt.default = opt.defaultValue;
    }
    out.push(toolOpt);
  }
  return out;
}

function buildArgs(leaf: Command): ToolArg[] {
  return leaf.registeredArguments.map((a) => ({ name: a.name(), required: a.required, variadic: a.variadic }));
}

function buildDescription(leaf: Command): string {
  const base = leaf.description() ?? "";
  if (leaf.registeredArguments.length === 0) return base;
  const parts = leaf.registeredArguments.map((a) => humanReadableArgName(a));
  return `${base} Positional arguments: ${parts.join(" ")}`;
}

function buildInputSchema(args: ToolArg[], opts: ToolOpt[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of args) {
    properties[arg.name] = arg.variadic
      ? { type: "array", items: { type: "string" }, description: `Positional argument ${arg.name}` }
      : { type: "string", description: `Positional argument ${arg.name}` };
    if (arg.required) required.push(arg.name);
  }
  for (const opt of opts) {
    properties[opt.attr] = schemaForOpt(opt);
    if (opt.required) required.push(opt.attr);
  }
  const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

function walk(cmd: Command, path: string[], out: ToolDef[]): void {
  for (const sub of cmd.commands) {
    const name = sub.name();
    const subPath = [...path, name];
    if (path.length === 0 && EXCLUDED_GROUPS.has(name)) continue;
    if (sub.commands.length === 0) {
      const args = buildArgs(sub);
      const opts = buildOpts(sub);
      const hasJson = sub.options.some((o) => o.attributeName() === "json");
      const hasNoConfirmation = sub.options.some((o) => o.attributeName() === "confirmation");
      const readOnly = isReadOnly(sub, subPath);
      const leafName = subPath[subPath.length - 1] ?? "";
      out.push({
        name: toolName(subPath),
        path: subPath,
        description: buildDescription(sub),
        args,
        opts,
        hasJson,
        hasNoConfirmation,
        readOnly,
        inputSchema: buildInputSchema(args, opts),
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly && DESTRUCTIVE_RE.test(leafName),
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      });
    } else {
      walk(sub, subPath, out);
    }
  }
}

export function buildCatalog(program: Command): ToolDef[] {
  const out: ToolDef[] = [];
  walk(program, [], out);
  return out;
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export interface CatalogFilter {
  readOnly?: boolean;
  include?: string[];
  exclude?: string[];
}

export function filterCatalog(defs: ToolDef[], f: CatalogFilter): ToolDef[] {
  let out = defs;
  if (f.readOnly) out = out.filter((d) => d.readOnly);
  if (f.include && f.include.length > 0) {
    const patterns = f.include.map(globToRegExp);
    out = out.filter((d) => patterns.some((p) => p.test(d.name)));
  }
  if (f.exclude && f.exclude.length > 0) {
    const patterns = f.exclude.map(globToRegExp);
    out = out.filter((d) => !patterns.some((p) => p.test(d.name)));
  }
  return out;
}
