/* supabase-sync.js — Login en la nube + sincronización de localStorage vía Supabase.

   ORDEN DE CARGA (importante):
     - En páginas de la app (HOME, Visor, Reporte, Precios): cargar DESPUÉS de
       support.js y ANTES de evm-ns.js.
     - En EVM.dc.html (login): cargar después de support.js.

   Captura el localStorage REAL de forma síncrona (antes de que evm-ns lo
   envuelva), para que la sesión de Supabase y la sincronización de datos
   siempre usen el almacén crudo — consistente entre el login y las páginas
   con espacios de nombres por usuario. */
(function () {
  var SUPABASE_URL = 'https://vregdbocqyswbdozetac.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_ERzkofdw5MxN4gKF2t3zNA_6_Dj6BY4';
  var EMAIL_DOMAIN = 'agdmiami.com';   // usuarios sin @ -> <usuario>@agdmiami.com

  // --- capturar el almacén REAL + métodos nativos ANTES de que evm-ns envuelva ---
  var REAL = window.localStorage;
  var _get = Storage.prototype.getItem;
  var _set = Storage.prototype.setItem;
  var _rem = Storage.prototype.removeItem;
  function rawGet(k) { try { return _get.call(REAL, k); } catch (e) { return null; } }
  function rawSet(k, v) { try { return _set.call(REAL, k, v); } catch (e) {} }
  function rawRem(k) { try { return _rem.call(REAL, k); } catch (e) {} }

  // almacenamiento propio para supabase-js: su sesión NO pasa por el namespacing
  var authStorage = {
    getItem: function (k) { return rawGet(k); },
    setItem: function (k, v) { rawSet(k, v); },
    removeItem: function (k) { rawRem(k); },
  };

  // --- qué claves se sincronizan a la nube ---
  function syncable(k) {
    if (!k) return false;
    if (k.indexOf('sb-') === 0 || k.indexOf('sb_') === 0) return false; // sesión supabase
    if (k === 'evm_auth') return false;         // sesión del dispositivo, no se sincroniza
    if (k.indexOf('evm_cloud') === 0) return false;
    if (k.indexOf('evm_ws') === 0) return false;         // workspace activo (por dispositivo)
    if (k.indexOf('evm_orgs') === 0) return false;       // membresía: viene de la nube (org_members)
    if (k.indexOf('evm_migrated') === 0) return false;   // banderas de migración local
    if (k.indexOf('evm_builds_umig') === 0) return false;
    // imágenes pesadas: NO se sincronizan (etapa 2 = almacenamiento de archivos)
    if (k.indexOf('agd_obj_photos') >= 0) return false;   // fotos de objetos (data URLs)
    if (k.indexOf('agd_proj_covers') >= 0) return false;  // portadas de proyecto (data URLs)
    return true;
  }

  // extrae el id de organización de una clave "org::<id>::<clave>" (null si es personal/global)
  function orgOf(k) {
    if (k && k.indexOf('org::') === 0) {
      var rest = k.slice(5), i = rest.indexOf('::');
      if (i > 0) return rest.slice(0, i);
    }
    return null;
  }

  // --- cola de subida (con retraso para agrupar cambios) ---
  var dirty = {};
  var flushTimer = null;
  var suppress = false;   // true mientras pullAll escribe, para no re-subir
  var sessionUser = null;

  function queue(k) {
    if (suppress || !syncable(k)) return;
    dirty[k] = true;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 1500);
  }

  // observar escrituras: envolvemos el prototipo, así el _set que capture
  // evm-ns luego ES el nuestro y vemos la clave final (con espacio de nombres)
  Storage.prototype.setItem = function (k, v) {
    var r = _set.call(this, k, v);
    try { if (this === REAL) queue(k); } catch (e) {}
    return r;
  };
  Storage.prototype.removeItem = function (k) {
    var r = _rem.call(this, k);
    try { if (this === REAL) queue(k); } catch (e) {}
    return r;
  };

  // --- cliente supabase (se carga async desde CDN) ---
  var client = null;
  var readyResolve, readyReject;
  var ready = new Promise(function (res, rej) { readyResolve = res; readyReject = rej; });

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = function () { rej(new Error('load ' + src)); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js')
    .then(function () {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true }
      });
      client.auth.getSession().then(function (r) {
        sessionUser = (r && r.data && r.data.session) ? r.data.session.user : null;
      });
      client.auth.onAuthStateChange(function (_e, s) { sessionUser = s ? s.user : null; });
      readyResolve(client);
    })
    .catch(function (e) { readyReject(e); });

  function emailOf(user) {
    user = String(user || '').trim();
    if (!user) return '';
    return user.indexOf('@') >= 0 ? user.toLowerCase() : (user.toLowerCase() + '@' + EMAIL_DOMAIN);
  }

  async function currentUserId() {
    if (sessionUser) return sessionUser.id;
    try { var r = await client.auth.getUser(); sessionUser = r.data.user; return sessionUser ? sessionUser.id : null; }
    catch (e) { return null; }
  }

  async function flush() {
    flushTimer = null;
    var keys = Object.keys(dirty); dirty = {};
    if (!keys.length || !client) { return; }
    var uid = await currentUserId();
    if (!uid) { keys.forEach(function (k) { dirty[k] = true; }); return; }
    var upserts = [], deletes = [];          // personales -> user_data
    var orgUp = [], orgDel = [];             // compartidos -> org_data
    keys.forEach(function (k) {
      var v = rawGet(k);
      var oid = orgOf(k);
      if (oid) {
        if (v == null) orgDel.push({ org_id: oid, key: k });
        else orgUp.push({ org_id: oid, key: k, value: v, updated_at: new Date().toISOString() });
      } else if (v == null) { deletes.push(k); }
      else { upserts.push({ user_id: uid, key: k, value: v, updated_at: new Date().toISOString() }); }
    });
    try {
      if (upserts.length) {
        var r1 = await client.from('user_data').upsert(upserts, { onConflict: 'user_id,key' });
        if (r1.error) throw r1.error;
      }
      if (deletes.length) {
        var r2 = await client.from('user_data').delete().eq('user_id', uid).in('key', deletes);
        if (r2.error) throw r2.error;
      }
      if (orgUp.length) {
        var r3 = await client.from('org_data').upsert(orgUp, { onConflict: 'org_id,key' });
        if (r3.error) throw r3.error;
      }
      for (var od = 0; od < orgDel.length; od++) {
        var r4 = await client.from('org_data').delete().eq('org_id', orgDel[od].org_id).eq('key', orgDel[od].key);
        if (r4.error) throw r4.error;
      }
    } catch (e) {
      // reintentar en el próximo ciclo
      keys.forEach(function (k) { dirty[k] = true; });
      if (!flushTimer) flushTimer = setTimeout(flush, 4000);
    }
  }

  window.EVMCloud = {
    ready: ready,

    // traduce errores comunes de Supabase al español
    _esErr: function (msg) {
      if (!msg) return msg;
      if (/invalid login credentials/i.test(msg)) return 'Usuario o contraseña incorrectos.';
      if (/email not confirmed/i.test(msg)) return 'Falta confirmar el correo. Revisa tu bandeja y aprieta el enlace.';
      if (/already registered|already been registered/i.test(msg)) return 'Ese correo ya tiene cuenta. Si no recuerdas la clave usa “¿Olvidaste tu contraseña?”.';
      if (/password should be|at least 6/i.test(msg)) return 'La contraseña debe tener al menos 6 caracteres.';
      if (/rate limit|too many|security purposes/i.test(msg)) return 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
      if (/invalid email|unable to validate email/i.test(msg)) return 'Ese correo no es válido.';
      return msg;
    },
    _loginUrl: function () {
      try { var u = new URL(location.href); u.search = ''; u.hash = ''; return u.toString(); } catch (e) { return location.href; }
    },

    // SOLO iniciar sesión (no crea cuentas)
    signIn: async function (user, pass) {
      try { await ready; } catch (e) { return { ok: false, error: 'No se pudo cargar la conexión.' }; }
      var email = emailOf(user);
      if (!email || !pass) return { ok: false, error: 'Faltan datos.' };
      var r = await client.auth.signInWithPassword({ email: email, password: pass });
      if (r.error) return { ok: false, error: window.EVMCloud._esErr(r.error.message) };
      sessionUser = r.data.user;
      return { ok: true, user: r.data.user };
    },

    // crear cuenta explícitamente
    signUp: async function (user, pass) {
      try { await ready; } catch (e) { return { ok: false, error: 'No se pudo cargar la conexión.' }; }
      var email = emailOf(user);
      if (!email || !pass) return { ok: false, error: 'Faltan datos.' };
      var su = await client.auth.signUp({ email: email, password: pass, options: { emailRedirectTo: window.EVMCloud._loginUrl() } });
      if (su.error) return { ok: false, error: window.EVMCloud._esErr(su.error.message) };
      if (su.data && su.data.user && !su.data.session) return { ok: true, needsConfirm: true };
      sessionUser = su.data.user;
      return { ok: true, user: su.data.user };
    },

    // enviar correo de recuperación de contraseña
    resetPassword: async function (user) {
      try { await ready; } catch (e) { return { ok: false, error: 'No se pudo cargar la conexión.' }; }
      var email = emailOf(user);
      if (!email) return { ok: false, error: 'Escribe tu correo.' };
      var r = await client.auth.resetPasswordForEmail(email, { redirectTo: window.EVMCloud._loginUrl() });
      if (r.error) return { ok: false, error: window.EVMCloud._esErr(r.error.message) };
      return { ok: true };
    },

    // guardar nueva contraseña (tras llegar por el enlace de recuperación)
    updatePassword: async function (pass) {
      try { await ready; } catch (e) { return { ok: false, error: 'No se pudo cargar la conexión.' }; }
      var r = await client.auth.updateUser({ password: pass });
      if (r.error) return { ok: false, error: window.EVMCloud._esErr(r.error.message) };
      return { ok: true };
    },

    // inicia sesión; si la cuenta no existe, la crea (una sola vez) y entra
    signInOrUp: async function (user, pass) {
      try { await ready; } catch (e) { return { ok: false, error: 'No se pudo cargar la conexión.' }; }
      var email = emailOf(user);
      if (!email || !pass) return { ok: false, error: 'Faltan datos.' };
      var r = await client.auth.signInWithPassword({ email: email, password: pass });
      if (r.error) {
        var su = await client.auth.signUp({ email: email, password: pass });
        if (su.error) {
          // credenciales inválidas reales (cuenta existe, clave mala) o error de registro
          return { ok: false, error: 'Usuario o contraseña incorrectos.' };
        }
        if (su.data && su.data.user && !su.data.session) {
          // se creó pero requiere confirmar correo
          return { ok: false, error: 'Cuenta creada, pero falta confirmar el correo (desactiva "Confirm email" en Supabase).' };
        }
        r = await client.auth.signInWithPassword({ email: email, password: pass });
        if (r.error) return { ok: false, error: r.error.message };
      }
      sessionUser = r.data.user;
      return { ok: true, user: r.data.user };
    },

    // baja todos los datos del usuario desde la nube al almacén local
    pullAll: async function () {
      try { await ready; } catch (e) { return { ok: false }; }
      var uid = await currentUserId();
      if (!uid) return { ok: false };
      var r = await client.from('user_data').select('key,value');
      if (r.error) return { ok: false, error: r.error.message };
      suppress = true;
      try {
        (r.data || []).forEach(function (row) {
          if (row.value != null) rawSet(row.key, row.value);
        });
      } finally { suppress = false; }
      try { await window.EVMCloud.pullOrgs(); } catch (e) {}
      return { ok: true, count: (r.data || []).length };
    },

    // baja mi membresía de organizaciones (org_members) y sus datos compartidos (org_data)
    pullOrgs: async function () {
      try { await ready; } catch (e) { return { ok: false }; }
      var email = null;
      try { email = (sessionUser && sessionUser.email) || (((await client.auth.getUser()).data.user) || {}).email; } catch (e) {}
      if (!email) return { ok: false };
      var m = await client.from('org_members').select('org_id,org_name');
      if (m.error) return { ok: false, error: m.error.message };
      var rows = m.data || [];
      var uname = String(email).split('@')[0];
      var orgs = rows.map(function (row) { return { id: row.org_id, name: row.org_name || row.org_id, members: [uname] }; });
      suppress = true;
      try { rawSet('evm_orgs', JSON.stringify(orgs)); } finally { suppress = false; }
      if (rows.length) {
        var ids = rows.map(function (r2) { return r2.org_id; });
        var d = await client.from('org_data').select('key,value').in('org_id', ids);
        if (!d.error) {
          suppress = true;
          try { (d.data || []).forEach(function (row) { if (row.value != null) rawSet(row.key, row.value); }); }
          finally { suppress = false; }
        }
      }
      return { ok: true, orgs: orgs.length };
    },

    // sube todo el localStorage actual a la nube (respaldo completo inicial)
    pushAll: async function () {
      try { await ready; } catch (e) { return { ok: false }; }
      var uid = await currentUserId();
      if (!uid) return { ok: false };
      for (var i = 0; i < REAL.length; i++) {
        var k = Storage.prototype.key.call(REAL, i);
        if (syncable(k)) dirty[k] = true;
      }
      await flush();
      return { ok: true };
    },

    pushNow: async function () { await flush(); },

    // --- Storage de planos (PDF) en la nube ---
    uploadPlan: async function (key, blob) {
      try { await ready; } catch (e) { return false; }
      try {
        var r = await client.storage.from('planos').upload(key, blob, { upsert: true, contentType: 'application/pdf' });
        return !r.error;
      } catch (e) { return false; }
    },
    downloadPlan: async function (key) {
      try { await ready; } catch (e) { return null; }
      try {
        var r = await client.storage.from('planos').download(key);
        if (r.error) return null;
        return r.data;   // Blob
      } catch (e) { return null; }
    },

    signOut: async function () { try { await ready; await client.auth.signOut(); } catch (e) {} },
    currentUser: async function () { try { await ready; return (await client.auth.getUser()).data.user; } catch (e) { return null; } },
    // verifica la contraseña del usuario actual contra Supabase (para confirmar acciones)
    verifyPassword: async function (pass) {
      try { await ready; } catch (e) { return false; }
      try {
        var u = (await client.auth.getUser()).data.user;
        if (!u || !u.email || !pass) return false;
        var r = await client.auth.signInWithPassword({ email: u.email, password: pass });
        return !r.error;
      } catch (e) { return false; }
    },
    // diagnóstico: qué ve el cliente de la sesión
    debugSession: async function () {
      var out = {};
      try { await ready; out.ready = true; } catch (e) { out.ready = false; return out; }
      try {
        var s = await client.auth.getSession();
        out.hasSession = !!(s.data && s.data.session);
        if (s.error) out.sessErr = s.error.message;
        if (s.data && s.data.session) { out.expiresAt = s.data.session.expires_at; out.tokenLen = (s.data.session.access_token || '').length; }
      } catch (e) { out.sessThrow = String(e); }
      try {
        var u = await client.auth.getUser();
        out.user = (u.data && u.data.user) ? u.data.user.email : null;
        if (u.error) out.userErr = u.error.message;
      } catch (e) { out.userThrow = String(e); }
      return out;
    },
  };

  // intento de vaciar la cola al salir de la página
  window.addEventListener('beforeunload', function () { try { if (Object.keys(dirty).length) flush(); } catch (e) {} });

  // --- asegurar sesión viva en las páginas de la app ---
  // Si la app entró por la marca local (evm_auth) pero NO hay sesión real de
  // Supabase (vencida/ausente), intentamos renovarla; si no se puede, mandamos
  // al login para reconectar de verdad (así todo se sincroniza).
  (function enforceSession() {
    var path = (location.pathname || '');
    if (/EVM\.dc\.html$/i.test(path)) return;      // página de login: no forzar
    if (!rawGet('evm_auth')) return;                // no cree estar logueado: no molestar
    (async function () {
      try { await ready; } catch (e) { return; }
      var u = null;
      // valida contra el servidor (no solo la sesión guardada, que puede estar vencida)
      try { u = (await client.auth.getUser()).data.user; } catch (e) {}
      if (!u) { try { u = (await client.auth.refreshSession()).data.user; } catch (e) {} }
      if (u) return;                                 // sesión viva y válida: todo bien
      // no hay sesión válida -> reconectar
      try { rawRem('evm_auth'); } catch (e) {}
      try {
        var url = new URL(location.href);
        url.pathname = url.pathname.replace(/[^/]+$/, 'EVM.dc.html');
        url.search = '';
        location.href = url.toString();
      } catch (e) {}
    })();
  })();
})();
