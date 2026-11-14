// Price Check staff-help service (Cloudflare Worker + D1 + Telegram bot).
//
// Customer taps "Call a staff member" -> every staff member ON SHIFT gets a Telegram message from the
// store bot with an "Accept" button. The first person to accept wins and gets points; everyone else's
// message changes to "<name> is helping". The customer's page shows who is coming. Unanswered alerts
// are re-sent (with sound) every 30 s and expire after 3 minutes.
//
// Secrets (wrangler secret put):  TELEGRAM_TOKEN, SIGNING_KEY, BOARD_PIN, ADMIN_PIN
// Vars (wrangler.toml):           TIMEZONE, ALLOWED_ORIGINS, PUBLIC_URL, TG_API (optional, for tests)
// Staff list + shifts + Telegram links live in the D1 "settings" table and are edited at /admin.

const RING_EVERY_MS = 30 * 1000;
const EXPIRE_AFTER_MS = 3 * 60 * 1000;
const IP_COOLDOWN_MS = 60 * 1000;
const MAX_OPEN_REQUESTS = 5;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LABEL = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const p = url.pathname.replace(/\/+$/, "") || "/";
      let m;
      if (p === "/api/status" && req.method === "GET") return json(await status(env), cors);
      if (p === "/api/help" && req.method === "POST") { const [b, s] = await createHelp(req, env); return json(b, cors, s); }
      if ((m = p.match(/^\/api\/help\/([a-z0-9]{12})$/)) && req.method === "GET") return json(await helpState(m[1], env, ctx), cors);
      if (p === "/tg/hook" && req.method === "POST") return telegramHook(req, env, ctx);
      if (p === "/board") return board(req, env);
      if (p === "/admin" || p.startsWith("/admin/")) return admin(req, env, p);
      if (p === "/") return new Response("Price Check staff-help service is running.", { headers: { "content-type": "text/plain" } });
      return json({ error: "not found" }, cors, 404);
    } catch (e) {
      console.error(e && e.stack || e);
      return json({ error: "server error" }, cors, 500);
    }
  },

  // Backup timer (every minute): re-send / expire requests even if the customer closed the page.
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
function rid(n = 12) {
  const a = "abcdefghijkmnpqrstuvwxyz23456789", b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => a[x % a.length]).join("");
}
function slug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "staff"; }

async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SIGNING_KEY || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return Array.from(sig.slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
}
function sameString(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- time + shifts ----------
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
function isOnShift(s, now) {
  return (s.shifts || []).some((sh) => inWindow(normDays(sh.days), sh.start, sh.end, now));
}

// ---------- staff (stored in D1 settings) ----------
async function loadStaffData(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'staff'").first();
  let data;
  try { data = JSON.parse(row ? row.value : "{}"); } catch { data = {}; }
  const staff = Array.isArray(data.staff) ? data.staff : [];
  let changed = false;
  for (const s of staff) if (!s.link) { s.link = rid(16); changed = true; }   // personal Telegram connect code
  if (changed) await saveStaffData(env, { staff });
  return { staff };
}
async function saveStaffData(env, data) {
  await env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('staff', ?, ?)
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(JSON.stringify({ staff: data.staff }), Date.now()).run();
}
// People who can receive alerts right now: active, on shift, and connected to Telegram.
async function onShift(env) {
  const now = storeNow(env);
  const { staff } = await loadStaffData(env);
  return staff.filter((s) => s && s.name && s.chat_id && s.active !== false && isOnShift(s, now))
    .map((s) => ({ key: slug(s.name), name: s.name, chat_id: s.chat_id }));
}

// ---------- Telegram ----------
async function tg(env, method, body) {
  const base = (env.TG_API || "https://api.telegram.org").replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/bot${env.TELEGRAM_TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) console.error("telegram", method, r.status, JSON.stringify(j).slice(0, 300));
    return j;
  } catch (e) { console.error("telegram failed", method, e && e.message); return { ok: false }; }
}
async function hookSecret(env) { return sign(env, "telegram-webhook"); }
let botNameCache = null;
async function botUsername(env) {
  if (botNameCache) return botNameCache;
  if (!env.TELEGRAM_TOKEN) return null;
  const j = await tg(env, "getMe", {});
  if (j.ok) botNameCache = j.result.username;
  return botNameCache;
}

