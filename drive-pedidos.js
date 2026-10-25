/* Guardado de pedidos en Google Drive (carpeta PEDIDOS/<subcarpeta>)
   Usado por PEDIDOS 2.0 y por Pedidos por proveedor.
   Solo pide el permiso "drive.file": la app únicamente ve los archivos y carpetas que crea ella. */
(function () {
  'use strict';
  // ID de cliente OAuth de Google (no es secreto). Mientras esté vacío, el guardado en Drive está desactivado.
  const CLIENT_ID = '472590921346-26boo4n0bj8lvbt6eggsrp9u0dd7cuuk.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const ROOT_NAME = 'PEDIDOS';
  const KEY = 'drivePedidos';

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  let st = load();
  let tokenClient = null, pending = null;
  const listeners = new Set();
  const emit = () => listeners.forEach(fn => { try { fn(api.status()); } catch {} });

  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar Google (¿sin conexión?)'));
      document.head.appendChild(s);
    });
  }
  // Se carga al abrir la página para que el botón Guardar pueda abrir la ventana de Google al instante.
  if (CLIENT_ID) loadGis().catch(() => {});

  const tokenValid = () => st.token && st.expires && Date.now() < st.expires - 60000;

  function getToken(interactive) {
    if (tokenValid()) return Promise.resolve(st.token);
    if (!interactive) return Promise.reject(new Error('Sesión de Google caducada'));
    if (!window.google?.accounts?.oauth2) return loadGis().then(() => getToken(true));
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPE,
        callback: r => {
          const p = pending; pending = null;
          if (r.error) return p && p.reject(new Error('Google no dio permiso: ' + r.error));
          st.token = r.access_token; st.expires = Date.now() + (r.expires_in || 3600) * 1000; st.connected = true;
          save(st); emit(); p && p.resolve(st.token);
        },
        error_callback: e => { const p = pending; pending = null; p && p.reject(new Error(e?.type === 'popup_closed' ? 'Ventana de Google cerrada' : 'No se pudo abrir Google')); }
      });
    }
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      tokenClient.requestAccessToken({ prompt: st.connected ? '' : 'consent' });
    });
  }

  async function gfetch(url, opts = {}, retry = true) {
    const token = await getToken(false);
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
    if (res.status === 401 && retry) { st.token = null; save(st); throw new Error('Sesión de Google caducada'); }
    if (!res.ok) throw new Error('Drive respondió ' + res.status);
    return res.status === 204 ? null : res.json();
  }

  async function folder(name, parent) {
    st.folders = st.folders || {};
    const key = parent + '/' + name;
    if (st.folders[key]) {
      try { const f = await gfetch(`https://www.googleapis.com/drive/v3/files/${st.folders[key]}?fields=id,trashed`); if (!f.trashed) return f.id; } catch {}
    }
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parent}' in parents`);
    const found = await gfetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
    let id = found.files?.[0]?.id;
    if (!id) {
      const f = await gfetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] })
      });
      id = f.id;
    }
    st.folders[key] = id; save(st);
    return id;
  }

  function multipart(meta, blob) {
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    fd.append('file', blob);
    return fd;
  }

  const api = {
    configured: () => !!CLIENT_ID,
    status: () => ({ configured: !!CLIENT_ID, connected: !!st.connected, active: !!tokenValid() }),
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    // Llamar dentro de un clic: abre la ventana de Google si hace falta.
    connect: () => getToken(true),
    disconnect() {
      if (st.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(st.token, () => {});
      st = {}; save(st); emit();
    },
    // Prepara el permiso al pulsar Guardar (dentro del clic). Devuelve una promesa.
    ensure: interactive => (CLIENT_ID && st.connected) ? getToken(interactive) : Promise.reject(new Error('Drive no conectado')),
    /** Sube (o reemplaza) un PDF en PEDIDOS/<subfolder>. Devuelve el id del archivo en Drive. */
    async uploadPdf(subfolder, filename, blob, existingId) {
      const parent = await folder(subfolder, await folder(ROOT_NAME, 'root'));
      if (existingId) {
        try {
          const f = await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,trashed`, {
            method: 'PATCH', body: multipart({ name: filename }, blob)
          });
          if (!f.trashed) return f.id;
        } catch (e) { if (/caducada/.test(e.message)) throw e; }
      }
      const f = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST', body: multipart({ name: filename, parents: [parent], mimeType: 'application/pdf' }, blob)
      });
      return f.id;
    }
  };
  window.DrivePedidos = api;
})();
