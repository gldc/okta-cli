import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts, int } from "../cli/options";
import { parseBody } from "../lib/body";
import { getUser } from "../lib/lookup";
import type { OktaClient, Query } from "../okta/client";
import { ExitError } from "../okta/errors";
import { IDPS } from "./idps";
import { resourceGet } from "./resource";

const FACTOR_FIELDS = "id,factorType,provider,status,created";
const QUESTION_FIELDS = "question,questionText";
const ENROLLMENT_FIELDS = "id,type,key,status,created";
const RISK_GET_FIELDS = "riskLevel";
const RISK_SET_FIELDS = "riskLevel,reason";
const CLASSIFICATION_FIELDS = "type,lastUpdated";
const CLIENT_TOKEN_FIELDS = "id,status,created,expiresAt,scopes";
const IDP_TOKEN_FIELDS = "id,tokenType,tokenAuthScheme,expiresAt,scopes";
const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"];
const CLASSIFICATION_TYPES = ["STANDARD", "LITE"];

const WEBAUTHN_REG_BASE = "/webauthn-registration/api/v1";

const userLookupOpt = (cmd: Command) => cmd.option("-f, --user-lookup-field <field>", "Users are matched against the ID or this profile field; default: 'login'.", "login");
const resolveUser = (client: OktaClient, opts: Record<string, any>, userArg: string) => getUser(client, userArg, opts.userLookupField);

