/* Guardado en el aparato para que las apps de la tienda abran sin conexión (o con el wifi flojo).
   - Páginas y datos de esta web (v2.html, alta.html, pvp.json…): SIEMPRE se intenta primero la red, así que con conexión
     se ve lo último publicado. Si no hay red, o tarda demasiado, se usa la copia guardada y se actualiza por detrás.
   - Librerías de fuera (lector de códigos, Excel, PDF, tipos de letra): llevan la versión en la dirección y no cambian,
     así que se usa la copia guardada y solo se descargan la primera vez.
   - Google (Drive, inicio de sesión), Groq, Gemini y todo lo que no sea una lectura (GET) no se toca.
   Para desactivarlo: publicar un sw.js que solo haga self.registration.unregister(). */
const CACHE = 'tienda-v1';
const PAGINAS = ['v2.html', 'alta.html', 'etiquetas.html', 'pan.html', 'facturas.html', 'drive-pedidos.js'];
const DATOS = ['barras.json', 'pvp.json', 'modificados.json'];
const LIBRERIAS = [
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'
];
const HOSTS_LIBRERIAS = ['unpkg.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.gstatic.com'];
const ESPERA_PAGINA = 4000, ESPERA_DATOS = 6000;   // ms antes de tirar de la copia guardada

// Una respuesta que llegó tras una redirección no sirve para abrir una página: se rehace sin esa marca
const limpia = res => res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
const clave = url => url.origin + url.pathname;   // sin ?_=123 (las páginas lo añaden para saltarse la caché del navegador)
// La copia guardada va marcada, para que la página sepa que no es una descarga nueva (Pedidos 2.0 no cambia la hora del catálogo)
function copia(res) {
  const h = new Headers(res.headers);
  h.set('X-Copia-Guardada', '1');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const base = new URL('./', self.location).href;
    // Cada archivo por separado: si uno falla, los demás se guardan igual
    await Promise.all([
      ...[...PAGINAS, ...DATOS].map(async f => {
        try { const res = await fetch(base + f, { cache: 'no-cache' }); if (res.ok) await cache.put(base + f, limpia(res)); } catch {}
      }),
      ...LIBRERIAS.map(async u => {
        try { const res = await fetch(u, { mode: 'cors', credentials: 'omit' }); if (res.ok) await cache.put(u, res); } catch {}
      })
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('tienda-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* Esta web: primero la red; la copia guardada solo si la red falla o tarda más de `espera` */
async function redPrimero(event, k, espera) {
  const cache = await caches.open(CACHE);
  const guardado = await cache.match(k);
  const red = fetch(event.request).then(async res => {
    if (res.ok) await cache.put(k, limpia(res.clone()));
    return res;
  });
  if (!guardado) return red;
  event.waitUntil(red.catch(() => {}));   // aunque se responda con la copia, la descarga sigue y la actualiza
  let reloj;
  const tarde = new Promise(resolve => { reloj = setTimeout(() => resolve(null), espera); });
  try {
    const res = await Promise.race([red, tarde]);
    return res && res.ok ? res : copia(guardado);
  } catch {
    return copia(guardado);
  } finally {
    clearTimeout(reloj);
  }
}

/* Librerías con versión fija: la copia guardada; si no hay, se descarga y se guarda */
async function copiaPrimero(request) {
  const cache = await caches.open(CACHE);
  const guardado = await cache.match(request.url);
  if (guardado) return guardado;
  try {
    const res = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) await cache.put(request.url, res.clone());
    return res;
  } catch {
    return fetch(request);
  }
}

/* Hoja de estilos de Google Fonts: la copia guardada al instante y se refresca por detrás */
async function copiaYRefresca(event) {
  const cache = await caches.open(CACHE);
  const guardado = await cache.match(event.request.url);
  const red = fetch(event.request.url, { mode: 'cors', credentials: 'omit' }).then(async res => {
    if (res.ok) await cache.put(event.request.url, res.clone());
    return res;
  });
  if (!guardado) return red;
  event.waitUntil(red.catch(() => {}));
  return guardado;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/.netlify/')) return;
    event.respondWith(redPrimero(event, clave(url), req.mode === 'navigate' ? ESPERA_PAGINA : ESPERA_DATOS));
  } else if (HOSTS_LIBRERIAS.includes(url.hostname)) {
    event.respondWith(copiaPrimero(req));
  } else if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(copiaYRefresca(event));
  }
});
