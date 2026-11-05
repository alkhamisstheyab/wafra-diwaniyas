// Share page for one announcement: WhatsApp preview (title + photo), then opens the app on that card
const API = "https://script.google.com/macros/s/AKfycbxyYlMtkaeH9nIYVBmY85q22ttehdciW_oj1TiE7sAyaEHab9jO3OKm0SL8KxNlP3U/exec";

function evKey(start, person) {
  const t = String(start || "") + "|" + String(person || "").trim();
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}
const pad = n => String(n).padStart(2, "0");
const toLatin = s => String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
function normDate(s) {
  s = toLatin(s).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if (m) return m[1] + "-" + pad(m[2]) + "-" + pad(m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) { const a = +m[1], b = +m[2]; const [dd, mm] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b]; return m[3] + "-" + pad(mm) + "-" + pad(dd); }
  return "";
}
const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function onRequestGet({ params, request }) {
  const id = String(params.id || "");
  const origin = new URL(request.url).origin;
  const target = origin + "/#ad-" + id;
  let title = "إعلانات الوفرة", desc = "مهرجانات وفعاليات وعروض تهم أهالي مدينة الوفرة السكنية", image = origin + "/icon-512.png";
  try {
    const r = await fetch(API, { redirect: "follow" });
    const j = await r.json();
    for (const x of (j.ads || [])) {
      const v = x.v || [];
      const start = normDate(v[2]);
      if (!v[0] || !start || evKey("ad" + start, v[0]) !== id) continue;
      title = "📢 " + v[0];
      desc = [v[1], v[5], v[4]].filter(Boolean).join(" · ") || desc;
      const m = String(v[10] || "").match(/(?:\/file\/d\/|[?&]id=)([\w-]{20,})/);
      if (m) image = origin + "/img?id=" + m[1];
      break;
    }
  } catch (e) {}
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="دواوين الوفرة">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
</head><body style="font-family:system-ui;text-align:center;padding:40px">
<p><a href="${esc(target)}">فتح تطبيق دواوين الوفرة</a></p>
<script>location.replace(${JSON.stringify(target)})</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
