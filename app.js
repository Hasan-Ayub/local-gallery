(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const DB_NAME = 'my-local-gallery';
  const DB_VERSION = 1;
  const MAX_FOLDER_FILES = 10000;

  let db = null;
  let imported = [];
  let folderItems = [];
  let folderHandle = null;
  let visibleItems = [];
  let filter = 'all';
  let sort = 'newest';
  let query = '';
  let lightboxIndex = -1;
  const urlCache = new Map();

  /* ---------- IndexedDB helpers ---------- */

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('media')) {
          const store = d.createObjectStore('media', { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
          store.createIndex('type', 'type');
        }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let result;
      try { result = fn(store); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    });
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function loadImported() {
    return await tx('media', 'readonly', (store) => reqToPromise(store.getAll()));
  }

  async function saveImported(records) {
    return await tx('media', 'readwrite', (store) => {
      records.forEach((r) => store.put(r));
      return records.length;
    });
  }

  async function removeImported(id) {
    return await tx('media', 'readwrite', (store) => store.delete(id));
  }

  async function clearImported() {
    return await tx('media', 'readwrite', (store) => store.clear());
  }

  async function saveHandle(handle) {
    return await tx('meta', 'readwrite', (store) => store.put({ key: 'folderHandle', handle }));
  }

  async function loadHandle() {
    try {
      const value = await tx('meta', 'readonly', (store) => reqToPromise(store.get('folderHandle')));
      return value ? value.handle : null;
    } catch (e) { return null; }
  }

  async function clearHandle() {
    return await tx('meta', 'readwrite', (store) => store.delete('folderHandle'));
  }

  /* ---------- Utilities ---------- */

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function detectType(name, file) {
    const mime = (file && file.type) || '';
    if (mime.startsWith('image/')) return 'photo';
    if (mime.startsWith('video/')) return 'video';
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'svg'].includes(ext)) return 'photo';
    if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mpeg', 'mpg'].includes(ext)) return 'video';
    return null;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return (i === 0 ? bytes : bytes.toFixed(1)) + ' ' + units[i];
  }

  function formatDate(ts) {
    try { return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return ''; }
  }

  async function objectURL(item) {
    if (urlCache.has(item.id)) return urlCache.get(item.id);
    let blob = item.blob;
    if (!blob && item.handle) blob = await item.handle.getFile();
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    urlCache.set(item.id, url);
    return url;
  }

  function revokeURL(id) {
    const url = urlCache.get(id);
    if (url) { URL.revokeObjectURL(url); urlCache.delete(id); }
  }

  /* ---------- Media import ---------- */

  async function addFiles(fileList) {
    const records = [];
    for (const file of Array.from(fileList)) {
      const type = detectType(file.name, file);
      if (!type) continue;
      records.push({
        id: uid(),
        name: file.name,
        type,
        blob: file,
        size: file.size,
        createdAt: file.lastModified || Date.now()
      });
    }
    if (!records.length) { toast('No photos or videos found'); return; }
    try {
      await saveImported(records);
      imported.push(...records);
      await render();
      toast(`Added ${records.length} item${records.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast('Storage full — try removing some items');
    }
  }

  async function scanFolder() {
    const out = [];
    async function walk(handle, path) {
      if (out.length >= MAX_FOLDER_FILES) return;
      for await (const [name, entry] of handle.entries()) {
        if (out.length >= MAX_FOLDER_FILES) break;
        if (entry.kind === 'file') {
          const type = detectType(name);
          if (type) {
            const file = await entry.getFile();
            out.push({
              id: 'folder:' + path + name,
              name,
              type,
              blob: file,
              size: file.size,
              createdAt: file.lastModified || Date.now(),
              folder: true
            });
          }
        } else if (entry.kind === 'directory') {
          await walk(entry, path + name + '/');
        }
      }
    }
    await walk(folderHandle, '');
    folderItems = out;
    $('folderStatus').textContent = out.length
      ? `Folder linked • reading ${out.length} file${out.length === 1 ? '' : 's'} directly (files are not copied)`
      : 'Folder linked but no photos or videos were found';
    $('folderStatus').classList.remove('hidden');
    await render();
  }

  async function chooseFolder() {
    if (!('showDirectoryPicker' in window)) { toast('Folder mode needs Chrome or Edge on a computer'); return; }
    try {
      const handle = await window.showDirectoryPicker({ id: 'my-local-gallery-folder', mode: 'read' });
      const permission = await handle.queryPermission({ mode: 'read' });
      if (permission !== 'granted') {
        const requested = await handle.requestPermission({ mode: 'read' });
        if (requested !== 'granted') { toast('Folder permission was not granted'); return; }
      }
      folderHandle = handle;
      await saveHandle(handle);
      $('reconnectBtn').classList.add('hidden');
      toast('Reading folder…');
      await scanFolder();
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Could not read that folder');
    }
  }

  async function restoreFolder() {
    const handle = await loadHandle();
    if (!handle) return;
    try {
      const permission = await handle.queryPermission({ mode: 'read' });
      if (permission === 'granted') {
        folderHandle = handle;
        await scanFolder();
      } else {
        $('reconnectBtn').classList.remove('hidden');
      }
    } catch (e) { /* ignore stale handles */ }
  }

  /* ---------- Rendering ---------- */

  function getVisible() {
    const all = folderItems.concat(imported);
    let result = all.filter((item) => {
      const typeOk = filter === 'all' || item.type === filter;
      const queryOk = !query || item.name.toLowerCase().includes(query);
      return typeOk && queryOk;
    });
    result.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      return sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
    });
    return result;
  }

  async function makeCard(item, index) {
    const card = document.createElement('div');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', 'Open ' + item.name);

    const url = await objectURL(item);
    let media;
    if (item.type === 'video') {
      media = document.createElement('video');
      media.muted = true;
      media.playsInline = true;
      media.preload = 'metadata';
      media.src = url ? url + '#t=0.1' : '';
    } else {
      media = document.createElement('img');
      media.loading = 'lazy';
      media.alt = item.name;
      media.src = url;
    }
    card.appendChild(media);

    if (item.type === 'video') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '▶ VIDEO';
      card.appendChild(badge);
    }
    const caption = document.createElement('div');
    caption.className = 'caption';
    caption.textContent = item.name;
    card.appendChild(caption);

    const open = () => openLightbox(index);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return card;
  }

  async function render() {
    visibleItems = getVisible();
    const count = visibleItems.length;
    $('count').textContent = `${count} item${count === 1 ? '' : 's'}`;
    $('empty').hidden = count !== 0;
    $('grid').hidden = count === 0;
    const cards = await Promise.all(visibleItems.map(makeCard));
    $('grid').replaceChildren(...cards);
    await updateStorage();
  }

  async function updateStorage() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      $('storage').textContent = 'Storage: ' + formatBytes(usage) + ' used';
      $('storage').title = quota ? 'Browser quota: ' + formatBytes(quota) : '';
      $('storageFill').style.width = quota ? Math.min(100, (usage / quota) * 100) + '%' : '0%';
    } catch (e) { /* ignore */ }
  }

  /* ---------- Lightbox ---------- */

  async function openLightbox(index) {
    if (!visibleItems[index]) return;
    lightboxIndex = index;
    $('lightbox').hidden = false;
    document.body.style.overflow = 'hidden';
    await renderLightbox();
  }

  function closeLightbox() {
    $('lightbox').hidden = true;
    $('lbStage').replaceChildren();
    document.body.style.overflow = '';
    lightboxIndex = -1;
  }

  async function renderLightbox() {
    const item = visibleItems[lightboxIndex];
    if (!item) { closeLightbox(); return; }
    const url = await objectURL(item);
    const stage = $('lbStage');
    stage.replaceChildren();

    if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.autoplay = true;
      stage.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.alt = item.name;
      stage.appendChild(img);
    }
    $('lbName').textContent = item.name;
    $('lbMeta').textContent = `${formatDate(item.createdAt)} • ${formatBytes(item.size)}`;
    $('lbDelete').classList.toggle('hidden', !!item.folder);
  }

  function step(delta) {
    if (!visibleItems.length) return;
    lightboxIndex = (lightboxIndex + delta + visibleItems.length) % visibleItems.length;
    renderLightbox();
  }

  async function deleteCurrent() {
    const item = visibleItems[lightboxIndex];
    if (!item || item.folder) { toast('Folder files must be deleted in your file manager'); return; }
    try {
      await removeImported(item.id);
      imported = imported.filter((i) => i.id !== item.id);
      revokeURL(item.id);
      closeLightbox();
      await render();
      toast('Deleted');
    } catch (e) { toast('Could not delete'); }
  }

  function downloadCurrent() {
    const item = visibleItems[lightboxIndex];
    const url = urlCache.get(item.id);
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------- Events ---------- */

  function bindEvents() {
    $('addBtn').addEventListener('click', () => $('fileInput').click());
    $('emptyAdd').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });

    $('folderBtn').addEventListener('click', chooseFolder);
    $('reconnectBtn').addEventListener('click', chooseFolder);

    $('search').addEventListener('input', (e) => {
      query = e.target.value.trim().toLowerCase();
      render();
    });
    $('sort').addEventListener('change', (e) => { sort = e.target.value; render(); });
    document.querySelectorAll('.seg').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        filter = btn.dataset.filter;
        render();
      });
    });

    $('lbClose').addEventListener('click', closeLightbox);
    $('lbPrev').addEventListener('click', () => step(-1));
    $('lbNext').addEventListener('click', () => step(1));
    $('lbDownload').addEventListener('click', downloadCurrent);
    $('lbDelete').addEventListener('click', deleteCurrent);
    $('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });

    document.addEventListener('keydown', (e) => {
      if ($('lightbox').hidden) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });

    $('clearBtn').addEventListener('click', async () => {
      if (!confirm('Delete all imported media stored in this browser? This cannot be undone.')) return;
      await clearImported();
      imported.forEach((i) => revokeURL(i.id));
      imported = [];
      folderItems.forEach((i) => revokeURL(i.id));
      folderItems = [];
      await clearHandle().catch(() => {});
      folderHandle = null;
      $('folderStatus').classList.add('hidden');
      $('reconnectBtn').classList.add('hidden');
      await render();
      toast('Gallery cleared');
    });
  }

  async function init() {
    try { db = await openDB(); } catch (e) { toast('Storage is unavailable in this browser'); return; }
    imported = (await loadImported()) || [];
    bindEvents();
    if ('showDirectoryPicker' in window) {
      $('folderBtn').classList.remove('hidden');
      await restoreFolder();
    }
    await render();

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
