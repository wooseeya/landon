// 랜드온 중개비서 서비스 워커 — 인터넷이 끊기거나 서버가 잠깐 장애여도 앱이 열리도록 파일을 폰에 저장(캐시)
//
// 앱 화면(index.html)을 열 때의 규칙
//   ✅ 서버 정상(200)          → 최신 화면을 보여주고, 폰에도 새로 저장
//   🐢 응답이 4초 넘게 느림     → 폰에 저장된 화면을 먼저 보여주고, 서버 응답은 뒤에서 받아 저장
//   ⚠️ 서버 장애(500대 오류 등) → 폰에 저장된 화면으로 계속 사용 (장애 화면을 저장하지 않음)
//   📴 인터넷 끊김             → 폰에 저장된 화면으로 계속 사용
//   🗑️ 파일 삭제됨(404 · 410)   → 앱이 내려간 것으로 보고 폰에 저장된 앱을 지움 → 앱 종료
//
// 앱 파일(index.html)만 고쳐서 올릴 때는 이 파일을 건드릴 필요가 없어요.
// 아이콘·manifest를 바꿨을 때만 아래 버전 숫자를 하나 올려주세요.
const VERSION = 'onda-realty-v3';
const NETWORK_TIMEOUT_MS = 4000;

// 앱 기본 파일 (설치 시 미리 저장)
const APP_SHELL = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/logo-256.png'
];

// 외부 라이브러리 (Tailwind · 아이콘 · 글꼴) — 처음 쓸 때 저장해 두고 오프라인에서도 사용
const CDN_HOSTS = ['cdn.tailwindcss.com', 'unpkg.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(async cache => {
      // 하나라도 실패하면 설치 실패 → 기존 버전이 그대로 유지됨 (반쯤 깨진 상태 방지)
      await cache.addAll(APP_SHELL);
      // 예전 버전에 저장해 둔 외부 라이브러리는 새 저장소로 옮겨서 오프라인 사용이 끊기지 않게
      for (const key of await caches.keys()) {
        if (key === VERSION) continue;
        const old = await caches.open(key);
        for (const req of await old.keys()) {
          if (CDN_HOSTS.includes(new URL(req.url).hostname)) {
            const res = await old.match(req);
            if (res) await cache.put(req, res);
          }
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 앱이 내려갔을 때(404/410): 저장된 앱을 지우고 서비스 워커도 해제
async function retireApp() {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  await self.registration.unregister();
}

// 1) 앱 화면 요청
async function handleNavigation(event) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match('./index.html');

  // 페이지 이동 요청은 옵션을 붙여 다시 보낼 수 없어서 주소로 새 요청을 만듦 (no-store: 항상 서버에 최신 확인)
  const network = fetch(new Request(event.request.url, { cache: 'no-store', credentials: 'same-origin', redirect: 'follow' }))
    .then(async res => {
      if (res.redirected) {
        return { kind: 'ok', res: Response.redirect(res.url, 302) }; // 주소가 바뀐 경우 그대로 이동
      }
      if (res.ok && res.type === 'basic') {
        await cache.put('./index.html', res.clone());   // 정상 화면만 저장
        return { kind: 'ok', res };
      }
      if (res.status === 404 || res.status === 410) {
        await retireApp();                               // 파일이 지워짐 → 앱 종료
        return { kind: 'gone', res };
      }
      return { kind: 'error', res };                     // 500대 등 일시 장애 → 저장하지 않음
    })
    .catch(() => ({ kind: 'offline', res: null }));      // 인터넷 끊김

  // 느린 응답: 저장된 화면이 있으면 4초 뒤 그것부터 보여주고, 서버 응답은 뒤에서 계속 받아 저장
  const timeout = new Promise(resolve => setTimeout(() => resolve({ kind: 'timeout' }), NETWORK_TIMEOUT_MS));
  const first = cached ? await Promise.race([network, timeout]) : await network;

  if (first.kind === 'timeout') {
    event.waitUntil(network);
    return cached;
  }
  if (first.kind === 'ok' || first.kind === 'gone') return first.res;
  // 장애 · 오프라인: 저장된 화면으로 계속 사용 (저장본이 없으면 서버 응답이라도 표시)
  if (cached) return cached;
  return first.res || new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<body style="font-family:sans-serif;padding:32px;text-align:center;background:#F3F8FE;color:#172236">' +
    '<h2>인터넷 연결을 확인해주세요</h2><p style="color:#56677E">처음 한 번은 인터넷이 연결된 상태에서 열어야 해요.</p></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// 2) 아이콘 · 외부 라이브러리: 저장된 것 먼저 쓰고, 뒤에서 최신으로 갱신 (정상 응답만 저장)
async function handleAsset(event) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(event.request);
  const network = fetch(event.request)
    .then(async res => {
      if (res && (res.ok || res.type === 'opaque')) await cache.put(event.request, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const res = await network;
  return res || new Response('', { status: 504 });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname)) {
    // sw.js 자신은 브라우저가 직접 확인하므로 캐시하지 않음
    if (url.origin === self.location.origin && url.pathname.endsWith('/sw.js')) return;
    event.respondWith(handleAsset(event));
  }
  // 그 외(네이버부동산 등 외부 링크)는 그대로 인터넷으로
});
