(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    storeName: $("storeName"), sub: $("sub"), openStatus: $("openStatus"),
    scanBtn: $("scanBtn"), camWrap: $("camWrap"), stopBtn: $("stopBtn"),
    result: $("result"), found: $("found"), notFound: $("notFound"),
    saleBadge: $("saleBadge"), pName: $("pName"), pWas: $("pWas"), pWasPrice: $("pWasPrice"),
    pPrice: $("pPrice"), pSave: $("pSave"), pSaleNote: $("pSaleNote"), pCode: $("pCode"),
    clearBtn: $("clearBtn"), againBtn: $("againBtn"),
    photoInput: $("photoInput"), typeForm: $("typeForm"), codeInput: $("codeInput"),
    helpCard: $("helpCard"), helpBtn: $("helpBtn"), helpPanel: $("helpPanel"), helpForm: $("helpForm"),
    whereInput: $("whereInput"), sendHelp: $("sendHelp"), cancelHelp: $("cancelHelp"),
    helpStatus: $("helpStatus"),
    storeInfo: $("storeInfo"), infoBody: $("infoBody"),
    msg: $("msg")
  };

  var DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var DAY_NAMES = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

  var products = new Map();   // normalized barcode -> product
  var store = {};             // store.json
  var helpApi = "";           // staff-help service URL (store.json "help_api")
  var helpAvailable = false;  // is anyone on shift right now?
  var helpReq = null;         // id of the customer's current help request
  var helpPoll = null;
  var loaded = null;          // promise for the product list
  var scanner = null;
  var scanning = false;
  var handled = false;
  var lastItem = null;        // {name, barcode} of the last lookup, sent along with a help request

  // ---------- Helpers ----------
  function fetchJSON(name) {
    return fetch(name + "?v=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(name + ": HTTP " + r.status); return r.json(); });
  }
  function txt(v) { return v == null ? "" : String(v).trim(); }

  // Current date/time in the STORE's time zone (so sales and shifts follow store time).
  function storeNow() {
    var opts = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
                 weekday: "short", hourCycle: "h23" };
    var parts;
    try {
      if (store.timezone) opts.timeZone = store.timezone;
      parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(new Date());
    } catch (e) {
      delete opts.timeZone;
      parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(new Date());
    }
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    return { date: o.year + "-" + o.month + "-" + o.day, dow: o.weekday.slice(0, 3),
             mins: (Number(o.hour) % 24) * 60 + Number(o.minute) };
  }

  function toMins(t) {
    var m = /^(\d{1,2}):?(\d{2})$/.exec(txt(t));
    if (!m) return null;
    var v = Number(m[1]) * 60 + Number(m[2]);
    return v <= 1440 ? v : null;
  }
  function fmtTime(t) {
    var v = toMins(t); if (v == null) return txt(t);
    var h = Math.floor(v / 60) % 24, m = v % 60;
    return ((h + 11) % 12 + 1) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "AM" : "PM");
  }

  // ["sat","Sunday"] / "Weekend" / "Fri-Sun" -> ["Sat","Sun"]
  function normDays(v) {
    if (v == null || v === "") return [];
    var list = Array.isArray(v) ? v : String(v).split(/[,;/ ]+/);
    var out = [];
    list.forEach(function (raw) {
      var s = txt(raw).toLowerCase();
      if (!s) return;
      if (s === "weekend" || s === "weekends") { out.push("Sat", "Sun"); return; }
      if (s === "weekday" || s === "weekdays") { out.push("Mon", "Tue", "Wed", "Thu", "Fri"); return; }
      if (s === "daily" || s === "everyday" || s === "all") { out.push.apply(out, DAYS); return; }
      var r = s.split("-");
      if (r.length === 2) {
        var a = DAYS.indexOf(cap3(r[0])), b = DAYS.indexOf(cap3(r[1]));
        if (a !== -1 && b !== -1) { for (var i = a; ; i = (i + 1) % 7) { out.push(DAYS[i]); if (i === b) break; } }
        return;
      }
      var d = cap3(s);
      if (DAYS.indexOf(d) !== -1) out.push(d);
    });
    return out.filter(function (d, i) { return out.indexOf(d) === i; });
  }
  function cap3(s) { s = txt(s).slice(0, 3).toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }

  // Is "now" inside [start, end) on one of the given days? Handles overnight windows (e.g. 22:00-06:00).
  function inWindow(days, start, end, now) {
    var s = toMins(start), e = toMins(end);
    if (s == null || e == null || s === e) return false;
    var has = function (d) { return !days.length || days.indexOf(d) !== -1; };
    if (e > s) return has(now.dow) && now.mins >= s && now.mins < e;
    var prev = DAYS[(DAYS.indexOf(now.dow) + 6) % 7];
    return (has(now.dow) && now.mins >= s) || (has(prev) && now.mins < e);
  }

  function parseHours(v) {           // "09:00-21:00" -> {start, end}; "Closed"/"" -> null
    var m = /^\s*(\d{1,2}:?\d{2})\s*[-–to]+\s*(\d{1,2}:?\d{2})\s*$/i.exec(txt(v));
    return m ? { start: m[1], end: m[2] } : null;
  }

  function telHref(p) { return "tel:" + txt(p).replace(/[^\d+]/g, ""); }

  // ---------- Product data ----------
  function normalize(code) {
    var s = String(code == null ? "" : code).replace(/\s+/g, "").toUpperCase();
    if (/^\d+$/.test(s)) s = s.replace(/^0+/, "") || "0"; // UPC-A (12) == EAN-13 with leading 0
    return s;
  }

  // UPC-E (8 digits incl. number system + check) -> UPC-A, for a second-chance lookup.
  function upcEtoA(code) {
    var s = String(code).replace(/\s+/g, "");
    if (!/^[01]\d{7}$/.test(s)) return null;
    var ns = s[0], d = s.slice(1, 7), chk = s[7], m;
    var last = d[5];
    if (last <= "2") m = d.slice(0, 2) + last + "0000" + d.slice(2, 5);
    else if (last === "3") m = d.slice(0, 3) + "00000" + d.slice(3, 5);
    else if (last === "4") m = d.slice(0, 4) + "00000" + d[4];
    else m = d.slice(0, 5) + "0000" + last;
    return ns + m + chk;
  }

  function loadProducts() {
    loaded = fetchJSON("products.json")
      .then(function (list) {
        var m = new Map();
        (list || []).forEach(function (p) {
          if (p && p.barcode != null) m.set(normalize(p.barcode), p);
        });
        products = m;
      })
      .catch(function (e) {
        console.error("Could not load products.json", e);
        showMsg("Couldn't load prices. Check your connection and try again.");
      });
    return loaded;
  }

  function loadConfig() {
    return Promise.all([
      fetchJSON("store.json").then(function (s) { store = s || {}; }, function () { store = {}; })
    ]).then(function () {
      helpApi = txt(store.help_api).replace(/\/+$/, "");
      renderStore();
      refreshTimed();
      checkHelpAvailable();
    });
  }

  function find(code) {
    var p = products.get(normalize(code));
    if (!p) { var a = upcEtoA(code); if (a) p = products.get(normalize(a)); }
    return p || null;
  }

  // Sale is active when sale_price < price, today is within sale_start..sale_end (if set),
  // and today is one of sale_days (if set) -- all in store time.
  function activeSale(p, now) {
    if (p.sale_price == null || p.sale_price === "") return null;
    var sp = Number(p.sale_price), rp = Number(p.price);
    if (!isFinite(sp) || !isFinite(rp) || !(sp < rp) || sp < 0) return null;
    if (p.sale_start && now.date < String(p.sale_start)) return null;
    if (p.sale_end && now.date > String(p.sale_end)) return null;
    var days = normDays(p.sale_days);
    if (days.length && days.indexOf(now.dow) === -1) return null;
    return { price: sp, save: rp - sp, end: p.sale_end || null, days: days };
  }

  // ---------- UI ----------
  function showMsg(t) { els.msg.textContent = t || ""; }

  function money(v) {
    var n = Number(v);
    return isFinite(n) ? "$" + n.toFixed(2) : "";
  }

  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(txt(iso));
    if (!m) return txt(iso);
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  function showResult(code) {
    var clean = String(code).replace(/\s+/g, "");
    var p = find(clean);
    els.pCode.textContent = clean;
    if (p && money(p.price)) {
      var sale = activeSale(p, storeNow());
      els.pName.textContent = p.name || "";
      els.saleBadge.hidden = els.pWas.hidden = els.pSave.hidden = els.pSaleNote.hidden = !sale;
      els.pPrice.classList.toggle("on-sale", !!sale);
      if (sale) {
        els.pWasPrice.textContent = money(p.price);
        els.pPrice.textContent = money(sale.price);
        els.pSave.textContent = "You save " + money(sale.save);
        els.pSaleNote.textContent = sale.end ? "Sale ends " + fmtDate(sale.end)
          : (sale.days.length && sale.days.length < 7 ? "Sale price on " + sale.days.map(function (d) { return DAY_NAMES[d]; }).join(", ") : "");
        els.pSaleNote.hidden = !els.pSaleNote.textContent;
      } else {
        els.pPrice.textContent = money(p.price);
      }
      els.found.hidden = false;
      els.notFound.hidden = true;
      lastItem = { name: p.name || "", barcode: clean };
    } else {
      els.found.hidden = true;
      els.notFound.hidden = false;
      lastItem = { name: "Item with no price in the system", barcode: clean };
    }
    showMsg("");
    els.result.hidden = false;
    els.scanBtn.hidden = true;
    els.result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function clearResult() {
    els.result.hidden = true;
    els.pName.textContent = els.pPrice.textContent = els.pCode.textContent = "";
    els.codeInput.value = "";
    els.scanBtn.hidden = false;
    lastItem = null;
    showMsg("");
  }

  function lookup(code) {
    (loaded || loadProducts()).then(function () { showResult(code); });
  }

  function buzz() { try { if (navigator.vibrate) navigator.vibrate(120); } catch (e) {} }

  // ---------- Store info ----------
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function block(title) {
    var b = el("div", { "class": "info-block" });
    b.appendChild(el("h3", null, title));
    els.infoBody.appendChild(b);
    return b;
  }
  function contactLines(parent, c) {
    if (txt(c.name)) parent.appendChild(el("p", null, txt(c.name) + (txt(c.role) ? " · " + txt(c.role) : "")));
    if (txt(c.phone)) { var p = el("p"); p.appendChild(el("a", { href: telHref(c.phone) }, "📞 " + txt(c.phone))); parent.appendChild(p); }
    if (txt(c.email)) { var e = el("p"); e.appendChild(el("a", { href: "mailto:" + txt(c.email) }, "✉️ " + txt(c.email))); parent.appendChild(e); }
  }

  function hasHours() {
    var h = store.hours || {};
    return DAYS.some(function (d) { return txt(h[d]); });
  }

  function renderStore() {
    var s = store || {};
    var name = txt(s.name);
    if (name) {
      els.storeName.textContent = name;
      els.sub.textContent = "Price Check — scan any item's barcode to see its price.";
      document.title = name + " · Price Check";
    }

    els.infoBody.textContent = "";
    var any = false;

    if (txt(s.address)) {
      var b = block("Location");
      b.appendChild(el("p", null, txt(s.address)));
      var map = txt(s.map_url) || "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(txt(s.address));
      var p = el("p"); p.appendChild(el("a", { href: map, target: "_blank", rel: "noopener" }, "📍 Open in Maps")); b.appendChild(p);
      any = true;
    }

    if (hasHours()) {
      var hb = block("Opening hours");
      var tbl = el("table", { "class": "hours" });
      var today = storeNow().dow;
      DAYS.forEach(function (d) {
        var raw = txt((s.hours || {})[d]);
        var w = parseHours(raw);
        var tr = el("tr", d === today ? { "class": "today" } : null);
        tr.appendChild(el("td", null, DAY_NAMES[d] + (d === today ? " (today)" : "")));
        tr.appendChild(el("td", null, w ? fmtTime(w.start) + " – " + fmtTime(w.end) : (raw || "Closed")));
        tbl.appendChild(tr);
      });
      hb.appendChild(tbl);
      any = true;
    }

    var desk = s.help_desk || {};
    if (txt(desk.phone) || txt(desk.email)) { contactLines(block("Help desk"), desk); any = true; }

    var mgr = s.manager || {};
    if (txt(mgr.name) || txt(mgr.phone) || txt(mgr.email)) { contactLines(block("Store manager"), mgr); any = true; }

    if (txt(s.notes)) { block("Good to know").appendChild(el("p", null, txt(s.notes))); any = true; }

    els.storeInfo.hidden = !any;
  }

  function renderOpenStatus(now) {
    if (!hasHours()) { els.openStatus.hidden = true; return; }
    var h = store.hours || {};
    var prev = DAYS[(DAYS.indexOf(now.dow) + 6) % 7];
    var w = parseHours(h[now.dow]), pw = parseHours(h[prev]);
    var openNow = (w && inWindow([now.dow], w.start, w.end, now)) ||
                  (pw && toMins(pw.end) < toMins(pw.start) && inWindow([prev], pw.start, pw.end, now));
    var cur = openNow ? ((w && inWindow([now.dow], w.start, w.end, now)) ? w : pw) : null;
    if (openNow) {
      els.openStatus.textContent = "● Open now · until " + fmtTime(cur.end);
      els.openStatus.className = "open-status open";
    } else if (w && now.mins < toMins(w.start)) {
      els.openStatus.textContent = "● Closed now · opens at " + fmtTime(w.start);
      els.openStatus.className = "open-status closed";
    } else {
      els.openStatus.textContent = "● Closed now";
      els.openStatus.className = "open-status closed";
    }
    els.openStatus.hidden = false;
  }

  // ---------- Call staff ----------
  // The staff list and shifts are private on the help service; the page only asks "is anyone on shift?"
  function api(path, opts) {
    return fetch(helpApi + path, opts).then(function (r) {
      return r.json().then(function (j) { j._status = r.status; return j; }, function () { return { _status: r.status }; });
    });
  }

  function checkHelpAvailable() {
    if (!helpApi) { helpAvailable = false; updateHelpButton(); return; }
    api("/api/status", { cache: "no-store" }).then(function (j) {
      helpAvailable = !!j.available; updateHelpButton();
    }, function () { helpAvailable = false; updateHelpButton(); });
  }

  function updateHelpButton() {
    var can = !!(helpAvailable || helpReq);
    els.helpBtn.hidden = !can || !els.helpPanel.hidden;      // the form replaces the button while open
    els.helpCard.hidden = !can && els.helpPanel.hidden;
    if (!helpAvailable && !helpReq && !els.helpPanel.hidden && !els.helpStatus.classList.contains("ok")) els.helpPanel.hidden = true;
  }

  function refreshTimed() { renderOpenStatus(storeNow()); }

  function setHelpStatus(kind, text, phone) {
    els.helpStatus.className = "help-status " + (kind || "");
    els.helpStatus.textContent = text || "";
    if (phone) {
      els.helpStatus.appendChild(document.createTextNode(" "));
      els.helpStatus.appendChild(el("a", { href: telHref(phone) }, "Call " + phone));
    }
  }

  function openHelp() {
    els.helpPanel.hidden = false;
    updateHelpButton();
    if (helpReq) {
      els.helpForm.hidden = true;           // a request is already in progress; keep showing its status
    } else {
      els.helpForm.hidden = false;
      setHelpStatus("", "");
      els.sendHelp.disabled = false;
    }
    els.helpPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function sendHelp() {
    var deskPhone = txt((store.help_desk || {}).phone);
    if (!helpApi) { setHelpStatus("err", "Staff alerts aren't set up. Please go to the counter.", deskPhone); return; }
    var where = txt(els.whereInput.value).slice(0, 60);
    var item = lastItem ? (lastItem.name + " (" + lastItem.barcode + ")") : "";
    els.sendHelp.disabled = true;
    setHelpStatus("", "Sending…");
    api("/api/help", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ where: where, item: item }) })
      .then(function (j) {
        if (j.id) {
          helpReq = j.id;
          els.helpForm.hidden = true;
          els.whereInput.value = "";
          buzz();
          setHelpStatus("wait", "🔔 Staff have been alerted. Waiting for someone to accept…");
          pollHelp();
        } else {
          els.sendHelp.disabled = false;
          setHelpStatus("err", (j.message || "Couldn't reach staff.") + " Please go to the counter.", deskPhone);
          if (j.error === "no_staff") { helpAvailable = false; updateHelpButton(); }
        }
      }, function () {
        els.sendHelp.disabled = false;
        setHelpStatus("err", "Couldn't reach staff. Please go to the counter.", deskPhone);
      });
  }

  function pollHelp() {
    clearTimeout(helpPoll);
    if (!helpReq) return;
    api("/api/help/" + helpReq, { cache: "no-store" }).then(function (j) {
      if (j.status === "accepted") {
        setHelpStatus("ok", "✓ " + (j.by || "A staff member") + " is on the way to help you!");
        buzz();
        endHelp();
      } else if (j.status === "expired" || j.status === "failed" || j.status === "unknown") {
        setHelpStatus("err", "Sorry, everyone is busy right now. Please go to the counter.", txt((store.help_desk || {}).phone));
        endHelp();
      } else {
        helpPoll = setTimeout(pollHelp, 3000);
      }
    }, function () { helpPoll = setTimeout(pollHelp, 5000); });
  }

  function endHelp() {
    clearTimeout(helpPoll);
    helpReq = null;
    updateHelpButton();
  }

  // ---------- Camera scanning ----------
  function formats() {
    var F = window.Html5QrcodeSupportedFormats;
    return F ? [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.QR_CODE] : undefined;
  }

  function newScanner(id) {
    return new Html5Qrcode(id, {
      formatsToSupport: formats(),
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }, // native BarcodeDetector when available
      verbose: false
    });
  }

  function startCamera() {
    if (!window.Html5Qrcode) { showMsg("Scanner didn't load. Use 'Take a photo' or type the number below."); return; }
    clearResult();
    showMsg("");
    els.scanBtn.hidden = true;
    els.camWrap.hidden = false;
    handled = false;
    if (!scanner) scanner = newScanner("reader");

    var onScan = function (text) {
      if (handled) return;
      handled = true;
      buzz();
      stopCamera().then(function () { lookup(text); });
    };
    var config = {
      fps: 15,
      disableFlip: true,
      // Wide, short box shaped like a product barcode.
      qrbox: function (w, h) {
        var bw = Math.floor(w * 0.92), bh = Math.floor(Math.min(h * 0.5, bw * 0.45));
        return { width: Math.max(bw, 80), height: Math.max(bh, 60) };
      },
      // Ask for a sharp HD picture with autofocus: small barcodes on wrappers need the detail.
      videoConstraints: {
        facingMode: "environment",
        width: { ideal: 1920 }, height: { ideal: 1080 },
        advanced: [{ focusMode: "continuous" }]
      }
    };
    var noFrame = function () { /* no code in this frame */ };

    scanner.start({ facingMode: "environment" }, config, onScan, noFrame)
      .catch(function () {                       // some phones reject the HD request: fall back to the basic camera
        delete config.videoConstraints;
        return scanner.start({ facingMode: "environment" }, config, onScan, noFrame);
      })
      .then(function () {
        scanning = true;
        zoomIn();
      }).catch(function (err) {
      console.error(err);
      els.camWrap.hidden = true;
      els.scanBtn.hidden = false;
      showMsg("Camera not available. Allow camera access, or use 'Take a photo' / type the number below.");
    });
  }

  // A little zoom lets the phone focus on a small barcode without holding it too close.
  function zoomIn() {
    try {
      var caps = scanner.getRunningTrackCapabilities && scanner.getRunningTrackCapabilities();
      if (caps && caps.zoom && caps.zoom.max >= 1.5) {
        scanner.applyVideoConstraints({ advanced: [{ zoom: Math.min(2, caps.zoom.max) }] }).catch(function () {});
      }
    } catch (e) { /* zoom not supported: fine */ }
  }

  function stopCamera() {
    var done = function () { scanning = false; els.camWrap.hidden = true; };
    if (scanner && scanning) {
      return scanner.stop().then(done, done);
    }
    done();
    return Promise.resolve();
  }

  // ---------- Photo fallback ----------
  var fileScanner = null;
  function scanPhoto(file) {
    if (!file) return;
    if (!window.Html5Qrcode) { showMsg("Scanner didn't load. Please type the number below."); return; }
    showMsg("Reading photo…");
    stopCamera().then(function () {
      if (!fileScanner) fileScanner = newScanner("fileReader");
      return fileScanner.scanFile(file, false);
    }).then(function (text) {
      buzz();
      lookup(text);
    }).catch(function () {
      showMsg("Couldn't read a barcode in that photo. Try again closer, or type the number below.");
    }).then(function () { els.photoInput.value = ""; });
  }

  // ---------- Wire up ----------
  els.scanBtn.addEventListener("click", startCamera);
  els.againBtn.addEventListener("click", startCamera);
  els.stopBtn.addEventListener("click", function () {
    stopCamera().then(function () { els.scanBtn.hidden = false; });
  });
  els.clearBtn.addEventListener("click", clearResult);
  els.photoInput.addEventListener("change", function () { scanPhoto(els.photoInput.files[0]); });
  els.typeForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = els.codeInput.value.trim();
    if (!v) { els.codeInput.focus(); return; }
    els.codeInput.blur();
    stopCamera().then(function () { lookup(v); });
  });
  els.helpBtn.addEventListener("click", openHelp);
  els.cancelHelp.addEventListener("click", function () { els.helpPanel.hidden = true; updateHelpButton(); });
  els.helpForm.addEventListener("submit", function (e) { e.preventDefault(); sendHelp(); });

  // Always open blank, even when the browser restores the page from its back/forward cache.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) { clearResult(); if (!helpReq) els.helpPanel.hidden = true; loadProducts(); loadConfig(); }
  });
  // Pick up price/staff changes when the customer returns to the tab.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { loadProducts(); loadConfig(); }
    else if (scanning) stopCamera().then(function () { if (els.result.hidden) els.scanBtn.hidden = false; });
  });
  setInterval(function () { refreshTimed(); checkHelpAvailable(); }, 30 * 1000); // shifts and hours change over time

  clearResult();
  loadProducts();
  loadConfig();
})();
