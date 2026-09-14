// Header names whose values must never reach the verbose (-vvv) request/response log - shared
// between OktaClient's resource requests (client.ts) and OAuthTokenSource's token requests
// (oauth.ts).
export const SENSITIVE_HEADERS = new Set(["authorization", "dpop"]);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  return out;
}
