import govSpecPaths from "./gov-spec-paths.json";
import specPaths from "./spec-paths.json";

const templates = [...(specPaths as string[]), ...(govSpecPaths as string[])].map((p) => new RegExp("^" + p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+") + "$"));

// Paths outside /api/v1 (attack-protection, integrations, security, privileged-access,
// okta-personal-settings, webauthn-registration, governance) are already full paths in
// spec-paths.json/gov-spec-paths.json and must not be prefixed with /api/v1.
const FULL_PATH_PREFIXES = [
  "/api/", "/oauth2/", "/.well-known/",
  "/attack-protection/", "/integrations/", "/security/", "/privileged-access/", "/okta-personal-settings/", "/webauthn-registration/", "/governance/",
];

export function knownPath(path: string): boolean {
  const full = FULL_PATH_PREFIXES.some((p) => path.startsWith(p)) ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  return templates.some((re) => re.test(full));
}