function alertText(r) {
  const lines = ["🚨 <b>Customer needs help</b>", `📍 ${esc(r.where_txt || "In the store")}`];
  if (r.item) lines.push(`🛒 ${esc(r.item)}`);
  if (r.rings > 0) lines.push(`⏰ Reminder ${r.rings}: nobody has accepted yet.`);
  lines.push("", "Tap <b>Accept</b> if you're going.");
  return lines.join("\n");
}
const acceptKeyboard = (id) => ({ inline_keyboard: [[{ text: "✅ Accept", callback_data: "a:" + id }]] });

// Send (or re-send) the alert to everyone on the request. Old copies are deleted so only one Accept button exists.
async function ringAll(r, env) {
  const people = JSON.parse(r.staff_json);
  const msgs = JSON.parse(r.msgs_json || "{}");
  const results = await Promise.all(people.map(async (p) => {
    if (msgs[p.key]) await tg(env, "deleteMessage", { chat_id: p.chat_id, message_id: msgs[p.key] });
    const j = await tg(env, "sendMessage", { chat_id: p.chat_id, text: alertText(r), parse_mode: "HTML", reply_markup: acceptKeyboard(r.id) });
    if (j.ok) msgs[p.key] = j.result.message_id;
    return !!j.ok;
  }));
  await env.DB.prepare("UPDATE requests SET msgs_json = ? WHERE id = ?").bind(JSON.stringify(msgs), r.id).run();
  // If someone accepted while we were sending, tidy up the messages we just sent.
  const now = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(r.id).first();
  if (now && now.status !== "open") await finalMessages(now, env);
  return results.some(Boolean);
}

// Replace every alert message with the outcome (no buttons).
async function finalMessages(r, env, skipKey) {
  const people = JSON.parse(r.staff_json);
  const msgs = JSON.parse(r.msgs_json || "{}");
  const where = r.where_txt || "in the store";
  await Promise.all(people.map((p) => {
    if (!msgs[p.key] || p.key === skipKey) return null;
    let text;
    if (r.status === "accepted") text = p.key === r.accepted_by
      ? `✅ <b>You're helping</b> the customer at ${esc(where)} (+${r.points} pts)`
      : `👍 <b>${esc(r.accepted_name)}</b> is helping the customer at ${esc(where)}`;
    else text = `❌ Missed: customer at ${esc(where)}. Nobody accepted.`;
    return tg(env, "editMessageText", { chat_id: p.chat_id, message_id: msgs[p.key], text, parse_mode: "HTML" });
  }));
}

