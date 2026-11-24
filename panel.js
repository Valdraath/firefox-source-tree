'use strict';

const $ = s => document.querySelector(s);

const resources = new Map(); // url -> { url, kind, mime, size, har }
const openState = new Map(); // tree node id -> open?
let nodeIndex = new Map();   // tree node id -> node (rebuilt every render)
let treeRoot = null;         // last rendered tree
let visibleList = [];        // resources passing the current filter
const checked = new Set();   // URLs ticked for bulk download
const downloaded = new Set(); // URLs whose download completed
let lastCheckedUrl = null;   // anchor for shift-click ranges
const tabs = [];             // URLs open as preview tabs, in tab order
let selectedUrl = null;      // active tab
let renderTimer = null;
let previewToken = 0;
let blobUrl = null;

// Runs inside the inspected page. Resource Timing covers everything the page
// fetched (even before DevTools opened); the DOM scan catches lazy-load URLs.
const COLLECT = `(() => {
  const out = new Set();
  const add = u => { try { if (u) out.add(new URL(u, location.href).href); } catch (e) {} };
  try { performance.setResourceTimingBufferSize(100000); } catch (e) {}
  add(location.href);
  performance.getEntriesByType('resource').forEach(e => add(e.name));
  document.querySelectorAll('img').forEach(i => { add(i.currentSrc || i.src); add(i.dataset.src); });
  document.querySelectorAll('video, audio, source, track').forEach(m => { add(m.currentSrc); add(m.src); add(m.poster); });
  document.querySelectorAll('script[src]').forEach(s => add(s.src));
  document.querySelectorAll('link[rel~="stylesheet"], link[rel~="icon"], link[rel="preload"], link[rel="modulepreload"]')
    .forEach(l => add(l.href));
  return [...out];
})()`;

