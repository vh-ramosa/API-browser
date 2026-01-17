// popup.js

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString();
}

function fmtBytes(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let x = n;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x = x / 1024;
    i++;
  }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(["settings"]);
  return stored.settings || {};
}

async function setSettings(settings) {
  await chrome.storage.local.set({ settings });
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

function buildGroups(itemsArray, filterText) {
  const f = (filterText || "").trim().toLowerCase();
  const filtered = f
    ? itemsArray.filter(x =>
        (x.endpoint || "").toLowerCase().includes(f) ||
        (x.method || "").toLowerCase().includes(f) ||
        (x.key || "").toLowerCase().includes(f)
      )
    : itemsArray;

  // group by method
  const groups = {};
  for (const it of filtered) {
    const m = it.method || "GET";
    if (!groups[m]) groups[m] = [];
    groups[m].push(it);
  }

  // Sort methods: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD, others
  const order = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
  const methods = Object.keys(groups).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  // Sort items inside group by lastSeen desc
  for (const m of methods) {
    groups[m].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }

  return { groups, methods, total: itemsArray.length, shown: filtered.length };
}

function render(groupsObj, methods, tabId, total, shown) {
  const container = document.getElementById("groups");
  container.innerHTML = "";

  for (const method of methods) {
    const items = groupsObj[method] || [];

    const group = document.createElement("div");
    group.className = "group";

    const header = document.createElement("div");
    header.className = "groupHeader";
    header.textContent = `${method} — ${items.length}`;

    const body = document.createElement("div");
    body.className = "groupBody";

    for (const it of items) {
      const card = document.createElement("div");
      card.className = "item";

      const ep = document.createElement("div");
      ep.className = "endpoint";
      ep.textContent = it.endpoint;

      const sub = document.createElement("div");
      sub.className = "sub";

      const avgSize = it.sizeKnownCount > 0 ? Math.round(it.sizeSum / it.sizeKnownCount) : null;

      const statusTop = it.lastStatus != null ? `status(last)=${it.lastStatus}` : "status(last)=—";
      const lastSize = `size(last)=${fmtBytes(it.lastSize)}`;
      const avg = `size(avg)=${fmtBytes(avgSize)}`;
      const counts = `count=${it.count}`;
      const lastSeen = `last=${fmtTime(it.lastSeen)}`;

      // Compact status distribution (top few)
      const sc = it.statusCounts || {};
      const dist = Object.entries(sc)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      const distTxt = dist ? `status={${dist}}` : "";

      for (const txt of [counts, statusTop, distTxt, lastSize, avg, lastSeen].filter(Boolean)) {
        const span = document.createElement("span");
        span.textContent = txt;
        sub.appendChild(span);
      }

      card.appendChild(ep);
      card.appendChild(sub);
      body.appendChild(card);
    }

    group.appendChild(header);
    group.appendChild(body);
    container.appendChild(group);
  }

  document.getElementById("meta").textContent = `Tab ${tabId} | items: ${shown}/${total}`;
}

async function refresh() {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  const data = await getTabData(tabId);

  // data.order mantiene keys en orden; convertimos a array
  const itemsArray = data.order.map(k => data.items[k]).filter(Boolean);

  const filter = document.getElementById("search").value;
  const { groups, methods, total, shown } = buildGroups(itemsArray, filter);

  render(groups, methods, tabId, total, shown);
}

async function clearTab() {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  await setTabData(tabId, { items: {}, order: [] });
  await refresh();
}

async function copyToClipboard() {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  const data = await getTabData(tabId);
  const itemsArray = data.order.map(k => data.items[k]).filter(Boolean);

  const filter = document.getElementById("search").value.trim().toLowerCase();
  const filtered = filter
    ? itemsArray.filter(x =>
        (x.endpoint || "").toLowerCase().includes(filter) ||
        (x.method || "").toLowerCase().includes(filter)
      )
    : itemsArray;

  // salida agrupada por método
  const byMethod = {};
  for (const it of filtered) {
    const m = it.method || "GET";
    if (!byMethod[m]) byMethod[m] = [];
    byMethod[m].push(it);
  }

  const lines = [];
  for (const m of Object.keys(byMethod).sort()) {
    lines.push(`## ${m}`);
    for (const it of byMethod[m]) {
      lines.push(`${m} ${it.endpoint}  (lastStatus=${it.lastStatus ?? "—"}, lastSize=${it.lastSize ?? "—"}, count=${it.count})`);
    }
    lines.push("");
  }

  await navigator.clipboard.writeText(lines.join("\n"));
}

async function exportJson() {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  const data = await getTabData(tabId);
  const itemsArray = data.order.map(k => data.items[k]).filter(Boolean);

  const blob = new Blob([JSON.stringify(itemsArray, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `api-endpoints-tab-${tabId}.json`;
  a.click();

  URL.revokeObjectURL(url);
}

(async function init() {
  // settings UI (include query string)
  const settings = await getSettings();
  const includeQS = !!settings.includeQueryString;

  const cb = document.getElementById("includeQS");
  cb.checked = includeQS;

  cb.addEventListener("change", async () => {
    const current = await getSettings();
    await setSettings({ ...current, includeQueryString: cb.checked });
  });

  document.getElementById("refresh").addEventListener("click", refresh);
  document.getElementById("clear").addEventListener("click", clearTab);
  document.getElementById("copy").addEventListener("click", copyToClipboard);
  document.getElementById("export").addEventListener("click", exportJson);
  document.getElementById("search").addEventListener("input", refresh);

  await refresh();
})();
