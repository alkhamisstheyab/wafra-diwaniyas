// Runs for every Function response (API, share pages, image proxy): adds the security headers
// that _headers gives static files, and turns unexpected errors into a short reference.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "SAMEORIGIN",
  "content-security-policy": "default-src 'none'; img-src 'self' https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

function errorRef() {
  const a = new Uint8Array(3);
  crypto.getRandomValues(a);
  return "E-" + Array.from(a, b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function onRequest(context) {
  let res;
  try {
    res = await context.next();
  } catch (err) {
    const ref = errorRef();
    console.error(ref, context.request.method, new URL(context.request.url).pathname, err && err.stack || err);
    res = new Response(JSON.stringify({ ok: false, error: "server", ref }), { status: 500, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  // Static files (the app itself) keep the headers from _headers; only Function routes get these.
  if (!/^\/(api|img|e|d|a)(\/|$)/.test(new URL(context.request.url).pathname)) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}
