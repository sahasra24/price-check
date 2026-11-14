(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    scanBtn: $("scanBtn"), camWrap: $("camWrap"), stopBtn: $("stopBtn"),
    result: $("result"), found: $("found"), notFound: $("notFound"),
    pName: $("pName"), pPrice: $("pPrice"), pCode: $("pCode"),
    clearBtn: $("clearBtn"), againBtn: $("againBtn"),
    photoInput: $("photoInput"), typeForm: $("typeForm"), codeInput: $("codeInput"),
    msg: $("msg")
  };

  var products = new Map();   // normalized barcode -> product
  var loaded = null;          // promise for the product list
  var scanner = null;         // Html5Qrcode instance for the live camera
  var scanning = false;
  var handled = false;

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
    loaded = fetch("products.json?v=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
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

  function find(code) {
    var p = products.get(normalize(code));
    if (!p) { var a = upcEtoA(code); if (a) p = products.get(normalize(a)); }
    return p || null;
  }

  // ---------- UI ----------
  function showMsg(t) { els.msg.textContent = t || ""; }

  function formatPrice(v) {
    var n = Number(v);
    return isFinite(n) ? "$" + n.toFixed(2) : "";
  }

  function showResult(code) {
    var clean = String(code).replace(/\s+/g, "");
    var p = find(clean);
    els.pCode.textContent = clean;
    if (p && formatPrice(p.price)) {
      els.pName.textContent = p.name || "";
      els.pPrice.textContent = formatPrice(p.price);
      els.found.hidden = false;
      els.notFound.hidden = true;
    } else {
      els.found.hidden = true;
      els.notFound.hidden = false;
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
    showMsg("");
  }

  function lookup(code) {
    (loaded || loadProducts()).then(function () { showResult(code); });
  }

  function buzz() { try { if (navigator.vibrate) navigator.vibrate(120); } catch (e) {} }

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

    scanner.start(
      { facingMode: "environment" },
      {
        fps: 12,
        qrbox: function (w, h) {
          var bw = Math.floor(w * 0.9), bh = Math.floor(Math.min(h * 0.6, bw * 0.6));
          return { width: Math.max(bw, 50), height: Math.max(bh, 50) };
        }
      },
      function onScan(text) {
        if (handled) return;
        handled = true;
        buzz();
        stopCamera().then(function () { lookup(text); });
      },
      function () { /* no code in this frame */ }
    ).then(function () {
      scanning = true;
    }).catch(function (err) {
      console.error(err);
      els.camWrap.hidden = true;
      els.scanBtn.hidden = false;
      showMsg("Camera not available. Allow camera access, or use 'Take a photo' / type the number below.");
    });
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

  // Always open blank, even when the browser restores the page from its back/forward cache.
  window.addEventListener("pageshow", function (e) { if (e.persisted) { clearResult(); loadProducts(); } });
  // Pick up price changes when the customer returns to the tab.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") loadProducts();
    else if (scanning) stopCamera().then(function () { if (els.result.hidden) els.scanBtn.hidden = false; });
  });

  clearResult();
  loadProducts();
})();
