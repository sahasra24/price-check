// Price Check staff-help service (Cloudflare Worker + D1).
//
// Customer taps "Call a staff member" -> every staff member ON SHIFT gets an urgent ntfy alert with an
// Accept button. The first person to accept wins, gets points, and the alert is replaced on the
// other phones. The customer's page shows who is coming. Unanswered alerts re-ring every 30 s and
// expire after 3 minutes.
//
// Secrets / vars (set with wrangler, never committed):
//   STAFF_JSON   private staff list + weekly shifts + ntfy topics (see staff.example.json)
//   SIGNING_KEY  random string used to sign Accept links
//   BOARD_PIN    PIN for the points leaderboard page
//   TIMEZONE     store time zone, e.g. America/Toronto        (wrangler.toml [vars])
//   ALLOWED_ORIGINS  comma-separated site origins for CORS    (wrangler.toml [vars])
//   NTFY_SERVER  default https://ntfy.sh                       (wrangler.toml [vars])

const RING_EVERY_MS = 30 * 1000;
const EXPIRE_AFTER_MS = 3 * 60 * 1000;
const IP_COOLDOWN_MS = 60 * 1000;
const MAX_OPEN_REQUESTS = 5;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const p = url.pathname.replace(/\/+$/, "") || "/";
      let m;
      if (p === "/api/status" && req.method === "GET") return json(await status(env), cors);
      if (p === "/api/help" && req.method === "POST") { const [b, s] = await createHelp(req, env, ctx); return json(b, cors, s); }
      if ((m = p.match(/^\/api\/help\/([a-z0-9]{12})$/)) && req.method === "GET") return json(await helpState(m[1], env, ctx, url.origin), cors);
      if ((m = p.match(/^\/a\/([a-z0-9]{12})\/([a-z0-9-]{1,40})\/([a-f0-9]{32})$/))) return accept(req, env, ctx, m[1], m[2], m[3]);
      if (p === "/board") return board(req, env);
      if (p === "/") return new Response("Price Check staff-help service is running.", { headers: { "content-type": "text/plain" } });
      return json({ error: "not found" }, cors, 404);
    } catch (e) {
      console.error(e && e.stack || e);
      return json({ error: "server error" }, cors, 500);
    }
  },

  // Backup timer (every minute): re-ring / expire requests even if the customer closed the page.
  async scheduled(event, env, ctx) {
    const open = await env.DB.prepare("SELECT * FROM requests WHERE status = 'open'").all();
    for (const r of open.results || []) await tick(r, env);
  },
};

// ---------- helpers ----------
function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
              "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (allowed.includes(origin) || allowed.includes("*")) h["Access-Control-Allow-Origin"] = origin || "*";
  return h;
}
function json(body, headers = {}, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" } });
}
function html(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function clean(s, n) { return String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n); }
function rid() {
  const a = "abcdefghijkmnpqrstuvwxyz23456789", b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => a[x % a.length]).join("");
}
function slug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "staff"; }

async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SIGNING_KEY || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return Array.from(sig.slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
}
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- staff + shifts ----------
function staffList(env) {
  let data;
  try { data = JSON.parse(env.STAFF_JSON || "{}"); } catch { data = {}; }
  return (data.staff || []).filter((s) => s && s.name && s.topic && s.active !== false)
    .map((s) => ({ ...s, key: slug(s.name) }));
}
function storeNow(env, date = new Date()) {
  const opts = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" };
  let parts;
  try { parts = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: env.TIMEZONE || "UTC" }).formatToParts(date); }
  catch { parts = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).formatToParts(date); }
  const o = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const h = Number(o.hour) % 24;
  return { y: +o.year, mo: +o.month, d: +o.day, dow: o.weekday.slice(0, 3), mins: h * 60 + Number(o.minute), h, mi: +o.minute };
}
function normDays(v) {
  if (v == null || v === "") return [];
  const out = [];
  for (const raw of Array.isArray(v) ? v : String(v).split(/[,;/ ]+/)) {
    const s = String(raw).trim().toLowerCase();
    if (!s) continue;
    if (s.startsWith("weekend")) { out.push("Sat", "Sun"); continue; }
    if (s.startsWith("weekday")) { out.push(...DAYS.slice(0, 5)); continue; }
    if (["daily", "everyday", "all"].includes(s)) { out.push(...DAYS); continue; }
    const cap = (x) => x.slice(0, 3).replace(/^./, (c) => c.toUpperCase());
    const r = s.split("-");
    if (r.length === 2 && DAYS.includes(cap(r[0])) && DAYS.includes(cap(r[1]))) {
      for (let i = DAYS.indexOf(cap(r[0])); ; i = (i + 1) % 7) { out.push(DAYS[i]); if (DAYS[i] === cap(r[1])) break; }
      continue;
    }
    if (DAYS.includes(cap(s))) out.push(cap(s));
  }
  return [...new Set(out)];
}
function toMins(t) {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(String(t ?? "").trim());
  if (!m) return null;
  const v = +m[1] * 60 + +m[2];
  return v <= 1440 ? v : null;
}
function inWindow(days, start, end, now) {
  const s = toMins(start), e = toMins(end);
  if (s == null || e == null || s === e) return false;
  const has = (d) => !days.length || days.includes(d);
  if (e > s) return has(now.dow) && now.mins >= s && now.mins < e;
  const prev = DAYS[(DAYS.indexOf(now.dow) + 6) % 7];
  return (has(now.dow) && now.mins >= s) || (has(prev) && now.mins < e);
}
function onShift(env) {
  const now = storeNow(env);
  return staffList(env).filter((s) => (s.shifts || []).some((sh) => inWindow(normDays(sh.days), sh.start, sh.end, now)));
}

