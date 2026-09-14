import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, int, subgroup } from "../cli/options";
import type { Query } from "../okta/client";
import { ExitError } from "../okta/errors";
import { GOV_V2 } from "./governance";

const TASK_FIELDS = "id,status,type,label,requestId,createdAt,updatedAt";

// The spec's PATCH body field `assignees` is `task-assignees[]`, an array of {externalId,
// type} objects (gov-schema.d.ts "task-assignees"), not bare ids - per the plan, `-s` can't
// build that (it only ever produces string leaves), so -b is required rather than
// offering a `--assignee <id>` flag.
function taskAssigneesBody(opts: Record<string, any>): unknown {
  if (opts.body === undefined) throw new ExitError("Provide -b (assignees is an array of {externalId, type} objects, which -s can't build)");
  return bodyFromOpts(opts);
}

export function registerGovernanceTasks(g: Command, ctx: Ctx): void {
  const tasks = subgroup(g, "tasks", "Access request tasks (approvals, questions, to-dos assigned to a delegate/approver)");

  addOutputOptions(addVerbose(tasks.command("list").description("List tasks")
    .option("-f, --filter <expr>", "Okta filter expression")
    .option("--order-by <expr>", 'property + " asc"/" desc"')
    .option("--limit <n>", "Maximum number of results (client-side cap; never sent as a query parameter)", int)), TASK_FIELDS)
    .action(action(ctx, (client, opts) => {
      const query: Query = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.orderBy) query.orderBy = opts.orderBy;
      return client.getAll("/tasks", { basePath: GOV_V2, listKey: "data", query, max: opts.limit });
    }));

  addOutputOptions(addVerbose(tasks.command("get").description("Get one task by id").argument("<taskId>")), TASK_FIELDS)
    .action(action(ctx, (client, _opts, taskId) => client.json("GET", `/tasks/${encodeURIComponent(taskId)}`, { basePath: GOV_V2 })));

  addOutputOptions(addVerbose(bodyOpts(tasks.command("update").description("Reassign a task (-b required; object body: {assignees: [{externalId, type}, ...]})").argument("<taskId>"))), TASK_FIELDS)
    .action(action(ctx, (client, opts, taskId) => client.json("PATCH", `/tasks/${encodeURIComponent(taskId)}`, { basePath: GOV_V2, body: taskAssigneesBody(opts) })));

  addOutputOptions(addVerbose(tasks.command("resolve").description("Resolve a task with a value").argument("<taskId>")
    .requiredOption("--value <v>", "the task's resolution value")), TASK_FIELDS)
    .action(action(ctx, (client, opts, taskId) => client.json("POST", `/tasks/${encodeURIComponent(taskId)}/resolve`, { basePath: GOV_V2, body: { value: opts.value } })));
}
