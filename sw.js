/* Prompt 工坊 Service Worker：PWA 离线缓存（PRM-03: 命名空间化缓存 + 导航回退收紧） */
var CACHE = 'prompt-studio-v3';
/* 本应用命名空间前缀：activate 只清理该前缀下的旧版本缓存，
   不会误删同源部署的其他应用（它们的缓存名不带此前缀）。 */
var NS = 'prompt-studio-';
var ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        /* PRM-03: 只删除本应用命名空间内的旧版本，保留其它应用的缓存 */
        return Promise.all(keys.filter(function (k) {
          return k.indexOf(NS) === 0 && k !== CACHE;
        }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;

  function cachedHome() {
    return caches.open(CACHE).then(function (c) { return c.match('./index.html'); });
  }

  /* PRM-03: 只有页面导航请求才允许离线回退到 index.html——
     脚本/图片等资源离线失败时返回真实失败，不用 HTML 冒充成功资源。 */
  if (e.request.mode === 'navigate') {
    var network = fetch(e.request);
    // Extend the worker lifetime before returning, including the asynchronous put.
    e.waitUntil(network.then(function (res) {
      var home = new URL('./', self.location.href);
      var requested = new URL(e.request.url);
      var delivered = new URL(res.url || e.request.url);
      var isHome = function (url) {
        return url.origin === home.origin &&
          (url.pathname === home.pathname || url.pathname === home.pathname + 'index.html');
      };
      if (!res.ok || res.redirected || !isHome(requested) || !isHome(delivered) ||
          !/^text\/html(?:;|$)/i.test(res.headers.get('Content-Type') || '')) return;
      var copy = res.clone();
      return caches.open(CACHE).then(function (c) { return c.put('./index.html', copy); });
    }).catch(function () {}));
    e.respondWith(
      network.then(function (res) {
        if (res.ok) return res;
        return cachedHome().then(function (hit) { return hit || res; });
      }).catch(function () {
        return cachedHome();
      })
    );
    return;
  }

  /* 同源静态资源：缓存优先，离线失败如实失败 */
  var resource = caches.open(CACHE).then(function (c) {
    return c.match(e.request).then(function (hit) { return hit || fetch(e.request); });
  });
  e.waitUntil(resource.then(function (res) {
    if (!res.ok || new URL(e.request.url).origin !== self.location.origin) return;
    var copy = res.clone();
    return caches.open(CACHE).then(function (c) { return c.put(e.request, copy); });
  }).catch(function () {}));
  e.respondWith(resource);
});
