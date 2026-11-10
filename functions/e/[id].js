// Share page for one occasion: gives WhatsApp a preview (title + invitation photo), then opens the app on that card
const EVENTS_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRWuKKehvUtt7zHVDSKvTqg3i39ohH98Eeis27ei0RWKYKmkA5ek7EVhnugMUo7qX7AaGrM8n0xqjnG/pub?gid=300473328&single=true&output=csv";

function evKey(start, person) {
  const t = String(start || "") + "|" + String(person || "").trim();
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}
function csv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.map(r => r.map(x => x.trim()));
}
const pad = n => String(n).padStart(2, "0");
const toLatin = s => String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
function normDate(s) {
  s = toLatin(s).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if (m) return m[1] + "-" + pad(m[2]) + "-" + pad(m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/); if (m) return m[3] + "-" + pad(m[2]) + "-" + pad(m[1]);
  return "";
}
const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function onRequestGet({ params, request }) {
  const id = String(params.id || "");
  const origin = new URL(request.url).origin;
  const target = origin + "/#ev-" + id;
  let title = "دواوين الوفرة", desc = "دليل دواوين مدينة الوفرة السكنية والأفراح والتعازي", image = origin + "/icon-512.png";
  try {
    const r = await fetch(EVENTS_CSV, { cf: { cacheTtl: 60 } });
    const rows = csv(await r.text()).slice(1);
    for (const x of rows) {
      const start = normDate(x[3]);
      if (!x[1] || !start || evKey(start, x[1]) !== id) continue;
      const k0 = String(x[0] || "").trim(), isC = /عزا/.test(k0), isD = !isC && /^دعوة|عشا|عزيم|غدا|ريوق|قهو/.test(k0);
      const itype = isD ? (k0.replace(/^دعوة\s*/, "").trim() || "عشاء") : "";
      title = isC ? "عزاء المرحوم/ة " + x[1] : (isD ? "دعوة " + itype + ": " : "زواج ") + x[1] + (x[2] && !x[1].includes(x[2]) ? " " + x[2] : "") + (isD && x[14] ? " بمناسبة " + x[14] : "");
      desc = [x[5], x[6], x[7]].filter(Boolean).join(" · ") || desc;
      const m = String(x[13] || "").match(/(?:\/file\/d\/|[?&]id=)([\w-]{20,})/);
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
