const CACHE = 'fisiocenter-v39';
const ASSETS = ['/', '/index.html', '/style.css', '/script.js', '/mobile-styles.css', '/mobile-script.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Nunca cacheia chamadas de API — só assets estáticos. Dado dinâmico servido
  // do cache em caso de falha de rede fazia a tela "voltar no tempo" após F5,
  // mostrando alocações já apagadas/criadas como se ainda não tivessem sido
  // salvas. A API agora é same-origin (antes era o Supabase, cross-origin),
  // então checar só a origem não basta mais — precisa excluir o path /api/ também.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
