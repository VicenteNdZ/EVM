/* EVM per-user / per-organization storage namespace + auth gate.
   Include with <script src="evm-ns.js"></script> inside <helmet> on every APP
   page (HOME, Visor proyecto, Visor de Plano) — NOT on EVM.dc.html.

   Model
   -----
   - Every account has a private PERSONAL workspace:  u::<user>::<key>
   - Accounts can belong to an ORGANIZATION whose workspace is shared by all
     its members (within this browser):              org::<orgId>::<key>
   - The active workspace per user is stored in evm_ws::<user> and can be
     switched from the app (a reload re-points all storage to it).
   - Any key beginning with 'evm_' is shared/global and never namespaced
     (evm_auth, evm_orgs, evm_ws::*, evm_migrated).

   No cloud sync: sharing works between accounts on the SAME browser. Real
   cross-device company sync would need a backend (Supabase/Firebase). */
(function () {
  try {
    var real = window.localStorage;
    var _get = Storage.prototype.getItem;
    var _set = Storage.prototype.setItem;
    var _rem = Storage.prototype.removeItem;
    var _key = Storage.prototype.key;
    var _clr = Storage.prototype.clear;
    function rget(k) { return _get.call(real, k); }
    function rset(k, v) { return _set.call(real, k, v); }

    // ---- who is signed in ----
    var raw = rget('evm_auth');
    var user = null;
    if (raw) { try { user = (JSON.parse(raw) || {}).user || null; } catch (e) {} }
    if (!user) {
      var url = new URL(location.href);
      url.pathname = url.pathname.replace(/[^/]+$/, 'EVM.dc.html');
      url.search = '';
      location.replace(url.toString());
      return;
    }

    // ---- organizations registry (seed AGD with Vicente + Domi) ----
    var orgs = null;
    try { orgs = JSON.parse(rget('evm_orgs') || 'null'); } catch (e) {}
    if (!orgs) {
      orgs = [];
      rset('evm_orgs', JSON.stringify(orgs));
    }
    function myOrgsOf(u) {
      return orgs.filter(function (o) { return (o.members || []).indexOf(u) >= 0; });
    }
    var myOrgs = myOrgsOf(user);

    // ---- active workspace ----
    var WSKEY = 'evm_ws::' + user;
    var ws = rget(WSKEY);
    if (!ws) { ws = myOrgs.length ? ('org::' + myOrgs[0].id) : 'personal'; rset(WSKEY, ws); }
    if (ws.indexOf('org::') === 0) {
      var oid = ws.slice(5);
      var member = myOrgs.some(function (o) { return o.id === oid; });
      if (!member) { ws = 'personal'; rset(WSKEY, ws); }
    }

    if (window.__evmNSInstalled) return;
    window.__evmNSInstalled = true;

    var PFX = (ws.indexOf('org::') === 0) ? ('org::' + ws.slice(5) + '::') : ('u::' + user + '::');
    var UPFX = 'u::' + user + '::';   // per-user prefix, independent of active workspace

    // expose for the UI (workspace switcher / user chip)
    window.__evmUser = user;
    window.__evmOrgs = orgs;
    window.__evmMyOrgs = myOrgs;
    window.__evmWs = ws;
    window.__evmPfx = PFX;

    function isGlobal(k) { return k.indexOf('evm_') === 0; }
    // The Builds library is tied to the signed-in USER for the whole session —
    // the same Builds show in Personal and in any Organization space.
    function isUserScoped(k) { return k.indexOf('agd_builds') === 0; }
    function map(k) { return isGlobal(k) ? k : (isUserScoped(k) ? UPFX + k : PFX + k); }

    // ---- one-time: pull existing Builds into the per-user space ----
    // Older data may sit under the org or personal workspace prefix. Pick the
    // RICHEST builds array (most sets / golden rectangles) across all spaces so
    // a freshly-seeded empty Personal copy never hides the real one.
    try {
      var UMIG = 'evm_builds_umig2::' + user;
      if (!rget(UMIG)) {
        var pfxs = [UPFX, PFX];
        for (var m = 0; m < myOrgs.length; m++) pfxs.push('org::' + myOrgs[m].id + '::');
        var richness = function (val) {
          try {
            var a = JSON.parse(val); if (!Array.isArray(a)) return -1;
            var s = 0;
            for (var i = 0; i < a.length; i++) {
              s += 1 + (((a[i].sets && a[i].sets.length) || 0) * 100) + ((a[i].items && a[i].items.length) || 0);
            }
            return s;
          } catch (e) { return -1; }
        };
        var bestVal = null, bestR = -1, seen = {};
        for (var p = 0; p < pfxs.length; p++) {
          if (seen[pfxs[p]]) continue; seen[pfxs[p]] = 1;
          var v = rget(pfxs[p] + 'agd_builds_v1');
          if (!v) continue;
          var r = richness(v);
          if (r > bestR) { bestR = r; bestVal = v; }
        }
        var curR = richness(rget(UPFX + 'agd_builds_v1') || '');
        if (bestVal && bestR > curR) rset(UPFX + 'agd_builds_v1', bestVal);
        rset(UMIG, '1');
      }
    } catch (e) {}

    // ---- one-time migration of legacy (pre-login) data ----
    // Hand existing projects/builds to the company workspace (AGD) so members
    // share them; if the user has no org, keep them in their personal space.
    try {
      if (!rget('evm_migrated')) {
        var target = myOrgs.length ? ('org::' + myOrgs[0].id + '::') : ('u::' + user + '::');
        var legacy = [];
        for (var i = 0; i < real.length; i++) {
          var k = _key.call(real, i);
          if (!k || isGlobal(k)) continue;
          if (k.indexOf('u::') === 0 || k.indexOf('org::') === 0) continue;
          legacy.push(k);
        }
        for (var j = 0; j < legacy.length; j++) rset(target + legacy[j], rget(legacy[j]));
        rset('evm_migrated', '1');
      }
    } catch (e) { /* best-effort */ }

    // ---- install the namespacing shim ----
    var shim = {
      getItem: function (k) { return _get.call(real, map(k)); },
      setItem: function (k, v) { return _set.call(real, map(k), v); },
      removeItem: function (k) { return _rem.call(real, map(k)); },
      key: function (i) { return _key.call(real, i); },
      clear: function () { return _clr.call(real); },
    };
    Object.defineProperty(shim, 'length', { get: function () { return real.length; } });
    Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return shim; } });
  } catch (e) { /* fail open */ }
})();