async function telegramHook(req, env, ctx) {
  if (!sameString(req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", await hookSecret(env))) return new Response("forbidden", { status: 403 });
  const u = await req.json().catch(() => ({}));
  if (u.callback_query) ctx.waitUntil(onButton(u.callback_query, env));
  else if (u.message && u.message.chat && u.message.chat.type === "private") ctx.waitUntil(onMessage(u.message, env));
  return new Response("ok");
}

async function onMessage(msg, env) {
  const chat = msg.chat.id;
  const text = String(msg.text || "").trim();
  const data = await loadStaffData(env);
  const m = text.match(/^\/start(?:\s+([A-Za-z0-9_-]{8,64}))?$/);
  if (m && m[1]) {
    const person = data.staff.find((s) => s.link && sameString(s.link, m[1]));
    if (!person) return tg(env, "sendMessage", { chat_id: chat, text: "That link isn't valid. Ask the store owner for your personal link." });
    for (const s of data.staff) if (s.chat_id === chat && s !== person) delete s.chat_id;   // one person per phone
    person.chat_id = chat;
    await saveStaffData(env, data);
    return tg(env, "sendMessage", { chat_id: chat, parse_mode: "HTML",
      text: `✅ Hi <b>${esc(person.name)}</b>! You're connected.\n\nYou'll get customer help alerts here during your shifts. Keep notifications on for this chat, and tap <b>Accept</b> when you're going to help.` });
  }
  const me = data.staff.find((s) => s.chat_id === chat);
  const reply = me
    ? `You're connected as <b>${esc(me.name)}</b>. ${me.active === false ? "Your alerts are paused." : isOnShift(me, storeNow(env)) ? "You're on shift now." : "You're off shift now."}`
    : "Hi! This bot sends store help alerts to staff. Ask the store owner for your personal link to connect.";
  return tg(env, "sendMessage", { chat_id: chat, text: reply, parse_mode: "HTML" });
}

function pointsFor(ms) { return ms <= 30000 ? 3 : ms <= 60000 ? 2 : 1; }

async function onButton(cb, env) {
  const answer = (text, alert = false) => tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });
  const m = String(cb.data || "").match(/^a:([a-z0-9]{12})$/);
  if (!m) return answer("");
  const id = m[1];
  const r = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
  if (!r) return answer("This request no longer exists.", true);
  const person = JSON.parse(r.staff_json).find((p) => p.chat_id === cb.from.id);
  if (!person) return answer("You weren't on this alert.", true);

  const now = Date.now();
  const pts = pointsFor(now - r.created_at);
  const res = await env.DB.prepare(`UPDATE requests SET status = 'accepted', accepted_by = ?, accepted_name = ?, accepted_at = ?, points = ?
                                    WHERE id = ? AND status = 'open'`).bind(person.key, person.name, now, pts, id).run();
  if (res.meta.changes === 1) {
    const done = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
    await Promise.all([answer(`✅ Accepted! Go to ${r.where_txt || "the customer"}. +${pts} pts`), finalMessages(done, env)]);
    return;
  }
  const cur = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
  const msg = cur.status === "accepted"
    ? (cur.accepted_by === person.key ? "You already accepted this one." : `Already taken by ${cur.accepted_name}.`)
    : "This request has expired.";
  await answer(msg, true);
  if (cb.message) {
    const where = cur.where_txt || "in the store";
    const text = cur.status === "accepted" ? `👍 <b>${esc(cur.accepted_name)}</b> is helping the customer at ${esc(where)}` : `❌ Missed: customer at ${esc(where)}.`;
    await tg(env, "editMessageText", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text, parse_mode: "HTML" });
  }
}

// ---------- help requests ----------
async function status(env) {
  const n = (await onShift(env)).length;
  return { available: n > 0, on_shift: n };
}