function kindOf(url, mime = '') {
  let ext = '';
  try { ext = new URL(url).pathname.split('.').pop().toLowerCase(); } catch (e) {}
  if (mime.startsWith('image/') || /^(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(ext)) return 'image';
  if (mime.startsWith('video/') || /^(mp4|webm|ogv|mov|m4v)$/.test(ext)) return 'video';
  if (mime.startsWith('audio/') || /^(mp3|ogg|oga|wav|m4a|aac|flac|opus)$/.test(ext)) return 'audio';
  if (/javascript|ecmascript/.test(mime) || /^m?js$/.test(ext)) return 'script';
  if (mime === 'text/css' || ext === 'css') return 'style';
  if (mime.includes('font') || /^(woff2?|ttf|otf|eot)$/.test(ext)) return 'font';
  if (mime.includes('html') || /^html?$/.test(ext)) return 'document';
  if (/json|xml|text/.test(mime) || /^(json|xml|txt|map)$/.test(ext)) return 'text';
  return 'other';
}

function addResource(url, mime, har) {
  if (!/^https?:/i.test(url)) return;
  mime = (mime || '').split(';')[0].trim().toLowerCase();
  let r = resources.get(url);
  let changed = false;
  if (!r) { r = { url }; resources.set(url, r); changed = true; }
  if (mime && r.mime !== mime) { r.mime = mime; changed = true; }
  if (har) {
    r.har = har;
    if (har.response.content.size > 0) r.size = har.response.content.size;
    changed = true;
  }
  r.kind = kindOf(url, r.mime);
  if (changed) scheduleRender();
}

async function collect() {
  try {
    const [urls, err] = await browser.devtools.inspectedWindow.eval(COLLECT);
    if (err) throw new Error(err.value || err.description || 'eval failed');
    (urls || []).forEach(u => addResource(u));
  } catch (e) {
    console.warn('Could not scan page:', e);
  }
  try {
    const har = await browser.devtools.network.getHAR();
    for (const e of har.entries || []) addResource(e.request.url, e.response.content.mimeType);
  } catch (e) {}
}

// ---------- tree ----------

function decode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

function fileName(url) {
  const u = new URL(url);
  return decode(u.pathname.split('/').pop() || '(index)') + u.search;
}

function buildTree(list) {
  const root = { id: '', children: new Map() };
  nodeIndex = new Map();
  const child = (parent, name, type) => {
    let n = parent.children.get(name);
    if (!n) {
      n = { id: parent.id + '/' + name, name, type, children: new Map() };
      parent.children.set(name, n);
      nodeIndex.set(n.id, n);
    }
    return n;
  };
  for (const r of list) {
    const u = new URL(r.url);
    const segs = u.pathname.split('/').slice(1, -1);
    let node = child(root, u.host, 'host');
    for (const s of segs) node = child(node, decode(s), 'folder');
    node.children.set('\0' + r.url, { name: fileName(r.url), res: r });
  }
  return root;
}

function sortedChildren(node) {
  return [...node.children.values()].sort((a, b) =>
    (!!a.res - !!b.res) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function renderNode(node, depth) {
  if (node.res) {
    const el = document.createElement('div');
    el.className = 'file k-' + node.res.kind + (node.res.url === selectedUrl ? ' selected' : '');
    el.title = node.res.url;
    el.dataset.url = node.res.url;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'check';
    cb.checked = checked.has(node.res.url);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = node.name;
    el.append(cb, name);
    return el;
  }
  // Collapse single-folder chains like Chrome does ("uploads/2024/05").
  let label = node.name;
  while (node.type === 'folder' && node.children.size === 1) {
    const only = node.children.values().next().value;
    if (only.res) break;
    node = only;
    label += '/' + only.name;
  }
  const d = document.createElement('details');
  d.dataset.id = node.id;
  d.open = openState.has(node.id) ? openState.get(node.id) : depth === 0;
  const s = document.createElement('summary');
  s.className = node.type;
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'check';
  cb.dataset.id = node.id;
  cb.title = 'Check every file in this folder';
  const span = document.createElement('span');
  span.textContent = label;
  s.append(cb, span);
  const box = document.createElement('div');
  box.className = 'children';
  for (const c of sortedChildren(node)) box.append(renderNode(c, depth + 1));
  d.append(s, box);
  return d;
}

function render() {
  renderTimer = null;
  const q = $('#filter').value.toLowerCase();
  const kind = $('#kind').value;
  const list = [...resources.values()].filter(r =>
    (kind === 'all' || r.kind === kind) && (!q || r.url.toLowerCase().includes(q)));
  visibleList = list;
  treeRoot = buildTree(list);
  const scroll = $('#tree').scrollTop;
  const frag = document.createDocumentFragment();
  for (const n of sortedChildren(treeRoot)) frag.append(renderNode(n, 0));
  $('#tree').replaceChildren(frag);
  $('#tree').scrollTop = scroll;
  $('#count').textContent = `${list.length} / ${resources.size}`;
  $('#count').title = `${list.length} shown of ${resources.size} files`;
  syncChecks();
}

function scheduleRender() {
  if (!renderTimer) renderTimer = setTimeout(render, 150);
}

function filesUnder(node, out = []) {
  for (const c of node.children.values()) {
    if (c.res) out.push(c.res);
    else filesUnder(c, out);
  }
  return out;
}

// ---------- checkboxes ----------

// One pass over the tree: folder id -> { n: checked, total }.
function countTree(node, out) {
  const c = { n: 0, total: 0 };
  for (const ch of node.children.values()) {
    if (ch.res) {
      c.total++;
      if (checked.has(ch.res.url)) c.n++;
    } else {
      const sub = countTree(ch, out);
      c.n += sub.n; c.total += sub.total;
    }
  }
  if (node.id) out.set(node.id, c);
  return c;
}

function syncChecks() {
  const counts = new Map();
  if (treeRoot) countTree(treeRoot, counts);
  for (const cb of $('#tree').querySelectorAll('.check')) {
    if (cb.dataset.id) {
      const c = counts.get(cb.dataset.id) || { n: 0, total: 0 };
      cb.checked = c.total > 0 && c.n === c.total;
      cb.indeterminate = c.n > 0 && c.n < c.total;
    } else {
      cb.checked = checked.has(cb.parentElement.dataset.url);
    }
  }
  // The Download buttons show a ✓ once their file(s) finished downloading.
  const btn = $('#download-selected');
  btn.title = `Download ${checked.size} checked file(s)`;
  btn.disabled = checked.size === 0 || btn.classList.contains('busy');
  const allDone = checked.size > 0 && [...checked].every(u => downloaded.has(u));
  btn.textContent = allDone ? 'Download ✓' : 'Download';
  $('#download').textContent = selectedUrl && downloaded.has(selectedUrl) ? 'Download ✓' : 'Download';
}

function onCheck(cb, shiftKey) {
  const on = cb.checked;
  let urls;
  if (cb.dataset.id) {
    urls = filesUnder(nodeIndex.get(cb.dataset.id)).map(r => r.url);
  } else {
    const url = cb.parentElement.dataset.url;
    urls = [url];
    if (shiftKey && lastCheckedUrl) {
      const rows = [...document.querySelectorAll('.file')].filter(el => el.offsetParent);
      const a = rows.findIndex(el => el.dataset.url === lastCheckedUrl);
      const b = rows.findIndex(el => el.dataset.url === url);
      if (a !== -1 && b !== -1) {
        urls = rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(el => el.dataset.url);
      }
    }
    lastCheckedUrl = url;
  }
  for (const u of urls) on ? checked.add(u) : checked.delete(u);
  syncChecks();
}

// ---------- tabs ----------

// Open url in a tab (or switch to it if already open). With replace, reuse the
// active tab instead of adding one — used when stepping with ↑/↓.
function openTab(url, replace = false) {
  if (!tabs.includes(url)) {
    const i = tabs.indexOf(selectedUrl);
    if (replace && i !== -1) tabs[i] = url;
    else tabs.push(url);
  }
  activate(url);
}

function closeTab(url) {
  const i = tabs.indexOf(url);
  if (i === -1) return;
  tabs.splice(i, 1);
  if (url === selectedUrl) activate(tabs[i] || tabs[i - 1] || null);
  else renderTabs();
}

// Close every tab for which keep() is false; stay on the active tab if it
// survives, otherwise switch to fallback (or the last remaining tab).
function closeTabsExcept(keep, fallback) {
  const remaining = tabs.filter(keep);
  tabs.splice(0, tabs.length, ...remaining);
  if (tabs.includes(selectedUrl)) renderTabs();
  else activate(tabs.includes(fallback) ? fallback : tabs[tabs.length - 1] || null);
}

function showTabMenu(x, y, url) {
  const items = [
    { label: 'Close', run: () => closeTab(url) },
    { label: 'Close others', run: () => closeTabsExcept(u => u === url, url), disabled: tabs.length < 2 },
    { label: 'Close all', run: () => closeTabsExcept(() => false) },
  ];
  const menu = $('#menu');
  menu.replaceChildren(...items.map(it => {
    const el = document.createElement('div');
    el.className = 'item' + (it.disabled ? ' disabled' : '');
    el.textContent = it.label;
    el.addEventListener('click', () => { hideMenu(); it.run(); });
    return el;
  }));
  menu.hidden = false;
  // Keep the menu inside the panel.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - width - 4) + 'px';
  menu.style.top = Math.min(y, innerHeight - height - 4) + 'px';
}

function hideMenu() { $('#menu').hidden = true; }

function activate(url) {
  selectedUrl = url;
  let target = null;
  for (const el of document.querySelectorAll('.file')) {
    const on = el.dataset.url === url;
    el.classList.toggle('selected', on);
    if (on) target = el;
  }
  target?.scrollIntoView({ block: 'nearest' });
  renderTabs();
  const r = url && resources.get(url);
  if (r) showPreview(r);
  else showEmpty();
  syncChecks();
}

function renderTabs() {
  $('#tabs').hidden = tabs.length === 0;
  const frag = document.createDocumentFragment();
  for (const url of tabs) {
    const r = resources.get(url);
    const tab = document.createElement('div');
    tab.className = 'tab k-' + (r ? r.kind : kindOf(url)) + (url === selectedUrl ? ' active' : '');
    tab.dataset.url = url;
    tab.title = fileName(url) + '\n' + url;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = fileName(url);
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close';
    tab.append(name, close);
    frag.append(tab);
  }
  $('#tabs').replaceChildren(frag);
  $('#tabs .active')?.scrollIntoView({ block: 'nearest' });
}

// ---------- preview ----------

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' kB';
  return (n / 1048576).toFixed(2) + ' MB';
}

// Body captured by the Network monitor, if this request was seen while DevTools was open.
async function harBody(r) {
  if (!r.har || typeof r.har.getContent !== 'function') return null;
  try {
    const res = await r.har.getContent();
    const [content, second] = Array.isArray(res) ? res : [res];
    if (!content) return null;
    const base64 = second === 'base64' || r.har.response.content.encoding === 'base64';
    return { content, base64 };
  } catch (e) {
    return null;
  }
}

async function imageSrc(r) {
  const body = await harBody(r);
  if (!body) return r.url;
  if (body.base64) return `data:${r.mime || 'image/*'};base64,${body.content}`;
  if (r.mime === 'image/svg+xml') {
    blobUrl = URL.createObjectURL(new Blob([body.content], { type: r.mime }));
    return blobUrl;
  }
  return r.url;
}

async function textOf(r) {
  const body = await harBody(r);
  if (body && !body.base64) return body.content;
  if (body && body.base64) return atob(body.content);
  return browser.runtime.sendMessage({ cmd: 'fetchText', url: r.url });
}

function showEmpty() {
  ++previewToken;
  $('#preview-bar').hidden = true;
  $('#preview-body').replaceChildren(hint('Select a file to preview.'));
}

async function showPreview(r) {
  const token = ++previewToken;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  const body = $('#preview-body');
  $('#preview-bar').hidden = false;
  $('#preview-url').textContent = r.url;
  $('#preview-url').href = r.url;
  const info = [r.mime, r.size && fmtSize(r.size)].filter(Boolean);
  $('#preview-info').textContent = info.join(' · ');

  if (r.kind === 'image') {
    const img = new Image();
    img.onload = () => {
      if (token !== previewToken) return;
      $('#preview-info').textContent = [...info, `${img.naturalWidth} × ${img.naturalHeight}`].join(' · ');
    };
    img.onerror = () => { if (img.src !== r.url) img.src = r.url; };
    img.onclick = () => img.classList.toggle('actual');
    const src = await imageSrc(r);
    if (token !== previewToken) return;
    img.src = src;
    body.replaceChildren(img);
  } else if (r.kind === 'video' || r.kind === 'audio') {
    const m = document.createElement(r.kind);
    m.controls = true;
    m.src = r.url;
    body.replaceChildren(m);
  } else if (r.kind === 'font') {
    body.replaceChildren(hint('No preview for fonts.'));
  } else {
    body.replaceChildren(hint('Loading…'));
    let text;
    try {
      text = await textOf(r);
    } catch (e) {
      text = 'Could not load: ' + e.message;
    }
    if (token !== previewToken) return;
    const pre = document.createElement('pre');
    const LIMIT = 2_000_000;
    pre.textContent = text.length > LIMIT ? text.slice(0, LIMIT) + '\n\n… (truncated)' : text;
    body.replaceChildren(pre);
  }
}

function hint(msg) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = msg;
  return p;
}

// ---------- downloads ----------

function savePath(url) {
  const u = new URL(url);
  const clean = s => decode(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '') || '_';
  const segs = u.pathname.split('/').filter(Boolean).map(clean);
  if (!segs.length) segs.push('index.html');
  return ['SourceTree', clean(u.host), ...segs].join('/');
}

// Resolves once every download has finished; completed URLs get a ✓.
async function download(list, btn) {
  if (!list.length) return;
  btn?.classList.add('busy');
  if (btn) btn.disabled = true;
  // Pings keep the (non-persistent) background page awake during long downloads.
  const keepAlive = setInterval(() => browser.runtime.sendMessage({ cmd: 'ping' }).catch(() => {}), 10000);
  try {
    const items = list.map(r => ({ url: r.url, filename: savePath(r.url) }));
    const done = await browser.runtime.sendMessage({ cmd: 'download', items });
    for (const u of done || []) downloaded.add(u);
  } catch (e) {
    console.warn('Download failed:', e);
  } finally {
    clearInterval(keepAlive);
    btn?.classList.remove('busy');
    if (btn) btn.disabled = false;
    syncChecks();
  }
}

// ---------- wiring ----------

$('#tree').addEventListener('toggle', e => {
  if (e.target.dataset.id) openState.set(e.target.dataset.id, e.target.open);
}, true);

$('#tree').addEventListener('click', e => {
  if (e.target.classList.contains('check')) {
    onCheck(e.target, e.shiftKey);
    return;
  }
  const file = e.target.closest('.file');
  if (file) openTab(file.dataset.url);
});

$('#tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  if (e.target.closest('.close')) closeTab(tab.dataset.url);
  else activate(tab.dataset.url);
});
// Middle-click closes a tab, like in browsers.
$('#tabs').addEventListener('auxclick', e => {
  const tab = e.target.closest('.tab');
  if (tab && e.button === 1) { e.preventDefault(); closeTab(tab.dataset.url); }
});
$('#tabs').addEventListener('contextmenu', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  e.preventDefault();
  showTabMenu(e.clientX, e.clientY, tab.dataset.url);
});