// ---------- ntfy ----------
async function ntfy(env, topic, seq, { title, message, priority = 3, tags, actions, click }) {
  const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const q = new URLSearchParams({ title, priority: String(priority) });
  if (tags) q.set("tags", tags);
  if (actions) q.set("actions", actions);
  if (click) q.set("click", click);
  try {
    const r = await fetch(`${server}/${encodeURIComponent(topic)}/${encodeURIComponent(seq)}?${q}`, { method: "POST", body: message });
    return r.ok;
  } catch (e) { console.error("ntfy failed", e); return false; }
}

async function ringAll(r, env, origin) {
  const people = JSON.parse(r.staff_json);
  const where = r.where_txt ? `at ${r.where_txt}` : "in the store";
  const lines = [`A customer needs help ${where}.`];
  if (r.item) lines.push(`Item: ${r.item}`);
  if (r.rings > 0) lines.push(`Reminder ${r.rings}: nobody has accepted yet.`);
  lines.push("Tap Accept if you're going.");
  const results = await Promise.all(people.map(async (p) => {
    const link = `${origin}/a/${r.id}/${p.key}/${await sign(env, r.id + ":" + p.key)}`;
    return ntfy(env, p.topic, "req-" + r.id, {
      title: `Customer needs help ${r.where_txt ? "- " + r.where_txt : ""}`.trim(),
      message: lines.join("\n"), priority: 5, tags: "rotating_light",
      actions: `http, Accept, ${link}, method=POST, clear=true`, click: link,
    });
  }));
  return results.some(Boolean);
}

async function notifyOthers(r, env, winnerKey, text) {
  const people = JSON.parse(r.staff_json);
  await Promise.all(people.filter((p) => p.key !== winnerKey).map((p) =>
    ntfy(env, p.topic, "req-" + r.id, { title: text, message: text, priority: 2, tags: "white_check_mark" })));
}

// ---------- requests ----------
async function status(env) {
  const n = onShift(env).length;
  return { available: n > 0, on_shift: n };
}

