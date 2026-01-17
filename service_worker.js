// service_worker.js (MV3)

const DEFAULT_SETTINGS = {
  captureTypes: ["xmlhttprequest", "fetch"],

  // Normalización: quita query string para reducir ruido.
  includeQueryString: false,

  // Heurística "solo APIs": patterns típicos.
  // Puedes ajustar/agregar regex strings.
  apiIncludePatterns: [
    "/api(?:/|$)",
    "/apis(?:/|$)",
    "/graphql(?:/|$)",
    "/gql(?:/|$)",
    "/rest(?:/|$)",
    "/v\\d+(?:/|$)",
    "/rpc(?:/|$)",
    "/services?(?:/|$)"
  ],

  // Excluir recursos típicos NO-API aunque sean fetch/xhr en algunos sitios.
  // (opcional, ayuda a ruido)
  apiExcludePatterns: [
    "\\.js(?:\\?|$)",
    "\\.css(?:\\?|$)",
    "\\.png(?:\\?|$)",
    "\\.jpg(?:\\?|$)",
    "\\.jpeg(?:\\?|$)",
    "\\.gif(?:\\?|$)",
    "\\.svg(?:\\?|$)",
    "\\.webp(?:\\?|$)",
    "\\.ico(?:\\?|$)",
    "\\.woff2?(?:\\?|$)",
    "\\.ttf(?:\\?|$)",
    "\\.map(?:\\?|$)"
  ],

  maxPerTab: 2000
};

// requestId -> meta (solo en memoria; suficiente para correlacionar headers/completed)
const requestCache = new Map();

function safeRegexList(patterns) {
  const out = [];
  for (const p of patterns || []) {
    try { out.push(new RegExp(p, "i")); } catch {}
  }
  return out;
}

function normalizeUrl(rawUrl, includeQueryString) {
  try {
    const u = new URL(rawUrl);
    return includeQueryString
      ? `${u.origin}${u.pathname}${u.search}`
      : `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

function isApiUrl(url, settings) {
  const inc = safeRegexList(settings.apiIncludePatterns);
  const exc = safeRegexList(settings.apiExcludePatterns);

  const target = url || "";
  const included = inc.length ? inc.some(r => r.test(target)) : true;
  const excluded = exc.length ? exc.some(r => r.test(target)) : false;

  return included && !excluded;
}

async function getTabData(tabId) {
  const key = `tab:${tabId}`;
  const obj = await chrome.storage.session.get([key]);
  return obj[key] || { items: {}, order: [] };
}

async function setTabData(tabId, data) {
  const key = `tab:${tabId}`;
  await chrome.storage.session.set({ [key]: data });
}

function getHeaderValue(headers, name) {
  if (!headers || !Array.isArray(headers)) return null;
  const h = headers.find(x => (x.name || "").toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function toIntOrNull(v) {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function makeKey(method, endpoint) {
  return `${method} ${endpoint}`;
}

async function upsertApiCall(tabId, method, endpoint, statusCode, sizeBytes) {
  if (tabId < 0) return;

  const settings = await getSettings();
  const data = await getTabData(tabId);

  const key = makeKey(method, endpoint);
  const now = Date.now();

  if (!data.items[key]) {
    data.items[key] = {
      key,
      method,
      endpoint,
      count: 0,
      firstSeen: now,
      lastSeen: now,
      lastStatus: null,
      statusCounts: {},     // { "200": 3, "404": 1 }
      sizeKnownCount: 0,
      sizeSum: 0,           // para promedio (solo si Content-Length existe)
      lastSize: null
    };
    data.order.unshift(key);
  }

  const it = data.items[key];
  it.count += 1;
  it.lastSeen = now;

  if (statusCode != null) {
    it.lastStatus = statusCode;
    const s = String(statusCode);
    it.statusCounts[s] = (it.statusCounts[s] || 0) + 1;
  }

  if (sizeBytes != null) {
    it.lastSize = sizeBytes;
    it.sizeKnownCount += 1;
    it.sizeSum += sizeBytes;
  }

  // Enforce límite de items por tab
  if (data.order.length > settings.maxPerTab) {
    const removed = data.order.splice(settings.maxPerTab);
    for (const rk of removed) delete data.items[rk];
  }

  await setTabData(tabId, data);
}

// 1) onBeforeRequest: decide si es API y guarda meta básica
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const settings = await getSettings();

    if (!settings.captureTypes.includes(details.type)) return;

    const endpoint = normalizeUrl(details.url, settings.includeQueryString);
    if (!isApiUrl(endpoint, settings)) return;

    requestCache.set(details.requestId, {
      tabId: details.tabId,
      method: details.method || "GET",
      endpoint,
      sizeBytes: null
    });
  },
  { urls: ["<all_urls>"] }
);

// 2) onHeadersReceived: intenta obtener Content-Length
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const meta = requestCache.get(details.requestId);
    if (!meta) return;

    const cl = getHeaderValue(details.responseHeaders, "content-length");
    const size = toIntOrNull(cl);
    if (size != null) meta.sizeBytes = size;

    requestCache.set(details.requestId, meta);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// 3) onCompleted: status code + commit al storage
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const meta = requestCache.get(details.requestId);
    if (!meta) return;

    await upsertApiCall(
      meta.tabId,
      meta.method,
      meta.endpoint,
      details.statusCode ?? null,
      meta.sizeBytes
    );

    requestCache.delete(details.requestId);
  },
  { urls: ["<all_urls>"] }
);

// 4) onErrorOccurred: también registra (status = "ERR")
chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    const meta = requestCache.get(details.requestId);
    if (!meta) return;

    await upsertApiCall(
      meta.tabId,
      meta.method,
      meta.endpoint,
      "ERR",
      meta.sizeBytes
    );

    requestCache.delete(details.requestId);
  },
  { urls: ["<all_urls>"] }
);

// Limpia al cerrar tab
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove([`tab:${tabId}`]);
});
