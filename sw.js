const CACHE_NAME = "myrewards-v17";

const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./chart.js",
  "./assets/css/style.css",
  "./assets/images/rewards-points.png",
  "./assets/images/icon.png",
];

const OFFLINE_HTML_FALLBACK = "./index.html";

function isHttpRequest(request) {
  return request.url.startsWith("http://") || request.url.startsWith("https://");
}

function canCacheResponse(response) {
  return !!response && (response.ok || response.type === "opaque");
}

function shouldBypassRequest(request) {
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;

  // Do not intercept live auth/database API calls.
  return url.hostname === "identitytoolkit.googleapis.com" ||
    (url.hostname === "firestore.googleapis.com" && url.pathname.includes("/Listen/channel"));
}

async function safeCachePut(request, response) {
  if (!isHttpRequest(request) || !canCacheResponse(response)) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const asset of ASSETS) {
      try {
        // "no-cache" bypasses the HTTP cache (revalidates with the server) so
        // the precache never captures a stale browser-cached copy.
        await cache.add(new Request(asset, { cache: "no-cache" }));
      } catch (err) {
        console.warn("Cache install skipped asset", asset, err);
      }
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET" || !isHttpRequest(request) || shouldBypassRequest(request)) {
    return;
  }

  const acceptHeader = request.headers.get("accept") || "";
  const isHtmlRequest = request.mode === "navigate" || acceptHeader.includes("text/html");

  event.respondWith((async () => {
    if (isHtmlRequest) {
      try {
        const networkRes = await fetch(request);
        await safeCachePut(request, networkRes);
        return networkRes;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;

        const offlinePage = await caches.match(OFFLINE_HTML_FALLBACK);
        if (offlinePage) return offlinePage;

        return new Response("Offline", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "Content-Type": "text/plain" },
        });
      }
    }
    
    // Static assets: stale-while-revalidate — serve cache instantly, refresh the
    // cache in the background so the NEXT load gets updated CSS/JS without a
    // manual CACHE_NAME bump.
    const cached = await caches.match(request);
    // Revalidate against the server (not the HTTP cache) so background
    // updates actually pick up new deploys.
    const networkUpdate = fetch(request, { cache: "no-cache" })
      .then(async (networkRes) => {
        await safeCachePut(request, networkRes);
        return networkRes;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(networkUpdate);
      return cached;
    }

    const networkRes = await networkUpdate;
    if (networkRes) return networkRes;
    return Response.error();
  })());
});
