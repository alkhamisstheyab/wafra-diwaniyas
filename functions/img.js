// Same-origin proxy for Drive images, used when sharing a card with its photo.
// Only images attached to published records are served; anything else is refused.
import { getPublic } from "./_lib/gas.js";

const MAX_BYTES = 8 * 1024 * 1024;

function publishedIds(data) {
  const ids = new Set();
  for (const k of Object.keys(data || {})) {
    if (!Array.isArray(data[k])) continue;
    for (const r of data[k]) for (const v of (r.v || [])) {
      const m = String(v).match(/(?:\/file\/d\/|[?&]id=)([\w-]{20,})/);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

export async function onRequestGet({ request, env, waitUntil }) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[\w-]{20,80}$/.test(id)) return new Response("bad id", { status: 400 });
  let allowed;
  try { allowed = publishedIds(await getPublic(env, { waitUntil })); } catch (e) { return new Response("unavailable", { status: 503 }); }
  if (!allowed.has(id)) return new Response("not found", { status: 404 });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://drive.google.com/thumbnail?id=${id}&sz=w1600`, { redirect: "follow", signal: ctl.signal });
    const type = (r.headers.get("content-type") || "").split(";")[0].trim();
    const len = Number(r.headers.get("content-length") || 0);
    if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type) || len > MAX_BYTES) return new Response("not found", { status: 404 });
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return new Response("too large", { status: 413 });
    return new Response(buf, { headers: { "content-type": type, "cache-control": "public, max-age=86400", "content-disposition": "inline" } });
  } catch (e) {
    return new Response("unavailable", { status: 504 });
  } finally {
    clearTimeout(timer);
  }
}