async function createHelp(req, env) {
  const people = await onShift(env);
  if (!people.length) return [{ error: "no_staff", message: "No staff member is on shift right now." }, 409];

  const ip = req.headers.get("CF-Connecting-IP") || "local";
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT id, status FROM requests WHERE ip = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(ip, now - IP_COOLDOWN_MS).first();
  if (recent && recent.status !== "failed") return [{ id: recent.id, status: recent.status, note: "already_sent" }, 200];
  const openCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'open'").first();
  if ((openCount?.n || 0) >= MAX_OPEN_REQUESTS) return [{ error: "busy", message: "Staff are busy with other customers." }, 429];

  let body = {};
  try { body = await req.json(); } catch {}
  const r = { id: rid(), created_at: now, where_txt: clean(body.where, 60), item: clean(body.item, 120), status: "open",
              staff_json: JSON.stringify(people), msgs_json: "{}", last_ring: now, rings: 0, ip };
  await env.DB.prepare(`INSERT INTO requests (id, created_at, where_txt, item, status, staff_json, msgs_json, last_ring, rings, ip)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(r.id, r.created_at, r.where_txt, r.item, r.status, r.staff_json, r.msgs_json, r.last_ring, r.rings, r.ip).run();
  if (!(await ringAll(r, env))) {
    await env.DB.prepare("UPDATE requests SET status = 'failed' WHERE id = ?").bind(r.id).run();
    return [{ error: "send_failed", message: "Couldn't reach staff." }, 502];
  }
  return [{ id: r.id, status: "open", alerted: people.length }, 200];
}

// Re-send every 30 s while open; expire after 3 min. Atomic guards stop double-sending.
async function tick(r, env) {
  const now = Date.now();
  if (r.status !== "open") return;
  if (now - r.created_at >= EXPIRE_AFTER_MS) {
    const res = await env.DB.prepare("UPDATE requests SET status = 'expired' WHERE id = ? AND status = 'open'").bind(r.id).run();
    if (res.meta.changes) await finalMessages({ ...r, status: "expired" }, env);
    return;
  }
  if (now - r.last_ring >= RING_EVERY_MS) {
    const res = await env.DB.prepare("UPDATE requests SET last_ring = ?, rings = rings + 1 WHERE id = ? AND status = 'open' AND last_ring = ?")
      .bind(now, r.id, r.last_ring).run();
    if (res.meta.changes) await ringAll({ ...r, rings: r.rings + 1 }, env);
  }
}

async function helpState(id, env, ctx) {
  const r = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
  if (!r) return { status: "unknown" };
  let st = r.status;
  if (st === "open") {
    ctx.waitUntil(tick(r, env));
    if (Date.now() - r.created_at >= EXPIRE_AFTER_MS) st = "expired";
  }
  const out = { status: st };
  if (st === "accepted") out.by = r.accepted_name;
  return out;
}

// ---------- pages ----------
const PAGE_CSS = `:root{--bg:#f6f7f9;--card:#fff;--text:#15181d;--muted:#5d6470;--line:#dfe3e8;--accent:#1f6feb;--ok:#0a7a3d;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1c2026;--text:#f1f3f5;--muted:#a3abb6;--line:#313741;--accent:#4c8dff;--ok:#4ade80;--err:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:18px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px}
h1{font-size:24px;margin:0 0 10px}.ok{color:var(--ok)}.err{color:var(--err)}.muted{color:var(--muted)}
button,.btn{display:block;width:100%;min-height:56px;margin-top:16px;border:0;border-radius:14px;background:var(--accent);color:#fff;font:inherit;font-weight:700;cursor:pointer}
input{width:100%;min-height:50px;padding:10px 14px;font:inherit;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--text)}
table{width:100%;border-collapse:collapse;margin-top:6px}td,th{padding:8px 4px;border-bottom:1px solid var(--line);text-align:left}td.n,th.n{text-align:right}td:first-child{white-space:nowrap}
h2{font-size:18px;margin:22px 0 4px}a{color:var(--accent)}`;

function page(title, body, extraCss = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${PAGE_CSS}${extraCss}</style></head>
<body><main><div class="card">${body}</div></main></body></html>`;
}

// ---------- leaderboard ----------
function periodStart(env, kind) {
  const now = new Date();
  const t = storeNow(env, now);
  const wallNow = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi);
  const offset = wallNow - Math.floor(now.getTime() / 60000) * 60000;  // store wall clock minus UTC
  const startWall = kind === "week" ? Date.UTC(t.y, t.mo - 1, t.d - DAYS.indexOf(t.dow)) : Date.UTC(t.y, t.mo - 1, 1);
  return startWall - offset;
}

async function board(req, env) {
  const pin = new URL(req.url).searchParams.get("pin") || "";
  if (!env.BOARD_PIN || !sameString(pin, String(env.BOARD_PIN))) {
    return html(page("Staff points", `<h1>Staff points</h1>${pin ? `<p class="err">Wrong PIN.</p>` : ""}
<form method="GET"><label for="pin" class="muted">Enter PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="off" autofocus>
<button type="submit">Show points</button></form>`), pin ? 403 : 200);
  }
  const q = async (since) => (await env.DB.prepare(`SELECT accepted_name AS name, SUM(points) AS pts, COUNT(*) AS n,
      CAST(AVG(accepted_at - created_at) / 1000 AS INTEGER) AS avg_s
      FROM requests WHERE status = 'accepted' AND accepted_at >= ? GROUP BY accepted_by ORDER BY pts DESC, n DESC`).bind(since).all()).results || [];
  const [week, month, all] = await Promise.all([q(periodStart(env, "week")), q(periodStart(env, "month")), q(0)]);
  const recent = (await env.DB.prepare("SELECT * FROM requests WHERE status != 'failed' ORDER BY created_at DESC LIMIT 15").all()).results || [];
  const table = (rows) => rows.length ? `<table><tr><th>Name</th><th class="n">Points</th><th class="n">Helped</th><th class="n">Avg response</th></tr>${
    rows.map((r, i) => `<tr><td>${i === 0 ? "🏆 " : ""}${esc(r.name)}</td><td class="n"><b>${r.pts}</b></td><td class="n">${r.n}</td><td class="n">${r.avg_s}s</td></tr>`).join("")}</table>`
    : `<p class="muted">No points yet.</p>`;
  const fmt = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: env.TIMEZONE || "UTC", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  const recentRows = recent.map((r) => `<tr><td>${esc(fmt(r.created_at))}</td><td>${esc(r.where_txt || "—")}</td><td>${
    r.status === "accepted" ? `✅ ${esc(r.accepted_name)} (+${r.points}, ${Math.round((r.accepted_at - r.created_at) / 1000)}s)`
    : r.status === "open" ? "⏳ waiting" : r.status === "expired" ? "❌ missed" : esc(r.status)}</td></tr>`).join("");
  return html(page("Staff points", `<h1>🏆 Staff points</h1><p class="muted">3 pts if accepted within 30s · 2 pts within 1 min · 1 pt after that</p>
<h2>This week</h2>${table(week)}<h2>This month</h2>${table(month)}<h2>All time</h2>${table(all)}
<h2>Recent requests</h2>${recent.length ? `<table>${recentRows}</table>` : `<p class="muted">None yet.</p>`}`));
}

// ---------- shift editor (/admin) ----------
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const ADMIN_CSS = `
.person{border:1px solid var(--line);border-radius:14px;padding:14px;margin-top:14px}
.person h3{margin:0 0 6px;font-size:18px;display:flex;justify-content:space-between;gap:8px;align-items:center}
.day{display:grid;grid-template-columns:88px minmax(0,1fr) minmax(0,1fr);gap:6px;align-items:center;margin-top:6px}
.day input{min-height:42px;padding:6px 6px;font-size:16px;width:100%;min-width:0}
input[type=checkbox]{width:22px;height:22px;min-height:22px;padding:0;flex:0 0 auto}
.tag{font-size:13px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--line);white-space:nowrap}
.tag.on{background:var(--ok);color:var(--card)}
.code{font-family:ui-monospace,Consolas,monospace;font-size:14px;user-select:all;word-break:break-all}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:15px}
.row label{display:flex;gap:6px;align-items:center}
.small{font-size:14px}
.btn2{display:inline-block;width:auto;min-height:40px;margin:8px 0 0;padding:6px 14px;font-size:15px;background:var(--line);color:var(--text)}
.top{display:flex;justify-content:space-between;gap:10px;align-items:center}
.box{border-radius:12px;padding:10px 12px;margin-top:8px;font-size:15px;background:var(--bg)}`;

async function adminCookie(env) {
  const exp = Date.now() + ADMIN_SESSION_MS;
  return `${exp}.${await sign(env, "admin:" + exp + ":" + env.ADMIN_PIN)}`;
}
async function isAdmin(req, env) {
  const c = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)pc_admin=([0-9]+)\.([a-f0-9]{32})/);
  if (!c || Number(c[1]) < Date.now()) return false;
  return sameString(c[2], await sign(env, "admin:" + c[1] + ":" + env.ADMIN_PIN));
}
const redirect = (to, extra = {}) => new Response(null, { status: 303, headers: { Location: to, ...extra } });