document.addEventListener('mousedown', e => {
  if (!e.target.closest('#menu')) hideMenu();
});
window.addEventListener('blur', hideMenu);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideMenu(); return; }
  if (e.target.matches('input:not(.check), select')) return;
  if (e.key === ' ') {
    // A focused checkbox/button handles Space natively.
    if (e.target.matches('button, .check') || !selectedUrl || !selectMode) return;
    e.preventDefault();
    const row = [...document.querySelectorAll('.file')].find(el => el.dataset.url === selectedUrl);
    const cb = row?.querySelector('.check');
    if (cb) { cb.checked = !cb.checked; onCheck(cb, e.shiftKey); }
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const visible = [...document.querySelectorAll('.file')].filter(el => el.offsetParent);
  if (!visible.length) return;
  e.preventDefault();
  const i = visible.findIndex(el => el.dataset.url === selectedUrl);
  const next = e.key === 'ArrowDown' ? Math.min(i + 1, visible.length - 1) : Math.max(i - 1, 0);
  openTab(visible[i === -1 ? 0 : next].dataset.url, true);
});

$('#filter').addEventListener('input', scheduleRender);
$('#kind').addEventListener('change', scheduleRender);
$('#refresh').addEventListener('click', () => collect());

// Checkbox mode on/off; remembered per browser profile.
let selectMode = false;
function setSelectMode(on) {
  selectMode = on;
  document.body.classList.toggle('select-mode', on);
  $('#mode').checked = on;
  try { localStorage.setItem('selectMode', on ? '1' : '0'); } catch (e) {}
}
try { setSelectMode(localStorage.getItem('selectMode') === '1'); } catch (e) {}
$('#mode').addEventListener('change', e => setSelectMode(e.target.checked));

