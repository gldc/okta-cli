import { defaultCtx } from "./cli/context";
import { runCli } from "./cli/program";

// Set exitCode and let the process end naturally instead of calling process.exit():
// process.exit() terminates immediately, discarding any output still buffered for an
// async destination like a pipe (Bun/Node stdout writes to a pipe are async).
process.exitCode = await runCli(process.argv.slice(2), defaultCtx());