function loginPage(bad) {
  return page("Shift editor", `<h1>🗓️ Staff shifts</h1>${bad ? `<p class="err">Wrong PIN.</p>` : ""}
<form method="POST" action="/admin/login"><label for="pin" class="muted">Owner PIN</label>
<input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus>
<button type="submit">Open</button></form>`);
}

async function admin(req, env, p) {
  if (!env.ADMIN_PIN) return html(page("Shift editor", "<h1>Shift editor</h1><p>Admin PIN is not set.</p>"), 503);
  if (p === "/admin/login" && req.method === "POST") {
    const f = await req.formData();
    if (sameString(String(f.get("pin") || ""), String(env.ADMIN_PIN))) {
      return redirect("/admin", { "Set-Cookie": `pc_admin=${await adminCookie(env)}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_MS / 1000}` });
    }
    return html(loginPage(true), 403);
  }
  if (p === "/admin/logout") return redirect("/admin", { "Set-Cookie": "pc_admin=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
  if (!(await isAdmin(req, env))) return html(loginPage(false));

  const data = await loadStaffData(env);

  if (p === "/admin/save" && req.method === "POST") {
    const f = await req.formData();
    const n = Number(f.get("count") || 0);
    const out = [];
    const used = new Set();
    for (let i = 0; i <= n; i++) {                       // row n is the "add a person" row
      const name = clean(f.get(`name_${i}`), 40);
      if (!name || f.get(`remove_${i}`) || used.has(slug(name))) continue;
      used.add(slug(name));
      const orig = String(f.get(`orig_${i}`) || name);
      const prev = i < n ? data.staff.find((s) => slug(s.name) === slug(orig)) : null;
      const shifts = [];
      for (const d of DAYS) {
        const st = String(f.get(`${d}_s_${i}`) || ""), en = String(f.get(`${d}_e_${i}`) || "");
        if (toMins(st) != null && toMins(en) != null && st !== en) shifts.push({ days: [d], start: st, end: en });
      }
      const person = { name, link: (prev && prev.link) || rid(16), active: !f.get(`paused_${i}`), shifts };
      if (prev && prev.chat_id) person.chat_id = prev.chat_id;
      out.push(person);
    }
    await saveStaffData(env, { staff: out });
    return redirect("/admin?saved=1");
  }

  if (p === "/admin/test" && req.method === "POST") {
    const f = await req.formData();
    const person = data.staff.find((s) => slug(s.name) === String(f.get("key") || ""));
    let ok = false;
    if (person && person.chat_id) ok = (await tg(env, "sendMessage", { chat_id: person.chat_id, parse_mode: "HTML",
      text: `🔔 <b>Test alert</b>\nHi ${esc(person.name)}, staff alerts are working on this phone.` })).ok;
    return redirect(`/admin?test=${ok ? "ok" : "fail"}&who=${encodeURIComponent(person ? person.name : "")}`);
  }

  if (p === "/admin/disconnect" && req.method === "POST") {
    const f = await req.formData();
    const person = data.staff.find((s) => slug(s.name) === String(f.get("key") || ""));
    if (person) { delete person.chat_id; person.link = rid(16); await saveStaffData(env, data); }
    return redirect("/admin?disconnected=1");
  }

  if (p === "/admin/setup-telegram" && req.method === "POST") {
    const base = (env.PUBLIC_URL || new URL(req.url).origin).replace(/\/+$/, "");
    const j = await tg(env, "setWebhook", { url: base + "/tg/hook", secret_token: await hookSecret(env),
      allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    await tg(env, "setMyDescription", { description: "Store help alerts for staff. Ask the store owner for your personal connect link." });
    return redirect(`/admin?tg=${j.ok ? "ok" : "fail"}`);
  }

  // ----- editor page -----
  const url = new URL(req.url);
  const now = storeNow(env);
  const bot = await botUsername(env);
  const hook = env.TELEGRAM_TOKEN ? await tg(env, "getWebhookInfo", {}) : { ok: false };
  const hookOk = hook.ok && hook.result && hook.result.url && hook.result.url.endsWith("/tg/hook");
  const q = (k) => url.searchParams.get(k);
  const msg = q("saved") ? `<p class="ok"><b>✓ Saved.</b> Changes are live now.</p>`
    : q("test") === "ok" ? `<p class="ok"><b>✓ Test alert sent to ${esc(q("who"))}.</b></p>`
    : q("test") === "fail" ? `<p class="err"><b>Test alert failed.</b> Is ${esc(q("who"))} connected to Telegram?</p>`
    : q("tg") === "ok" ? `<p class="ok"><b>✓ Telegram bot connected.</b></p>`
    : q("tg") === "fail" ? `<p class="err"><b>Couldn't connect the Telegram bot.</b> Check the bot token.</p>`
    : q("disconnected") ? `<p class="ok"><b>✓ Disconnected.</b> They have a new connect link now.</p>` : "";
  const botBox = !env.TELEGRAM_TOKEN ? `<div class="box err">Telegram bot token is not set yet.</div>`
    : !bot ? `<div class="box err">Telegram bot token doesn't work. Check it with BotFather.</div>`
    : `<div class="box">Telegram bot: <b>@${esc(bot)}</b> · ${hookOk ? `<span class="ok">✓ connected</span>`
        : `<span class="err">not connected</span><form method="POST" action="/admin/setup-telegram"><button class="btn2" type="submit">Connect bot</button></form>`}</div>`;
  const dayRows = (s, i) => DAYS.map((d) => {
    const sh = (s.shifts || []).find((x) => normDays(x.days).includes(d)) || {};
    const end = sh.end === "24:00" ? "23:59" : (sh.end || "");
    return `<div class="day"><span>${DAY_LABEL[d]}${d === now.dow ? " •" : ""}</span>
      <input type="time" name="${d}_s_${i}" value="${esc(sh.start || "")}" aria-label="${DAY_LABEL[d]} start">
      <input type="time" name="${d}_e_${i}" value="${esc(end)}" aria-label="${DAY_LABEL[d]} end"></div>`;
  }).join("");
  const people = data.staff.map((s, i) => {
    const on = s.active !== false && isOnShift(s, now);
    const label = s.active === false ? "Paused" : on ? "On shift now" : "Off now";
    const link = bot ? `https://t.me/${bot}?start=${s.link}` : "";
    const tgLine = s.chat_id
      ? `<div class="row small"><span class="ok">✓ Telegram connected</span>
         <button class="btn2" type="submit" form="test_${slug(s.name)}">🔔 Send test alert</button>
         <button class="btn2" type="submit" form="disc_${slug(s.name)}">Disconnect</button></div>`
      : `<div class="box small"><b class="err">Not connected to Telegram yet.</b> Send ${esc(s.name)} this link and ask them to tap <b>Start</b>:<br>
         <span class="code">${esc(link || "(set up the bot first)")}</span></div>`;
    return `<div class="person"><h3><span>${esc(s.name)}</span><span class="tag ${on && s.chat_id ? "on" : ""}">${label}${on && !s.chat_id ? " · not connected" : ""}</span></h3>
      <input type="hidden" name="orig_${i}" value="${esc(s.name)}">
      <div class="row"><label>Name <input name="name_${i}" value="${esc(s.name)}" style="min-height:40px;width:160px"></label></div>
      ${tgLine}
      ${dayRows(s, i)}
      <div class="row"><label><input type="checkbox" name="paused_${i}" ${s.active === false ? "checked" : ""}> Pause alerts (holiday/leave)</label>
      <label><input type="checkbox" name="remove_${i}"> Remove person</label></div></div>`;
  }).join("");
  const n = data.staff.length;
  const forms = data.staff.map((s) => `<form id="test_${slug(s.name)}" method="POST" action="/admin/test"><input type="hidden" name="key" value="${slug(s.name)}"></form>
<form id="disc_${slug(s.name)}" method="POST" action="/admin/disconnect"><input type="hidden" name="key" value="${slug(s.name)}"></form>`).join("");
  const clock = `${String(now.h).padStart(2, "0")}:${String(now.mi).padStart(2, "0")}`;
  return html(page("Shift editor", `<div class="top"><h1>🗓️ Staff shifts</h1><a class="small" href="/admin/logout">Log out</a></div>
${botBox}
<p class="muted small">Enter each person's start and end time for each day. Leave a day empty for a day off (no alerts that day).
Store time now: ${DAY_LABEL[now.dow]} ${clock}.</p>
${msg}<form method="POST" action="/admin/save"><input type="hidden" name="count" value="${n}">
${people || `<p class="muted">No staff yet. Add the first person below.</p>`}
<div class="person"><h3>➕ Add a person</h3><div class="row"><label>Name <input name="name_${n}" placeholder="e.g. Shyam" style="min-height:40px;width:160px"></label></div>
${dayRows({}, n)}</div>
<button type="submit">💾 Save shifts</button></form>${forms}
<p class="small"><a href="/board">🏆 Staff points</a></p>`, ADMIN_CSS));
}
