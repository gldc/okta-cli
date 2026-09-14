import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, bodyFromOpts, bodyOpts } from "../cli/options";
import { deepMerge, isPlainObject } from "../lib/dotted";
import type { OktaClient } from "../okta/client";
import { ExitError } from "../okta/errors";
import { defineResource, omitFields, resourceGet, type ResourceSpec } from "./resource";

// Read-only fields the GET theme representation carries that UpdateThemeRequest doesn't accept.
const THEME_REPLACE_OMIT = ["id", "logo", "favicon", "backgroundImage", "_links"];

const DOMAIN_FIELDS = "id,domain,validationStatus,certificateSourceType";
const THEME_FIELDS = "id,primaryColorHex,secondaryColorHex,signInPageTouchPointVariant,endUserDashboardTouchPointVariant";
const EMAIL_TEMPLATE_FIELDS = "name";
const EMAIL_CUSTOMIZATION_FIELDS = "id,language,isDefault,subject";
const PAGE_VARIANTS = ["customized", "default", "preview"];

export const BRANDS: ResourceSpec = {
  name: "brands", description: "Brands and customization", path: "/brands", singular: "brand",
  nameField: "name", defaultFields: "id,name,isDefault,removePoweredByOkta",
  // Deviation from the plan: the spec's queryExpandBrand also allows "themes" (not just
  // "domains"/"emailDomain").
  listOptions: [{ flags: "--expand <what>", param: "expand", description: "themes, domains, or emailDomain", choices: ["themes", "domains", "emailDomain"] }],
};

const THEME_ASSETS = [
  { cmd: "theme-logo", field: "logo", label: "logo" },
  { cmd: "theme-favicon", field: "favicon", label: "favicon" },
  { cmd: "theme-background", field: "background-image", label: "background image" },
] as const;

