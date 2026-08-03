/* 宝くじ分析ラボ - Service Worker
 *
 * 更新するときは APP_VERSION を必ず上げてください。
 * （旧版は index.html をキャッシュ優先で返していたため、
 *   再アップロードしても永久に古い画面が出るという不具合がありました）
 */
const APP_VERSION = 'v2.3.0';
const CACHE = 'lotolab-' + APP_VERSION;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // 1つでも失敗すると addAll 全体が失敗するので個別に入れる
      .then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ページ側から「すぐ有効化して」と言われたら従う
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function networkFirst(req, fallbackUrl) {
  return fetch(req)
    .then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => caches.match(req).then(hit => hit || (fallbackUrl ? caches.match(fallbackUrl) : undefined)));
}

function cacheFirst(req) {
  return caches.match(req).then(hit => {
    if (hit) return hit;
    return fetch(req).then(res => {
      if (res && res.ok && new URL(req.url).origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 1) HTML（ナビゲーション）は常に最新を優先。オフライン時のみキャッシュへ。
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, './index.html'));
    return;
  }

  // 2) 当せん結果データも最新優先。オフラインでは前回取得分を返す。
  if (url.origin === self.location.origin && url.pathname.indexOf('/data/') !== -1) {
    e.respondWith(networkFirst(req, null));
    return;
  }

  // 3) それ以外（アイコン・manifest・フォント等）はキャッシュ優先。
  //    ※ 失敗しても index.html を返さない。CSSや画像の要求にHTMLを返すのは誤りのため。
  e.respondWith(cacheFirst(req).catch(() => Response.error()));
});
