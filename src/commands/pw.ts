import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addVerbose, int, subgroup } from "../cli/options";
import { buildPassphrase, generatePassword } from "../lib/pwgen";
import { ExitError } from "../okta/errors";

export function registerPw(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "pw", "Manage passwords");

  addVerbose(g.command("reset").description("Reset the password of a user").argument("<login-or-id>").option("-n, --no-email", "Do not send the reset email"))
    .action(action(ctx, (client, opts, id) => client.json("POST", `/users/${id}/lifecycle/reset_password`, { query: { sendEmail: opts.email === false ? "false" : "true" } })));

  addVerbose(g.command("expire").description("Expire the password of a user").argument("<login-or-id>").option("-t, --temp-password", "Set a temporary password"))
    .action(action(ctx, (client, opts, id) => {
      const query: Record<string, string> = {};
      query["tempPassword"] = opts.tempPassword ? "true" : "false";
      return client.json("POST", `/users/${id}/lifecycle/expire_password`, { query });
    }));

  addVerbose(g.command("set").description("Set a user's password").argument("<login-or-id>")
    .option("-s, --set <password>", "set password to this")
    .option("-g, --generate", "generate a random password")
    .option("--expire", "expire password (default: yes)").option("--no-expire")
    .option("-l, --language <lang>", "use a word list from this language (en, de)", "en")
    .option("-m, --min-length <n>", "minimal password length", int, 14))
    .action(action(ctx, async (client, opts, id) => {
      let pw: string | undefined = opts.set;
      if (opts.generate) {
        const numWords = Math.max(3, Math.floor(opts.minLength / 5 + 3));
        pw = buildPassphrase(generatePassword(numWords, opts.language), opts.minLength);
      } else if (!pw) throw new ExitError("Either use -s or -g!");
      const body: Record<string, unknown> = { credentials: {} };
      (body.credentials as Record<string, unknown>)["password"] = { value: pw };
      await client.json("POST", `/users/${id}`, { body });
      const expire = opts.expire ?? true;
      if (expire) {
        const q: Record<string, string> = {};
        q["tempPassword"] = "false";
        await client.json("POST", `/users/${id}/lifecycle/expire_password`, { query: q });
      }
      return `PASSWORD${expire ? "_EXPIRED" : ""}: ${expire ? pw : "********"}`;
    }));
}