export function registerBrands(program: Command, ctx: Ctx): Command {
  const g = defineResource(program, ctx, BRANDS);
  const resolveBrand = (client: OktaClient, arg: string) => resourceGet(client, BRANDS, arg);

  addOutputOptions(addVerbose(g.command("domains").description("List the domains associated with a brand").argument("<brand>")), DOMAIN_FIELDS)
    .action(action(ctx, async (client, _o, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.getAll(`/brands/${brand.id}/domains`, { listKey: "domains" });
    }));

  // Themes
  addOutputOptions(addVerbose(g.command("themes").description("List a brand's themes").argument("<brand>")), THEME_FIELDS)
    .action(action(ctx, async (client, _o, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.getAll(`/brands/${brand.id}/themes`);
    }));

  addOutputOptions(addVerbose(g.command("theme").description("Get a brand's theme").argument("<brand>").argument("<themeId>")), THEME_FIELDS)
    .action(action(ctx, async (client, _o, brandArg, themeId) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/themes/${themeId}`);
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("theme-update").description("Replace (PUT) a brand's theme; with only -s the current object is fetched and merged").argument("<brand>").argument("<themeId>"))), THEME_FIELDS)
    .action(action(ctx, async (client, opts, brandArg, themeId) => {
      const brand = await resolveBrand(client, brandArg);
      const path = `/brands/${brand.id}/themes/${themeId}`;
      const existing = await client.get(path);
      let body = bodyFromOpts(opts);
      if (!opts.body && isPlainObject(body)) body = deepMerge(omitFields(existing, THEME_REPLACE_OMIT), body);
      return client.json("PUT", path, { body });
    }));

  for (const { cmd, field, label } of THEME_ASSETS) {
    addOutputOptions(addVerbose(g.command(cmd).description(`Upload (--file) or delete (--delete) a theme's ${label}`).argument("<brand>").argument("<themeId>")
      .option("--file <path>", "path to the image file to upload")
      .option("--delete", "delete the asset instead of uploading")), null)
      .action(action(ctx, async (client, opts, brandArg, themeId) => {
        if (!!opts.file === !!opts.delete) throw new ExitError("Provide exactly one of --file or --delete");
        const brand = await resolveBrand(client, brandArg);
        const path = `/brands/${brand.id}/themes/${themeId}/${field}`;
        if (opts.delete) {
          await client.json("DELETE", path);
          return `${label} deleted from theme ${themeId} on brand ${brand.id}`;
        }
        return client.upload(path, "file", opts.file);
      }));
  }

  // Email templates
  addOutputOptions(addVerbose(g.command("email-templates").description("List a brand's email templates").argument("<brand>")), EMAIL_TEMPLATE_FIELDS)
    .action(action(ctx, async (client, _o, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.getAll(`/brands/${brand.id}/templates/email`);
    }));

  addOutputOptions(addVerbose(g.command("email-template").description("Get an email template").argument("<brand>").argument("<name>")), EMAIL_TEMPLATE_FIELDS)
    .action(action(ctx, async (client, _o, brandArg, name) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/templates/email/${name}`);
    }));

  addOutputOptions(addVerbose(g.command("email-customizations").description("List an email template's customizations").argument("<brand>").argument("<name>")), EMAIL_CUSTOMIZATION_FIELDS)
    .action(action(ctx, async (client, _o, brandArg, name) => {
      const brand = await resolveBrand(client, brandArg);
      return client.getAll(`/brands/${brand.id}/templates/email/${name}/customizations`);
    }));

  addOutputOptions(addVerbose(g.command("email-customization").description("Get an email customization").argument("<brand>").argument("<name>").argument("<id>")), EMAIL_CUSTOMIZATION_FIELDS)
    .action(action(ctx, async (client, _o, brandArg, name, id) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/templates/email/${name}/customizations/${id}`);
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("email-customization-add").description("Create an email customization").argument("<brand>").argument("<name>"))), EMAIL_CUSTOMIZATION_FIELDS)
    .action(action(ctx, async (client, opts, brandArg, name) => {
      const brand = await resolveBrand(client, brandArg);
      return client.json("POST", `/brands/${brand.id}/templates/email/${name}/customizations`, { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("email-customization-replace").description("Replace an email customization").argument("<brand>").argument("<name>").argument("<id>"))), EMAIL_CUSTOMIZATION_FIELDS)
    .action(action(ctx, async (client, opts, brandArg, name, id) => {
      const brand = await resolveBrand(client, brandArg);
      return client.json("PUT", `/brands/${brand.id}/templates/email/${name}/customizations/${id}`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(g.command("email-customization-delete").description("Delete one email customization, or all of them if [id] is omitted").argument("<brand>").argument("<name>").argument("[id]"))
    .action(action(ctx, async (client, _o, brandArg, name, id?: string) => {
      const brand = await resolveBrand(client, brandArg);
      const base = `/brands/${brand.id}/templates/email/${name}/customizations`;
      await client.json("DELETE", id ? `${base}/${id}` : base);
      return id
        ? `email customization ${id} deleted for template ${name} on brand ${brand.id}`
        : `all email customizations deleted for template ${name} on brand ${brand.id}`;
    }));

  addOutputOptions(addVerbose(g.command("email-customization-preview").description("Preview an email customization").argument("<brand>").argument("<name>").argument("<id>")), null)
    .action(action(ctx, async (client, _o, brandArg, name, id) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/templates/email/${name}/customizations/${id}/preview`);
    }));

  addOutputOptions(addVerbose(g.command("email-default-content").description("Get an email template's default content").argument("<brand>").argument("<name>").option("--language <l>", "language")), null)
    .action(action(ctx, async (client, opts, brandArg, name) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/templates/email/${name}/default-content`, { language: opts.language });
    }));

  addOutputOptions(addVerbose(g.command("email-default-preview").description("Preview an email template's default content").argument("<brand>").argument("<name>").option("--language <l>", "language")), null)
    .action(action(ctx, async (client, opts, brandArg, name) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/templates/email/${name}/default-content/preview`, { language: opts.language });
    }));

  addOutputOptions(addVerbose(g.command("email-settings").description("Get an email template's settings").argument("<brand>").argument("<name>")), null)
    .action(action(ctx, async (client, _o, brandArg, name) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/templates/email/${name}/settings`);
    }));

  addOutputOptions(addVerbose(g.command("email-settings-set").description("Replace an email template's settings").argument("<brand>").argument("<name>")
    .addOption(new Option("--recipients <recipients>", "who receives this email").choices(["ALL_USERS", "ADMINS_ONLY", "NO_USERS"]).makeOptionMandatory())), null)
    .action(action(ctx, async (client, opts, brandArg, name) => {
      const brand = await resolveBrand(client, brandArg);
      return client.json("PUT", `/brands/${brand.id}/templates/email/${name}/settings`, { body: { recipients: opts.recipients } });
    }));

  addVerbose(g.command("email-test").description("Send a test email").argument("<brand>").argument("<name>").option("--language <l>", "language"))
    .action(action(ctx, async (client, opts, brandArg, name) => {
      const brand = await resolveBrand(client, brandArg);
      await client.json("POST", `/brands/${brand.id}/templates/email/${name}/test`, { query: { language: opts.language } });
      return "test email sent";
    }));

  // Pages
  addOutputOptions(addVerbose(g.command("sign-in-page").description("Show the sign-in page (all variants, or one with --variant)").argument("<brand>")
    .addOption(new Option("--variant <variant>", "customized, default, or preview").choices(PAGE_VARIANTS))), null)
    .action(action(ctx, async (client, opts, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/pages/sign-in${opts.variant ? `/${opts.variant}` : ""}`);
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("sign-in-page-set").description("Replace the customized sign-in page").argument("<brand>"))), null)
    .action(action(ctx, async (client, opts, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.json("PUT", `/brands/${brand.id}/pages/sign-in/customized`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(g.command("sign-in-page-delete").description("Delete the customized sign-in page").argument("<brand>"))
    .action(action(ctx, async (client, _o, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      await client.json("DELETE", `/brands/${brand.id}/pages/sign-in/customized`);
      return `customized sign-in page deleted from brand ${brand.id}`;
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("sign-in-preview-set").description("Replace the preview sign-in page").argument("<brand>"))), null)
    .action(action(ctx, async (client, opts, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.json("PUT", `/brands/${brand.id}/pages/sign-in/preview`, { body: bodyFromOpts(opts) });
    }));

  addOutputOptions(addVerbose(g.command("widget-versions").description("List the Sign-In Widget versions supported by the org").argument("<brand>")), "version")
    .action(action(ctx, async (client, _o, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      const versions: string[] = await client.get(`/brands/${brand.id}/pages/sign-in/widget-versions`);
      return versions.map((version) => ({ version }));
    }));

  addOutputOptions(addVerbose(g.command("error-page").description("Show the error page (all variants, or one with --variant)").argument("<brand>")
    .addOption(new Option("--variant <variant>", "customized, default, or preview").choices(PAGE_VARIANTS))), null)
    .action(action(ctx, async (client, opts, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/pages/error${opts.variant ? `/${opts.variant}` : ""}`);
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("error-page-set").description("Replace the customized error page").argument("<brand>"))), null)
    .action(action(ctx, async (client, opts, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.json("PUT", `/brands/${brand.id}/pages/error/customized`, { body: bodyFromOpts(opts) });
    }));

  addVerbose(g.command("error-page-delete").description("Delete the customized error page").argument("<brand>"))
    .action(action(ctx, async (client, _o, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      await client.json("DELETE", `/brands/${brand.id}/pages/error/customized`);
      return `customized error page deleted from brand ${brand.id}`;
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("error-preview-set").description("Replace the preview error page").argument("<brand>"))), null)
    .action(action(ctx, async (client, opts, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.json("PUT", `/brands/${brand.id}/pages/error/preview`, { body: bodyFromOpts(opts) });
    }));

  // Deviation from the plan: the spec has no DELETE for the sign-out page (only GET/PUT on
  // .../pages/sign-out/customized), so there's no sign-out-page-delete.
  addOutputOptions(addVerbose(g.command("sign-out-page").description("Show the sign-out page settings").argument("<brand>")), null)
    .action(action(ctx, async (client, _o, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/pages/sign-out/customized`);
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("sign-out-page-set").description("Replace the sign-out page settings").argument("<brand>"))), null)
    .action(action(ctx, async (client, opts, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.json("PUT", `/brands/${brand.id}/pages/sign-out/customized`, { body: bodyFromOpts(opts) });
    }));

  // Well-known URIs. Deviation from the plan: getAllWellKnownURIs returns a WellKnownURIsRoot
  // whose `_embedded` is keyed by well-known-uri path (apple-app-site-association,
  // assetlinks.json, webauthn), not a flat list under a `wellKnownUris` key - printed as raw
  // JSON rather than a table. The spec also has no DELETE for a well-known URI, so there's no
  // well-known-uri-delete.
  addOutputOptions(addVerbose(g.command("well-known-uris").description("Show all well-known URIs for a brand").argument("<brand>")), null)
    .action(action(ctx, async (client, _o, brandArg) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/well-known-uris`);
    }));

  addOutputOptions(addVerbose(g.command("well-known-uri").description("Show one well-known URI for a brand").argument("<brand>").argument("<path>")), null)
    .action(action(ctx, async (client, _o, brandArg, path) => {
      const brand = await resolveBrand(client, brandArg);
      return client.get(`/brands/${brand.id}/well-known-uris/${path}`);
    }));

  addOutputOptions(addVerbose(bodyOpts(g.command("well-known-uri-set").description("Replace the customized content of a well-known URI").argument("<brand>").argument("<path>"))), null)
    .action(action(ctx, async (client, opts, brandArg, path) => {
      const brand = await resolveBrand(client, brandArg);
      return client.json("PUT", `/brands/${brand.id}/well-known-uris/${path}/customized`, { body: bodyFromOpts(opts) });
    }));

  return g;
}
