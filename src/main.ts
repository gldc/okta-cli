import { defaultCtx } from "./cli/context";
import { runCli } from "./cli/program";

process.exit(await runCli(process.argv.slice(2), defaultCtx()));
