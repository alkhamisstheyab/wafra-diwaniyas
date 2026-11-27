// Server-to-server calls from Cloudflare Pages Functions to the Apps Script web app.
// The gateway secret lives only in Cloudflare (env.GATEWAY_SECRET) and Apps Script properties.
export class ConfigError extends Error {}

export async function gas(env, body, timeoutMs = 25000) {
  if (!env || !env.GAS_URL || !env.GATEWAY_SECRET) throw new ConfigError("GAS_URL or GATEWAY_SECRET is not set");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(env.GAS_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({}, body, { gw: env.GATEWAY_SECRET })),
      redirect: "follow",
      signal: ctl.signal
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { throw new Error("upstream returned non-JSON (HTTP " + r.status + ")"); }
  } finally {
    clearTimeout(timer);
  }
}

// Public data with best-effort caching: the edge cache (works on custom domains) and,
// when a KV namespace is bound as PUBLIC_KV, a durable "last good" copy for outages.
const FRESH_SECONDS = 60;
export async function getPublic(env, ctx, { fresh = true } = {}) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = "https://cache.wafra.internal/public-v1";
  if (fresh && cache) {
    const hit = await cache.match(key);
    if (hit) return await hit.json();
  }
  try {
    const data = await gas(env, { op: "public" }, 12000);
    if (!data || !data.ok) throw new Error("public read failed: " + (data && data.error));
    const body = JSON.stringify(data);
    const store = async () => {
      if (cache) await cache.put(key, new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + FRESH_SECONDS } }));
      if (env.PUBLIC_KV) {
        const last = await env.PUBLIC_KV.get("public-at");
        if (!last || Date.now() - Number(last) > 5 * 60e3) {
          await env.PUBLIC_KV.put("public-last-good", body);
          await env.PUBLIC_KV.put("public-at", String(Date.now()));
        }
      }
    };
    if (ctx && ctx.waitUntil) ctx.waitUntil(store()); else await store();
    return data;
  } catch (err) {
    if (env.PUBLIC_KV) {
      const last = await env.PUBLIC_KV.get("public-last-good");
      if (last) { const d = JSON.parse(last); d.stale = true; return d; }
    }
    throw err;
  }
}
