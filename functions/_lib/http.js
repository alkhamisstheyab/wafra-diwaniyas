// Small helpers shared by the API functions.
export const SESSION_COOKIE = "__Host-wafra_s";

export function json(obj, status = 200, extraHeaders) {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) h.set(k, v);
  return new Response(JSON.stringify(obj), { status, headers: h });
}

export function readCookie(request, name) {
  const all = request.headers.get("cookie") || "";
  for (const part of all.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return "";
}

export function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// CSRF: state-changing requests must come from this origin and carry the custom header.
// A cross-site page cannot add the header without a CORS preflight, which this API never approves.
export function sameOriginWrite(request) {
  if (request.method !== "POST") return false;
  if (request.headers.get("x-wafra") !== "1") return false;
  const origin = request.headers.get("origin");
  const self = new URL(request.url).origin;
  if (origin && origin !== self) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  return true;
}

export function clientIp(request) {
  // Set by Cloudflare itself; a browser cannot forge it on requests that pass through Cloudflare.
  return request.headers.get("cf-connecting-ip") || "unknown";
}

export async function readJson(request, limitBytes) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len && len > limitBytes) return { tooLarge: true };
  const text = await request.text();
  if (text.length > limitBytes) return { tooLarge: true };
  try { return { body: JSON.parse(text || "{}") }; } catch (e) { return { bad: true }; }
}