export function registerUsersSecurity2(usersCmd: Command, ctx: Ctx): void {
  // Credential flows
  // Deviation from the plan: changePassword/changeRecoveryQuestion/forgotPassword(SetNewPassword)
  // all return UserCredentials or ForgotPasswordResponse, never a User - USER_FIELDS (profile.login
  // etc.) doesn't exist on those responses, so default output is JSON instead.
  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("change-password").description("Change a user's password").argument("<user>")
    .requiredOption("--old <password>", "current password").requiredOption("--new <password>", "new password")
    .option("--strict", "validate against the password minimum age policy"))), null)
    .action(action(ctx, async (client, opts, userArg) => {
      const user = await resolveUser(client, opts, userArg);
      const body = { oldPassword: { value: opts.old }, newPassword: { value: opts.new } };
      return client.json("POST", `/users/${user.id}/credentials/change_password`, { body, query: opts.strict ? { strict: true } : {} });
    }));

  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("forgot-password").description("Start (or complete via recovery question) the forgot-password flow").argument("<user>")
    .option("--send-email", "send a forgot-password email (default: true)").option("--no-send-email", "return a reset link instead of sending email")
    .option("--new <password>", "new password (completes the flow via recovery question)").option("--answer <answer>", "recovery question answer"))), null)
    .action(action(ctx, async (client, opts, userArg) => {
      if (opts.new !== undefined && opts.answer === undefined) throw new ExitError("--new requires --answer");
      const user = await resolveUser(client, opts, userArg);
      if (opts.new !== undefined) {
        const body: Record<string, unknown> = { recovery_question: { answer: opts.answer } };
        body["password"] = { value: opts.new };
        return client.json("POST", `/users/${user.id}/credentials/forgot_password_recovery_question`, { body });
      }
      return client.json("POST", `/users/${user.id}/credentials/forgot_password`, { query: { sendEmail: opts.sendEmail === false ? false : true } });
    }));

  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("change-recovery-question").description("Change a user's recovery question").argument("<user>")
    .requiredOption("--pw <password>", "current password").requiredOption("--question <question>", "the recovery question")
    .requiredOption("--answer <answer>", "the recovery question answer"))), null)
    .action(action(ctx, async (client, opts, userArg) => {
      const user = await resolveUser(client, opts, userArg);
      const body: Record<string, unknown> = { recovery_question: { question: opts.question, answer: opts.answer } };
      body["password"] = { value: opts.pw };
      return client.json("POST", `/users/${user.id}/credentials/change_recovery_question`, { body });
    }));

  addVerbose(userLookupOpt(usersCmd.command("expire-password-temp").description("Expire a user's password, resetting it to a returned temporary password").argument("<user>")
    .option("--revoke-sessions", "also revoke the user's existing sessions")))
    .action(action(ctx, async (client, opts, userArg) => {
      const user = await resolveUser(client, opts, userArg);
      const rv = await client.json("POST", `/users/${user.id}/lifecycle/expire_password_with_temp_password`, { query: opts.revokeSessions ? { revokeSessions: true } : {} });
      if (!rv) throw new ExitError("no temporary credential returned");
      return `TEMP_PASSWORD${""}: ${rv.tempPassword}`;
    }));

  // Factors
  addOutputOptions(addVerbose(userLookupOpt(bodyOpts(usersCmd.command("factor-enroll").description("Enroll a factor for a user").argument("<user>")
    .option("--activate", "immediately activate the factor").option("--update-phone", "replace the currently registered phone number")
    .option("--template-id <id>", "custom SMS template id").option("--token-lifetime-seconds <n>", "how long the enrollment token remains valid", int)))), FACTOR_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => {
      const user = await resolveUser(client, opts, userArg);
      const query: Query = {};
      if (opts.updatePhone) query.updatePhone = true;
      if (opts.templateId !== undefined) query.templateId = opts.templateId;
      if (opts.tokenLifetimeSeconds !== undefined) query.tokenLifetimeSeconds = opts.tokenLifetimeSeconds;
      if (opts.activate) query.activate = true;
      return client.json("POST", `/users/${user.id}/factors`, { body: bodyFromOpts(opts), query });
    }));

  addOutputOptions(addVerbose(userLookupOpt(bodyOpts(usersCmd.command("factor-activate").description("Activate a user's factor").argument("<user>").argument("<factorId>")))), FACTOR_FIELDS)
    .action(action(ctx, async (client, opts, userArg, factorId) => {
      const user = await resolveUser(client, opts, userArg);
      const body = parseBody(opts.body, opts.set);
      return client.json("POST", `/users/${user.id}/factors/${factorId}/lifecycle/activate`, body !== undefined ? { body } : {});
    }));

  // Deviation from the plan: verifyFactor's response is UserFactorVerifyResponse (factorResult,
  // expiresAt, factorMessage) - not a UserFactor - so default output is JSON, not FACTOR_FIELDS.
  addOutputOptions(addVerbose(userLookupOpt(bodyOpts(usersCmd.command("factor-verify").description("Verify (or issue a challenge for) a user's factor").argument("<user>").argument("<factorId>")
    .option("--template-id <id>", "custom SMS template id").option("--token-lifetime-seconds <n>", "how long the verification remains valid", int)
    .option("--accept-language <lang>", "ISO 639-1 language code for the challenge message")
    .option("--x-forwarded-for <ip>", "public IP address of the user agent").option("--user-agent <ua>", "user agent making the request")))), null)
    .action(action(ctx, async (client, opts, userArg, factorId) => {
      const user = await resolveUser(client, opts, userArg);
      const body = parseBody(opts.body, opts.set);
      const query: Query = {};
      if (opts.templateId !== undefined) query.templateId = opts.templateId;
      if (opts.tokenLifetimeSeconds !== undefined) query.tokenLifetimeSeconds = opts.tokenLifetimeSeconds;
      const headers: Record<string, string> = {};
      if (opts.acceptLanguage !== undefined) headers["Accept-Language"] = opts.acceptLanguage;
      if (opts.xForwardedFor !== undefined) headers["X-Forwarded-For"] = opts.xForwardedFor;
      if (opts.userAgent !== undefined) headers["User-Agent"] = opts.userAgent;
      return client.json("POST", `/users/${user.id}/factors/${factorId}/verify`, { ...(body !== undefined ? { body } : {}), query, headers });
    }));

  // Deviation from the plan: resendEnrollFactor requires a body per the spec (requestBody, not
  // requestBody?) - -b/-s is mandatory here, matching every other factor-shaped request body.
  addOutputOptions(addVerbose(userLookupOpt(bodyOpts(usersCmd.command("factor-resend").description("Resend a factor enrollment challenge").argument("<user>").argument("<factorId>")
    .option("--template-id <id>", "custom SMS template id")))), FACTOR_FIELDS)
    .action(action(ctx, async (client, opts, userArg, factorId) => {
      const user = await resolveUser(client, opts, userArg);
      return client.json("POST", `/users/${user.id}/factors/${factorId}/resend`, { body: bodyFromOpts(opts), query: opts.templateId !== undefined ? { templateId: opts.templateId } : {} });
    }));

  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("factor-transaction").description("Retrieve a factor verification transaction's status").argument("<user>").argument("<factorId>").argument("<transactionId>"))), null)
    .action(action(ctx, async (client, opts, userArg, factorId, transactionId) => client.get(`/users/${(await resolveUser(client, opts, userArg)).id}/factors/${factorId}/transactions/${transactionId}`)));

  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("factor").description("Retrieve a user's factor").argument("<user>").argument("<factorId>"))), FACTOR_FIELDS)
    .action(action(ctx, async (client, opts, userArg, factorId) => client.get(`/users/${(await resolveUser(client, opts, userArg)).id}/factors/${factorId}`)));

  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("factors-questions").description("List security questions available for a user").argument("<user>"))), QUESTION_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => client.getAll(`/users/${(await resolveUser(client, opts, userArg)).id}/factors/questions`)));

  // Authenticator enrollments
  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("authenticator-enrollments").description("List a user's authenticator enrollments").argument("<user>"))), ENROLLMENT_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => client.getAll(`/users/${(await resolveUser(client, opts, userArg)).id}/authenticator-enrollments`)));

  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("authenticator-enrollment").description("Retrieve a user's authenticator enrollment").argument("<user>").argument("<id>"))), ENROLLMENT_FIELDS)
    .action(action(ctx, async (client, opts, userArg, id) => client.get(`/users/${(await resolveUser(client, opts, userArg)).id}/authenticator-enrollments/${id}`)));

  addVerbose(userLookupOpt(usersCmd.command("authenticator-enrollment-delete").description("Delete a user's authenticator enrollment").argument("<user>").argument("<id>")))
    .action(action(ctx, async (client, opts, userArg, id) => {
      const user = await resolveUser(client, opts, userArg);
      await client.json("DELETE", `/users/${user.id}/authenticator-enrollments/${id}`);
      return `authenticator enrollment ${id} deleted from user ${user.id} (${user.profile.login})`;
    }));

  addOutputOptions(addVerbose(userLookupOpt(bodyOpts(usersCmd.command("authenticator-enroll-phone").description("Create an auto-activated Phone authenticator enrollment").argument("<user>")))), ENROLLMENT_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => client.json("POST", `/users/${(await resolveUser(client, opts, userArg)).id}/authenticator-enrollments/phone`, { body: bodyFromOpts(opts) })));

  // Deviation from the plan: createTacAuthenticatorEnrollment requires a body per the spec
  // (requestBody, not requestBody?) - -b/-s is mandatory here.
  addOutputOptions(addVerbose(userLookupOpt(bodyOpts(usersCmd.command("authenticator-enroll-tac").description("Create an auto-activated Temporary access code authenticator enrollment").argument("<user>")))), ENROLLMENT_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => client.json("POST", `/users/${(await resolveUser(client, opts, userArg)).id}/authenticator-enrollments/tac`, { body: bodyFromOpts(opts) })));

  // Risk & classification
  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("risk").description("Retrieve a user's risk level").argument("<user>"))), RISK_GET_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => client.get(`/users/${(await resolveUser(client, opts, userArg)).id}/risk`)));

  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("risk-set").description("Set a user's risk level").argument("<user>")
    .addOption(new Option("--level <level>", "risk level").choices(RISK_LEVELS).makeOptionMandatory())
    .option("--reason <text>", "reason for the risk level change (defaults to 'override.by.admin')"))), RISK_SET_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => {
      const body: Record<string, unknown> = { riskLevel: opts.level };
      if (opts.reason !== undefined) body.riskReason = opts.reason;
      return client.json("PUT", `/users/${(await resolveUser(client, opts, userArg)).id}/risk`, { body });
    }));

  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("classification").description("Retrieve a user's classification").argument("<user>"))), CLASSIFICATION_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => client.get(`/users/${(await resolveUser(client, opts, userArg)).id}/classification`)));

  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("classification-set").description("Replace a user's classification").argument("<user>")
    .addOption(new Option("--type <type>", "classification type").choices(CLASSIFICATION_TYPES).makeOptionMandatory()))), CLASSIFICATION_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => client.json("PUT", `/users/${(await resolveUser(client, opts, userArg)).id}/classification`, { body: { type: opts.type } })));

  // OAuth 2.0 client tokens
  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("client-tokens").description("List a user's refresh tokens for an OAuth 2.0 client").argument("<user>")
    .requiredOption("--client <clientId>", "the client id"))), CLIENT_TOKEN_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => client.getAll(`/users/${(await resolveUser(client, opts, userArg)).id}/clients/${opts.client}/tokens`)));

  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("client-token").description("Retrieve a refresh token for an OAuth 2.0 client").argument("<user>").argument("<tokenId>")
    .requiredOption("--client <clientId>", "the client id"))), CLIENT_TOKEN_FIELDS)
    .action(action(ctx, async (client, opts, userArg, tokenId) => client.get(`/users/${(await resolveUser(client, opts, userArg)).id}/clients/${opts.client}/tokens/${tokenId}`)));

  addVerbose(userLookupOpt(usersCmd.command("client-tokens-revoke").description("Revoke one (or all) of a user's refresh tokens for an OAuth 2.0 client").argument("<user>").argument("[tokenId]")
    .requiredOption("--client <clientId>", "the client id")))
    .action(action(ctx, async (client, opts, userArg, tokenId?: string) => {
      const user = await resolveUser(client, opts, userArg);
      const path = tokenId ? `/users/${user.id}/clients/${opts.client}/tokens/${tokenId}` : `/users/${user.id}/clients/${opts.client}/tokens`;
      await client.json("DELETE", path);
      return tokenId
        ? `token ${tokenId} revoked for client ${opts.client} from user ${user.id} (${user.profile.login})`
        : `all tokens revoked for client ${opts.client} from user ${user.id} (${user.profile.login})`;
    }));

  // IdP tokens
  addOutputOptions(addVerbose(userLookupOpt(usersCmd.command("idp-tokens").description("List tokens minted by a social IdP for a user").argument("<user>")
    .requiredOption("--idp <idp>", "identity provider name or id"))), IDP_TOKEN_FIELDS)
    .action(action(ctx, async (client, opts, userArg) => {
      const user = await resolveUser(client, opts, userArg);
      const idp = await resourceGet(client, IDPS, opts.idp);
      return client.getAll(`/idps/${idp.id}/users/${user.id}/credentials/tokens`);
    }));

  // WebAuthn preregistration enrollment
  addVerbose(userLookupOpt(usersCmd.command("webauthn-enrollment-delete").description("Delete a user's WebAuthn preregistration factor").argument("<user>").argument("<enrollmentId>")))
    .action(action(ctx, async (client, opts, userArg, enrollmentId) => {
      const user = await resolveUser(client, opts, userArg);
      await client.json("DELETE", `/users/${user.id}/enrollments/${enrollmentId}`, { basePath: WEBAUTHN_REG_BASE });
      return `webauthn enrollment ${enrollmentId} deleted from user ${user.id} (${user.profile.login})`;
    }));
}