$('#select-all').addEventListener('click', () => {
  for (const r of visibleList) checked.add(r.url);
  syncChecks();
});
$('#select-none').addEventListener('click', () => {
  checked.clear();
  syncChecks();
});
$('#download-selected').addEventListener('click', e => {
  download([...checked].map(u => resources.get(u)).filter(Boolean), e.currentTarget);
});

$('#copy-url').addEventListener('click', async e => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(selectedUrl);
  } catch (err) {
    const ta = document.createElement('textarea');
    ta.value = selectedUrl;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy URL'; }, 1000);
});

$('#download').addEventListener('click', e => {
  const r = resources.get(selectedUrl);
  if (r) download([r], e.currentTarget);
});

browser.devtools.network.onRequestFinished.addListener(req => {
  addResource(req.request.url, req.response.content.mimeType, req);
});

browser.devtools.network.onNavigated.addListener(() => {
  resources.clear();
  checked.clear();
  lastCheckedUrl = null;
  tabs.length = 0;
  activate(null);
  scheduleRender();
  setTimeout(collect, 1000);
});

function applyTheme(name) { document.body.classList.toggle('dark', name === 'dark'); }
applyTheme(browser.devtools.panels.themeName);
browser.devtools.panels.onThemeChanged?.addListener(applyTheme);

collect();
// Pick up lazy-loaded images as the page scrolls.
setInterval(collect, 3000);
