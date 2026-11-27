// Gateway between the browser and Apps Script.
//   POST /api/login    {pin}            -> sets an HttpOnly session cookie
//   POST /api/logout                    -> ends the session
//   GET  /api/session                   -> {ok, admin} when the cookie is valid
//   POST /api/admin    {action, ...}    -> any admin action, authorised by the cookie on the server
//   GET  /api/public[?hit=1&nv=1]       -> public, filtered data (counts a visit when hit=1)
import { gas, getPublic, ConfigError } from "../_lib/gas.js";
import { json, readCookie, sessionCookie, clearCookie, sameOriginWrite, clientIp, readJson, SESSION_COOKIE } from "../_lib/http.js";

const ADMIN_ACTIONS = new Set(["check", "data", "append", "update", "delete", "restore", "apology", "upload", "extract", "stats", "trash", "log", "sessions", "logoutAll", "changePin"]);
const MAX_BODY = 36 * 1024 * 1024; // a 25 MB video becomes ~34 MB in base64

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = (params.route || []).join("/");
  try {
    if (route === "public" && request.method === "GET") return await publicRoute(context);
    if (route === "session" && request.method === "GET") return await sessionRoute(request, env);
    if (["login", "logout", "admin"].includes(route)) {
      if (!sameOriginWrite(request)) return json({ ok: false, error: "forbidden" }, 403);
      if (route === "login") return await loginRoute(request, env);
      if (route === "logout") return await logoutRoute(request, env);
      return await adminRoute(request, env);
    }
    return json({ ok: false, error: "notfound" }, 404);
  } catch (err) {
    if (err instanceof ConfigError) throw err; // handled by _middleware with an error reference
    if (err && err.name === "AbortError") return json({ ok: false, error: "timeout" }, 504);
    throw err;
  }
}

async function publicRoute({ request, env, waitUntil }) {
  const url = new URL(request.url);
  if (url.searchParams.get("hit") === "1") {
    const p = gas(env, { op: "hit", nv: url.searchParams.get("nv") === "1" }, 10000).catch(() => {});
    if (waitUntil) waitUntil(p);
  }
  try {
    const data = await getPublic(env, { waitUntil });
    return json(data, 200, { "cache-control": "no-store" });
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    return json({ ok: false, error: "unavailable" }, 503);
  }
}

async function sessionRoute(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return json({ ok: false, error: "auth" });
  const r = await gas(env, { op: "session", token });
  if (!r.ok) return json({ ok: false, error: "auth" }, 200, { "set-cookie": clearCookie() });
  return json({ ok: true, admin: r.admin });
}

async function loginRoute(request, env) {
  const { body, bad, tooLarge } = await readJson(request, 4096);
  if (bad || tooLarge || typeof body.pin !== "string" || body.pin.length > 128) return json({ ok: false, error: "bad" }, 400);
  const r = await gas(env, { op: "login", ip: clientIp(request), pin: body.pin });
  if (r.ok && /^[0-9a-f]{64}$/.test(r.token || "")) {
    return json({ ok: true, admin: r.admin }, 200, { "set-cookie": sessionCookie(r.token, r.maxAge || 604800) });
  }
  if (r.error === "wait") return json({ ok: false, error: "wait", retryAfter: r.retryAfter }, 429, { "retry-after": String(r.retryAfter || 60) });
  return json({ ok: false, error: r.error === "pin" ? "pin" : "server", ref: r.ref }, r.error === "pin" ? 401 : 502);
}

async function logoutRoute(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await gas(env, { op: "logout", token }).catch(() => {});
  return json({ ok: true }, 200, { "set-cookie": clearCookie() });
}

async function adminRoute(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return json({ ok: false, error: "auth" }, 401);
  const { body, bad, tooLarge } = await readJson(request, MAX_BODY);
  if (tooLarge) return json({ ok: false, error: "filesize" }, 413);
  if (bad || !body || !ADMIN_ACTIONS.has(body.action)) return json({ ok: false, error: "bad" }, 400);
  const timeout = body.action === "extract" || body.action === "upload" ? 120000 : 30000;
  const r = await gas(env, { op: "admin", token, ip: clientIp(request), req: body }, timeout);
  if (r.error === "auth") return json(r, 401, { "set-cookie": clearCookie() });
  return json(r);
}