async function createHelp(req, env, ctx) {
  const people = onShift(env);
  if (!people.length) return [{ error: "no_staff", message: "No staff member is on shift right now." }, 409];

  const ip = req.headers.get("CF-Connecting-IP") || "local";
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT id, status FROM requests WHERE ip = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(ip, now - IP_COOLDOWN_MS).first();
  if (recent) return [{ id: recent.id, status: recent.status, note: "already_sent" }, 200];
  const openCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'open'").first();
  if ((openCount?.n || 0) >= MAX_OPEN_REQUESTS) return [{ error: "busy", message: "Staff are busy with other customers. Please go to the counter." }, 429];

  let body = {};
  try { body = await req.json(); } catch {}
  const r = {
    id: rid(), created_at: now, where_txt: clean(body.where, 60), item: clean(body.item, 120), status: "open",
    staff_json: JSON.stringify(people.map((p) => ({ key: p.key, name: p.name, topic: p.topic }))),
    last_ring: now, rings: 0, ip,
  };
  await env.DB.prepare(`INSERT INTO requests (id, created_at, where_txt, item, status, staff_json, last_ring, rings, ip)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(r.id, r.created_at, r.where_txt, r.item, r.status, r.staff_json, r.last_ring, r.rings, r.ip).run();
  const ok = await ringAll(r, env, new URL(req.url).origin);
  if (!ok) {
    await env.DB.prepare("UPDATE requests SET status = 'failed' WHERE id = ?").bind(r.id).run();
    return [{ error: "send_failed", message: "Couldn't reach staff." }, 502];
  }
  return [{ id: r.id, status: "open", alerted: people.length }, 200];
}

// Re-ring every 30 s while open; expire after 3 min. Atomic guards stop double-ringing.
async function tick(r, env, origin) {
  const now = Date.now();
  if (r.status !== "open") return r;
  if (now - r.created_at >= EXPIRE_AFTER_MS) {
    const res = await env.DB.prepare("UPDATE requests SET status = 'expired' WHERE id = ? AND status = 'open'").bind(r.id).run();
    if (res.meta.changes) {
      const text = `Missed: customer ${r.where_txt ? "at " + r.where_txt : "in store"} - nobody accepted`;
      await notifyOthers(r, env, null, text);
    }
    return { ...r, status: "expired" };
  }
  if (now - r.last_ring >= RING_EVERY_MS) {
    const res = await env.DB.prepare("UPDATE requests SET last_ring = ?, rings = rings + 1 WHERE id = ? AND status = 'open' AND last_ring = ?")
      .bind(now, r.id, r.last_ring).run();
    if (res.meta.changes) await ringAll({ ...r, rings: r.rings + 1 }, env, origin || env.PUBLIC_URL || "");
  }
  return r;
}

async function helpState(id, env, ctx, origin) {
  let r = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
  if (!r) return { status: "unknown" };
  if (r.status === "open") {
    ctx.waitUntil(tick(r, env, origin));
    if (Date.now() - r.created_at >= EXPIRE_AFTER_MS) r = { ...r, status: "expired" };
  }
  const out = { status: r.status };
  if (r.status === "accepted") out.by = r.accepted_name;
  return out;
}

function pointsFor(ms) { return ms <= 30000 ? 3 : ms <= 60000 ? 2 : 1; }

async function accept(req, env, ctx, id, key, token) {
  const valid = sameString(token, await sign(env, id + ":" + key));
  if (!valid) return acceptPage("This link isn't valid.", "err", 403);
  const r = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
  if (!r) return acceptPage("This request no longer exists.", "err", 404);
  const person = JSON.parse(r.staff_json).find((p) => p.key === key);
  if (!person) return acceptPage("You weren't on this alert.", "err", 403);
  const where = r.where_txt ? r.where_txt : "the store";

  // GET (tapping the notification body / iPhone) shows a confirm button; POST accepts.
  if (req.method === "GET") {
    if (r.status === "accepted") return acceptPage(r.accepted_by === key ? `You accepted this. Customer at ${where}.` : `Already taken by ${r.accepted_name}.`, r.accepted_by === key ? "ok" : "info");
    if (r.status !== "open") return acceptPage("This request has expired.", "info");
    return acceptPage(`Customer needs help at ${where}.` + (r.item ? ` Item: ${r.item}.` : ""), "ask", 200, req.url);
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const now = Date.now();
  const pts = pointsFor(now - r.created_at);
  const res = await env.DB.prepare(`UPDATE requests SET status = 'accepted', accepted_by = ?, accepted_name = ?, accepted_at = ?, points = ?
                                    WHERE id = ? AND status = 'open'`).bind(key, person.name, now, pts, id).run();
  const wantsHtml = (req.headers.get("accept") || "").includes("text/html"); // browser form (iPhone page) vs ntfy button
  if (res.meta.changes === 1) {
    ctx.waitUntil(Promise.all([
      notifyOthers(r, env, key, `${person.name} is helping the customer at ${where}`),
      ntfy(env, person.topic, "req-" + id, { title: `You accepted (+${pts} pts)`, message: `Go to: ${where}` + (r.item ? `\nItem: ${r.item}` : ""), priority: 3, tags: "white_check_mark" }),
    ]));
    return wantsHtml ? acceptPage(`Accepted! Go to ${where}. You earned +${pts} point${pts > 1 ? "s" : ""}.`, "ok")
                     : json({ ok: true, points: pts });
  }
  const cur = await env.DB.prepare("SELECT status, accepted_name, accepted_by FROM requests WHERE id = ?").bind(id).first();
  const msg = cur.status === "accepted"
    ? (cur.accepted_by === key ? "You already accepted this one." : `Already taken by ${cur.accepted_name}.`)
    : "This request has expired.";
  if (cur.accepted_by !== key) ctx.waitUntil(ntfy(env, person.topic, "req-" + id, { title: msg, message: msg, priority: 2, tags: "information_source" }));
  return wantsHtml ? acceptPage(msg, "info", 409) : json({ ok: false, message: msg }, {}, 409);
}

const PAGE_CSS = `:root{--bg:#f6f7f9;--card:#fff;--text:#15181d;--muted:#5d6470;--line:#dfe3e8;--accent:#1f6feb;--ok:#0a7a3d;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1c2026;--text:#f1f3f5;--muted:#a3abb6;--line:#313741;--accent:#4c8dff;--ok:#4ade80;--err:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:18px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px}
h1{font-size:24px;margin:0 0 10px}.ok{color:var(--ok)}.err{color:var(--err)}.muted{color:var(--muted)}
button,.btn{display:block;width:100%;min-height:56px;margin-top:16px;border:0;border-radius:14px;background:var(--accent);color:#fff;font:inherit;font-weight:700;cursor:pointer}
input{width:100%;min-height:50px;padding:10px 14px;font:inherit;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--text)}
table{width:100%;border-collapse:collapse;margin-top:6px}td,th{padding:8px 4px;border-bottom:1px solid var(--line);text-align:left}td.n,th.n{text-align:right}td:first-child{white-space:nowrap}
h2{font-size:18px;margin:22px 0 4px}`;

function acceptPage(message, kind, status = 200, postUrl) {
  const title = { ok: "✅ Accepted", err: "Link problem", info: "Heads up", ask: "🙋 Customer needs help" }[kind] || "Staff help";
  const form = kind === "ask" ? `<form method="POST" action="${esc(new URL(postUrl).pathname)}"><button type="submit">✅ Accept — I'm going</button></form>` : "";
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head>
<body><main><div class="card"><h1 class="${kind === "ok" ? "ok" : kind === "err" ? "err" : ""}">${esc(title)}</h1><p>${esc(message)}</p>${form}</div></main></body></html>`, status);
}

// ---------- leaderboard ----------
function periodStart(env, kind) {
  // Midnight (store time) at the start of this week (Mon) or this month, as a UTC timestamp.
  const now = new Date();
  const t = storeNow(env, now);
  const wallNow = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi);
  const offset = wallNow - Math.floor(now.getTime() / 60000) * 60000; // store wall clock minus UTC
  let startWall;
  if (kind === "week") startWall = Date.UTC(t.y, t.mo - 1, t.d - DAYS.indexOf(t.dow));
  else startWall = Date.UTC(t.y, t.mo - 1, 1);
  return startWall - offset;
}

async function board(req, env) {
  const url = new URL(req.url);
  const pin = url.searchParams.get("pin") || "";
  if (!env.BOARD_PIN || !sameString(pin, String(env.BOARD_PIN))) {
    const bad = pin ? `<p class="err">Wrong PIN.</p>` : "";
    return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Staff points</title><style>${PAGE_CSS}</style></head><body><main><div class="card">
<h1>Staff points</h1>${bad}<form method="GET"><label for="pin" class="muted">Enter PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="off" autofocus>
<button type="submit">Show points</button></form></div></main></body></html>`, pin ? 403 : 200);
  }
  const q = async (since) => (await env.DB.prepare(`SELECT accepted_name AS name, SUM(points) AS pts, COUNT(*) AS n,
      CAST(AVG(accepted_at - created_at) / 1000 AS INTEGER) AS avg_s
      FROM requests WHERE status = 'accepted' AND accepted_at >= ? GROUP BY accepted_by ORDER BY pts DESC, n DESC`).bind(since).all()).results || [];
  const [week, month, all] = await Promise.all([q(periodStart(env, "week")), q(periodStart(env, "month")), q(0)]);
  const recent = (await env.DB.prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT 15").all()).results || [];
  const table = (rows) => rows.length ? `<table><tr><th>Name</th><th class="n">Points</th><th class="n">Helped</th><th class="n">Avg response</th></tr>${
    rows.map((r, i) => `<tr><td>${i === 0 ? "🏆 " : ""}${esc(r.name)}</td><td class="n"><b>${r.pts}</b></td><td class="n">${r.n}</td><td class="n">${r.avg_s}s</td></tr>`).join("")}</table>`
    : `<p class="muted">No points yet.</p>`;
  const fmt = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: env.TIMEZONE || "UTC", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  const recentRows = recent.map((r) => `<tr><td>${esc(fmt(r.created_at))}</td><td>${esc(r.where_txt || "—")}</td><td>${
    r.status === "accepted" ? `✅ ${esc(r.accepted_name)} (+${r.points}, ${Math.round((r.accepted_at - r.created_at) / 1000)}s)` : r.status === "open" ? "⏳ waiting" : r.status === "expired" ? "❌ missed" : esc(r.status)}</td></tr>`).join("");
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>Staff points</title><style>${PAGE_CSS}</style></head><body><main><div class="card">
<h1>🏆 Staff points</h1><p class="muted">3 pts if accepted within 30s · 2 pts within 1 min · 1 pt after that</p>
<h2>This week</h2>${table(week)}<h2>This month</h2>${table(month)}<h2>All time</h2>${table(all)}
<h2>Recent requests</h2>${recent.length ? `<table>${recentRows}</table>` : `<p class="muted">None yet.</p>`}
</div></main></body></html>`);
}
