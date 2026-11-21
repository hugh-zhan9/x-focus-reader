/* Timeline position/navigation. Adapters supply the current feed and DOM posts;
 * this module never fetches content, walks browser history, or restores on startup. */
((global) => {
  'use strict';

  const DEFAULT_KEYS = Object.freeze({ next: 'j', previous: 'k', open: 'Enter', origin: 'Escape' });
  const SCROLL_SAVE_MS = 160;
  const OPEN_WINDOW_MS = 3000;
  const RETURN_WINDOW_MS = 3000;
  const EDITABLE = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]';
  const ID = /^\d{1,30}$/;

  function normalizeKey(key) {
    return typeof key === 'string' ? key.trim().toLowerCase() : '';
  }
  function editableEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    return path.some(item => item?.isContentEditable || (typeof item?.closest === 'function' && item.closest(EDITABLE)));
  }
  function savedRecord(value) {
    if (!ID.test(String(value?.id ?? '')) || !Number.isFinite(value.offset)) return null;
    const record = { id: String(value.id), index: Math.max(0, Number.isInteger(value.index) ? value.index : 0),
      offset: Math.round(value.offset), updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0 };
    if (typeof value.href === 'string') record.href = value.href;
    return record;
  }

  function init(adapter) {
    const win = adapter.window || global.window;
    const doc = adapter.document || win.document;
    const load = adapter.load || (() => null);
    const save = adapter.save || (() => {});
    const now = adapter.now || Date.now;
    const frozen = new Map();
    const unsaved = new Map();
    const writeQueues = new Map();
    let keys = { ...DEFAULT_KEYS };
    let feedKey = null;
    let detailId = null;
    let current = null;
    let pendingOpen = null;
    let originMarker = null;
    let pendingReturn = null;
    let reachedBoundary = false;
    let scrollTimer = null;
    let scrollFeed = null;
    let returnTimer = null;
    let started = false;
    let baselineY = 0;
    let previousSignal = '';

    function setKeys(value) {
      keys = { ...DEFAULT_KEYS };
      for (const name of Object.keys(DEFAULT_KEYS)) {
        if (typeof value?.[name] === 'string') keys[name] = value[name];
      }
    }
    setKeys(adapter.keys);

    function posts() {
      if (!feedKey) return [];
      const seen = new Set();
      return Array.from(adapter.getPosts?.() || []).filter(post => {
        const id = String(post?.id ?? '');
        if (!ID.test(id) || seen.has(id) || post.collapsed || post.element?.isConnected === false ||
            typeof post.element?.getBoundingClientRect !== 'function') return false;
        seen.add(id);
        return true;
      });
    }
    function view(post, index, rect) {
      const value = { id: String(post.id), index, offset: Math.round(rect.top) };
      if (typeof post.href === 'string') value.href = post.href;
      return value;
    }
    function locate() {
      const choices = posts();
      const height = win.innerHeight || doc.documentElement?.clientHeight || 0;
      const line = Math.min(140, Math.max(0, height / 4));
      let nearest = null;
      let distance = Infinity;
      for (let index = 0; index < choices.length; index++) {
        const post = choices[index];
        const r = post.element.getBoundingClientRect();
        if (!Number.isFinite(r.top) || r.bottom <= 0 || r.top >= height || r.bottom <= r.top) continue;
        const gap = r.top > line ? r.top - line : Math.max(0, line - r.bottom);
        if (gap >= distance) continue;
        nearest = view(post, index, r);
        distance = gap;
      }
      return { choices, current: nearest, line };
    }
    function getProgress() {
      return { feedKey, saved: (feedKey && frozen.get(feedKey)?.saved) || null, current, canReturn: Boolean(originMarker && detailId === originMarker.detailId) };
    }
    function publish(force = false) {
      const snapshot = getProgress();
      const signature = JSON.stringify(snapshot);
      if (!force && signature === previousSignal) return;
      previousSignal = signature;
      adapter.onProgress?.(snapshot);
    }
    function boundary(kind, extra = {}) {
      adapter.onBoundary?.(kind, { ...getProgress(), ...extra });
    }
    function getY() {
      return win.scrollY ?? win.pageYOffset ?? 0;
    }
    function routePath() {
      const path = adapter.getRoute?.()?.path || win.location?.pathname;
      if (typeof path !== 'string') return null;
      return path.replace(/\/+$/, '') || '/home';
    }
    function beginLoad(key) {
      if (frozen.has(key)) return;
      const entry = { status: 'pending', saved: null };
      frozen.set(key, entry);
      Promise.resolve().then(() => load(key)).then(value => {
        entry.saved = savedRecord(value);
        entry.status = 'ready';
        if (started && key === feedKey) update();
      }, () => {
        entry.status = 'ready';
        if (started && key === feedKey) publish();
      });
    }
    function flush(key = feedKey) {
      if (!key || !unsaved.has(key)) return;
      const record = unsaved.get(key);
      unsaved.delete(key);
      // Start the first storage operation immediately (including on pagehide);
      // serialize later writes to avoid an older async write replacing a newer one.
      let writing;
      const previous = writeQueues.get(key);
      if (previous) writing = previous.then(() => save(key, record));
      else {
        try { writing = Promise.resolve(save(key, record)); }
        catch { writing = Promise.resolve(); }
      }
      const queued = writing.catch(() => {});
      writeQueues.set(key, queued);
      queued.then(() => { if (writeQueues.get(key) === queued) writeQueues.delete(key); });
    }
    function capture(expectedFeed = null) {
      update();
      if (!feedKey || !current || (expectedFeed && expectedFeed !== feedKey)) return false;
      if (!frozen.get(feedKey)?.saved && frozen.get(feedKey)?.status !== 'ready') {
        // Load the old position before anything can overwrite it.
        return false;
      }
      unsaved.set(feedKey, { ...current, updatedAt: now() });
      flush();
      return true;
    }
    function clearReturn() {
      pendingReturn = null;
      if (returnTimer !== null) win.clearTimeout(returnTimer);
      returnTimer = null;
    }
    function jump(position) {
      const post = posts().find(entry => String(entry.id) === position.id);
      if (!post) return false;
      const delta = post.element.getBoundingClientRect().top - position.offset;
      if (!Number.isFinite(delta)) return false;
      if (delta !== 0) win.scrollBy({ top: delta, behavior: 'instant' });
      return true;
    }

    function update(force = false) {
      const incomingFeed = adapter.getFeedKey?.() || null;
      const rawDetail = String(adapter.getDetailId?.() ?? '');
      const incomingDetail = ID.test(rawDetail) ? rawDetail : null;
      if (incomingFeed !== feedKey || incomingDetail !== detailId) {
        const oldFeed = feedKey;
        flush(oldFeed);
        if (scrollTimer !== null) win.clearTimeout(scrollTimer);
        scrollTimer = null;
        scrollFeed = null;
        feedKey = incomingFeed;
        detailId = incomingDetail;
        current = null;
        baselineY = getY();
        reachedBoundary = false;

        if (incomingDetail && pendingOpen && pendingOpen.detailId === incomingDetail && now() <= pendingOpen.expiresAt) {
          originMarker = pendingOpen;
        } else if (!pendingReturn) {
          originMarker = null;
        }
        pendingOpen = null;
        if (pendingReturn && incomingFeed && incomingFeed !== pendingReturn.feedKey) clearReturn();
        if (pendingReturn && incomingDetail && incomingDetail !== pendingReturn.detailId) clearReturn();
        if (feedKey) beginLoad(feedKey);
      }
      if (feedKey && pendingReturn?.feedKey === feedKey) {
        const returned = jump(pendingReturn.position);
        if (returned || now() > pendingReturn.expiresAt) {
          clearReturn();
          originMarker = null;
          if (returned) baselineY = getY();
          else boundary('missing-origin');
        }
      }
      const location = locate();
      current = location.current;
      const saved = getProgress().saved;
      if (feedKey === 'home:following' && saved && !reachedBoundary && current?.id === saved.id) {
        reachedBoundary = true;
        boundary('saved');
      }
      publish(force === true);
    }
    function onScroll() {
      update();
      if (!feedKey || pendingReturn || Math.abs(getY() - baselineY) < 20) return;
      if (scrollTimer !== null) win.clearTimeout(scrollTimer);
      scrollFeed = feedKey;
      scrollTimer = win.setTimeout(() => { const key = scrollFeed; scrollTimer = null; scrollFeed = null; capture(key); }, SCROLL_SAVE_MS);
    }
    function pagehide() {
      if (scrollTimer !== null) {
        win.clearTimeout(scrollTimer);
        scrollTimer = null;
        const key = scrollFeed;
        scrollFeed = null;
        capture(key);
      }
      flush();
    }
    function step(direction) {
      update();
      const { choices, line } = locate();
      if (!feedKey || !current) return false;
      const target = choices[current.index + direction];
      if (!target) {
        boundary(direction > 0 ? 'end' : 'start');
        return false;
      }
      if (!jump({ id: String(target.id), offset: line })) return false;
      update();
      capture();
      return true;
    }
    function resume() {
      update();
      const saved = getProgress().saved;
      if (!saved || !jump(saved)) { boundary('missing', { saved }); return false; }
      update();
      return true;
    }
    function beforeOpen(post) {
      update();
      const id = String(post?.id ?? '');
      if (!feedKey || !ID.test(id) || !current || !posts().some(item => String(item.id) === id)) return false;
      pendingOpen = { detailId: id, feedKey, path: routePath(), position: { ...current }, expiresAt: now() + OPEN_WINDOW_MS };
      capture();
      return true;
    }
    function open() {
      update();
      const post = posts().find(candidate => String(candidate.id) === current?.id);
      if (!post || typeof adapter.openPost !== 'function' || !beforeOpen(post)) return false;
      if (adapter.openPost(post) !== false) return true;
      pendingOpen = null;
      return false;
    }
    function armReturn() {
      if (!originMarker || detailId !== originMarker.detailId || pendingReturn) return false;
      pendingReturn = { ...originMarker, expiresAt: now() + RETURN_WINDOW_MS };
      returnTimer = win.setTimeout(() => {
        update();
        if (pendingReturn) { clearReturn(); originMarker = null; boundary('missing-origin'); publish(); }
      }, RETURN_WINDOW_MS + 1);
      return true;
    }
    function beforeBack() {
      update();
      return armReturn();
    }
    function origin() {
      if (typeof adapter.goBack !== 'function' || !beforeBack()) return false;
      if (adapter.goBack() !== false) return true;
      clearReturn();
      return false;
    }
    function onPopState() {
      // React may not yet mark a tab selected even though the browser URL
      // already changed. Arm on the originating path, but only jump later
      // when the exact feed and recorded post have both been recognized.
      const nextFeed = adapter.getFeedKey?.() || null;
      const path = routePath();
      if (originMarker && !adapter.getDetailId?.() &&
          (nextFeed === originMarker.feedKey ||
           (!nextFeed && (!path || !originMarker.path || path === originMarker.path)))) armReturn();
      update();
    }
    function onKey(event) {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
          event.shiftKey || editableEvent(event) || (adapter.canHandleKey && !adapter.canHandleKey(event))) return;
      const key = normalizeKey(event.key);
      if (!key) return;
      let handled = false;
      if (key === normalizeKey(keys.origin)) handled = origin();
      else if (key === normalizeKey(keys.next)) handled = step(1);
      else if (key === normalizeKey(keys.previous)) handled = step(-1);
      else if (key === normalizeKey(keys.open)) handled = open();
      if (!handled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    function start() {
      if (started) return;
      started = true;
      win.addEventListener('keydown', onKey, true);
      win.addEventListener('scroll', onScroll, { passive: true });
      win.addEventListener('resize', update);
      win.addEventListener('popstate', onPopState);
      win.addEventListener('pagehide', pagehide);
      update();
    }
    function stop() {
      if (!started) return;
      pagehide();
      clearReturn();
      started = false;
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('scroll', onScroll);
      win.removeEventListener('resize', update);
      win.removeEventListener('popstate', onPopState);
      win.removeEventListener('pagehide', pagehide);
    }
    return { start, stop, update, refresh: () => update(true), capture, resume, next: () => step(1), previous: () => step(-1),
      open, beforeOpen, beforeBack, origin, getProgress, setKeys };
  }

  const api = { init, DEFAULT_KEYS, savedRecord, normalizeKey, editableEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.XFRReading = api;
})(globalThis);
