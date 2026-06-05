const CACHE = 'ccal-v89'
const SHELL = ['/', '/index.html', '/pbs.html']

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' })))
  )
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)

  // App shell：cache-first（確保離線可開）
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // 線上時更新快取
          caches.open(CACHE).then(c => c.put(e.request, res.clone()))
          return res
        })
        .catch(() =>
          // 離線時依序找：完整 URL → '/' → '/index.html'
          caches.match(e.request)
            .then(r => r || caches.match('/'))
            .then(r => r || caches.match('/index.html'))
        )
    )
    return
  }

  // GET API：network-first，失敗才用快取
  if (url.pathname.startsWith('/api/') && e.request.method === 'GET') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()))
          return res
        })
        .catch(() => caches.match(e.request))
    )
    return
  }

  // 其餘（POST/DELETE、外部資源）：直接走網路
})
