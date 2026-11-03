// Same-origin proxy for public Google Drive images, so the page can share them as files
export async function onRequestGet({ request }) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[\w-]{20,}$/.test(id)) return new Response("bad id", { status: 400 });
  const r = await fetch(`https://drive.google.com/thumbnail?id=${id}&sz=w1600`, { redirect: "follow" });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.startsWith("image/")) return new Response("not found", { status: 404 });
  return new Response(r.body, { headers: { "content-type": type, "cache-control": "public, max-age=86400" } });
}
