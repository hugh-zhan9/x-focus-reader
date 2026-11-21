/* Timeline position/navigation. Adapters supply the current feed and DOM posts;
 * resume never fetches content or navigates away from the timeline. */
((global) => {
  'use strict';

  const DEFAULT_KEYS = Object.freeze({ next: 'j', previous: 'k', open: 'Enter', origin: 'Escape' });
  const SCROLL_SAVE_MS = 160;
  const AUTO_RESUME_MS = 8000;
  const RELOAD_PROBE_DELAY_MS = 750;
  const OPEN_WINDOW_MS = 3000;
  const RETURN_DISCOVERY_MS = 8000;
  const RETURN_HARD_LIMIT_MS = 10000;
  const RETURN_SETTLE_MS = 500;
  const RETURN_EARLY_GRACE_MS = 70;
  const RETURN_ALIGNMENT_TOLERANCE = 4;
  const SCROLL_KEYS = new Set([' ', 'spacebar', 'arrowup', 'arrowdown', 'pageup', 'pagedown', 'home', 'end']);
  const RETURN_CHECKPOINT_MS = 30 * 60 * 1000;
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
    if (Number.isFinite(value.scrollY) && value.scrollY >= 0) record.scrollY = Math.round(value.scrollY);
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
    const latest = new Map();
    const writeQueues = new Map();
    let keys = { ...DEFAULT_KEYS };
    let feedKey = null;
    let detailId = null;
    let suppressFeedAfterDetail = false;
    let current = null;
    let pendingOpen = null;
    let crossDeparture = null;
    let persistedDeparture = null;
    let originMarker = null;
    let pendingReturn = null;
    let settlingReturn = null;
    let returnResumeGuard = null;
    let reachedBoundary = false;
    let scrollTimer = null;
    let auto = null;
    let autoTimer = null;
    let probeTimer = null;
    const navigationType = win.performance?.getEntriesByType?.('navigation')?.[0]?.type;
    let initialHistoryNavigation = navigationType === 'back_forward';
    let firstEntry = !initialHistoryNavigation;
    let initialInput = false;
    let historyPath = null;
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
    function stage() {
      if (!feedKey || !current || frozen.get(feedKey)?.status !== 'ready') return false;
      const record = { ...current, updatedAt: now(), scrollY: getY() };
      const previous = latest.get(feedKey);
      latest.set(feedKey, record);
      unsaved.set(feedKey, record);
      // Dispatch from the observed scroll, before debounce or teardown. Keep
      // the slower feed-wide record for new tabs and future browser sessions.
      if (!previous || previous.id !== record.id || previous.offset !== record.offset || previous.scrollY !== record.scrollY) {
        try { Promise.resolve(adapter.saveTabCheckpoint?.(feedKey, record)).catch(() => {}); } catch {}
      }
      return true;
    }
    function cancelAuto() {
      auto = null;
      if (autoTimer !== null) win.clearTimeout(autoTimer);
      autoTimer = null;
      if (probeTimer !== null) win.clearTimeout(probeTimer);
      probeTimer = null;
    }
    function noteInput() {
      if (!feedKey && (firstEntry || initialHistoryNavigation)) initialInput = true;
      firstEntry = false;
      cancelAuto();
      clearSettlingReturn();
      if (pendingReturn && !adapter.getDetailId?.() &&
          (feedKey || (pendingReturn.path && routePath() === pendingReturn.path))) {
        if (pendingReturn.path && routePath() === pendingReturn.path) {
          returnResumeGuard = {path:pendingReturn.path, expiresAt:pendingReturn.expiresAt};
        }
        clearReturn();
        originMarker = null;
      }
    }
    function startAuto(checkpoint, reload) {
      const startedAt = now();
      const phase = auto = { expiresAt: startedAt + AUTO_RESUME_MS, probeAfter: startedAt + RELOAD_PROBE_DELAY_MS,
        y: baselineY, checkpoint, beforeProbe: null, waiting: reload && typeof adapter.loadTabCheckpoint === 'function' };
      autoTimer = win.setTimeout(() => {
        autoTimer = null;
        if (auto !== phase) return;
        phase.waiting = false;
        update(false, false, true);
      }, AUTO_RESUME_MS);
      const triggerProbe = () => {
        if (Number.isFinite(phase.checkpoint?.scrollY)) {
          probeTimer = win.setTimeout(() => {
            probeTimer = null;
            if (auto === phase) update();
          }, Math.max(0, phase.probeAfter - now()));
        }
      };
      if (phase.waiting) {
        let reading;
        try { reading = adapter.loadTabCheckpoint(feedKey); } catch {}
        Promise.resolve(reading).catch(() => null).then(value => {
          if (auto !== phase) return;
          phase.checkpoint = savedRecord(value) || phase.checkpoint;
          phase.waiting = false;
          triggerProbe();
          update();
        });
      } else {
        triggerProbe();
      }
    }
    function capture() {
      cancelAuto();
      update();
      if (!stage()) return false;
      flush();
      return true;
    }
    function clearReturn() {
      pendingReturn = null;
      if (returnTimer !== null) win.clearTimeout(returnTimer);
      returnTimer = null;
    }
    function clearSettlingReturn() {
      if (!settlingReturn) return;
      win.clearTimeout(settlingReturn.timer);
      win.clearTimeout(settlingReturn.expiration);
      if (settlingReturn.frame !== null) win.cancelAnimationFrame?.(settlingReturn.frame);
      settlingReturn = null;
    }
    function positionDelta(position) {
      const post = posts().find(entry => String(entry.id) === position.id);
      if (!post) return null;
      const rect = post.element.getBoundingClientRect();
      if (rect.bottom <= rect.top) return null;
      const viewport = win.innerHeight || doc.documentElement?.clientHeight || 0;
      const centered = (viewport - (rect.bottom - rect.top)) / 2;
      // Center a normal card. For a card taller than the viewport, show its
      // author and start of the body instead of the middle of a long image.
      const targetOffset = position.center ? (centered >= 0 ? centered : Math.min(120, viewport / 5)) : position.offset;
      const delta = rect.top - targetOffset;
      return Number.isFinite(delta) ? delta : null;
    }
    function jump(position) {
      const delta = positionDelta(position);
      if (delta === null) return false;
      if (delta !== 0) win.scrollBy({ top: delta, behavior: 'instant' });
      return true;
    }
    function alignReturn(delta) {
      if (delta === null || Math.abs(delta) <= RETURN_ALIGNMENT_TOLERANCE) return false;
      win.scrollBy({top:delta, behavior:'instant'});
      baselineY = getY();
      return true;
    }
    function settleReturn(marker) {
      clearSettlingReturn();
      const path = routePath();
      returnResumeGuard = {path, expiresAt:marker.expiresAt};
      const view = settlingReturn = {feedKey:marker.feedKey,path,position:marker.position,timer:null,
        expiration:null,frame:null,startedAt:now(),expiresAt:marker.expiresAt,late:false,gap:false,remounted:false};
      const matches = () => adapter.getFeedKey?.() === view.feedKey && !adapter.getDetailId?.() &&
        routePath() === view.path && doc.visibilityState !== 'hidden' && now() <= view.expiresAt;
      const realign = () => alignReturn(positionDelta(view.position));
      // Repair the first visible drift before the next paint when possible.
      // Cap at one early correction plus one final check, so a moving feed
      // cannot pull the reader back and forth indefinitely.
      const watch = () => {
        view.frame = null;
        if (settlingReturn !== view || !matches()) return;
        if (now() - view.startedAt >= RETURN_EARLY_GRACE_MS && realign()) return;
        view.frame = win.requestAnimationFrame(watch);
      };
      if (typeof win.requestAnimationFrame === 'function') view.frame = win.requestAnimationFrame(watch);
      view.timer = win.setTimeout(() => {
        if (settlingReturn !== view) return;
        win.clearTimeout(view.timer);
        view.timer = null;
        if (view.frame !== null) win.cancelAnimationFrame?.(view.frame);
        view.frame = null;
        if (matches()) {
          const delta = positionDelta(view.position);
          if (delta !== null) {
            alignReturn(delta);
            view.gap = false;
          } else view.gap = true;
        }
        view.late = true;
        update();
      }, RETURN_SETTLE_MS);
      view.expiration = win.setTimeout(() => {
        if (settlingReturn !== view) return;
        clearSettlingReturn();
        baselineY = getY();
        if (feedKey && returnResumeGuard?.path === view.path) returnResumeGuard = null;
        update();
      }, Math.max(0, view.expiresAt - now() + 1));
    }
    function observeReturnRemount() {
      const view = settlingReturn;
      if (!view) return;
      if (now() > view.expiresAt) {
        clearSettlingReturn();
        baselineY = getY();
        return;
      }
      // During SPA hydration the selected Home tab may disappear while the
      // URL is unchanged. Treat this as a gap, not a different known feed.
      if (!feedKey) { view.gap = true; return; }
      if (detailId || feedKey !== view.feedKey || doc.visibilityState === 'hidden') return;
      const delta = positionDelta(view.position);
      if (delta === null) { view.gap = true; return; }
      if (view.late && view.gap && !view.remounted) {
        view.remounted = true;
        alignReturn(delta);
      }
      view.gap = false;
    }

    function update(force = false, fromHistory = false, expired = false) {
      const incomingFeed = adapter.getFeedKey?.() || null;
      const rawDetail = String(adapter.getDetailId?.() ?? '');
      const incomingDetail = ID.test(rawDetail) ? rawDetail : null;
      if (settlingReturn && ((incomingFeed && incomingFeed !== settlingReturn.feedKey) || incomingDetail ||
          routePath() !== settlingReturn.path)) clearSettlingReturn();
      if (returnResumeGuard && (incomingDetail || routePath() !== returnResumeGuard.path ||
          (feedKey && now() > returnResumeGuard.expiresAt))) returnResumeGuard = null;
      const suppressResume = Boolean(returnResumeGuard) || fromHistory || (historyPath !== null && historyPath === routePath());
      if (historyPath !== null && (incomingFeed || historyPath !== routePath())) historyPath = null;
      if (incomingDetail) suppressFeedAfterDetail = true;
      if (incomingDetail || fromHistory) firstEntry = false;
      if (incomingFeed !== feedKey || incomingDetail !== detailId) {
        if (!incomingDetail && originMarker && detailId === originMarker.detailId &&
            (incomingFeed === originMarker.feedKey ||
              (!incomingFeed && originMarker.path && routePath() === originMarker.path))) armReturn();
        const oldFeed = feedKey;
        flush(oldFeed);
        if (scrollTimer !== null) win.clearTimeout(scrollTimer);
        scrollTimer = null;
        cancelAuto();
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
        if (pendingReturn && !incomingDetail && pendingReturn.path && routePath() !== pendingReturn.path) clearReturn();
        if (feedKey) {
          if (returnResumeGuard && now() > returnResumeGuard.expiresAt) returnResumeGuard = null;
          beginLoad(feedKey);
          if (initialHistoryNavigation && !initialInput && !pendingReturn) {
            let saved;
            try { saved = adapter.loadReturnCheckpoint?.(feedKey); } catch {}
            if (saved?.path === routePath() && ID.test(String(saved?.id ?? '')) &&
                now() >= saved.at && now() - saved.at <= RETURN_CHECKPOINT_MS) {
              waitForReturn({detailId:String(saved.id), feedKey, path:saved.path, position:{id:String(saved.id), center:true}});
            }
          }
          if (!suppressResume && !suppressFeedAfterDetail && !pendingReturn && !settlingReturn && !incomingDetail && !initialHistoryNavigation && !initialInput) {
            // A reload can reuse the current entry's exact last position even
            // while native scroll restoration or X's initial layout changes Y.
            let checkpoint = null;
            const reload = firstEntry && navigationType === 'reload';
            if (reload) {
              try { checkpoint = savedRecord(adapter.loadCheckpoint?.(feedKey)); } catch {}
            }
            startAuto(checkpoint, reload);
          }
          suppressFeedAfterDetail = false;
          firstEntry = false;
          initialHistoryNavigation = false;
          initialInput = false;
        }
      }
      if (pendingReturn) {
        const marker = pendingReturn;
        const path = routePath();
        if (!detailId && (!marker.path || path === marker.path) && (marker.path || feedKey === marker.feedKey) &&
            !marker.homeReached && now() <= marker.hardExpiresAt) {
          // X's app-bar click only arms an intent. Start passive exact-card
          // discovery when the original URL is actually reached.
          marker.homeReached = true;
          marker.expiresAt = Math.min(marker.hardExpiresAt, now() + RETURN_DISCOVERY_MS);
          if (marker.path) returnResumeGuard = {path:marker.path, expiresAt:marker.expiresAt};
          scheduleReturnExpiry(marker);
        }
        const returned = marker.homeReached && feedKey === marker.feedKey && !detailId &&
          (!marker.path || path === marker.path) && now() <= marker.expiresAt &&
          doc.visibilityState !== 'hidden' && jump(marker.position);
        if (returned || now() > marker.expiresAt) {
          clearReturn();
          originMarker = null;
          if (returned) {
            baselineY = getY();
            // Initial discovery and post-alignment repair are separate clocks,
            // still subject to the original absolute bound for this return.
            marker.expiresAt = Math.min(marker.hardExpiresAt, Math.max(marker.expiresAt, now() + RETURN_SETTLE_MS));
            settleReturn(marker);
          } else boundary('missing-origin');
        }
      }
      observeReturnRemount();
      if (auto && !auto.waiting) {
        if (!auto.checkpoint && getY() !== auto.y) cancelAuto();
        else {
          const saved = auto.checkpoint || latest.get(feedKey) || frozen.get(feedKey)?.saved;
          if (doc.visibilityState !== 'hidden' && saved && jump(saved)) {
            cancelAuto();
            baselineY = getY();
          } else if (expired || now() >= auto.expiresAt) {
            // A virtualizer may render a completely different set after reload.
            // If the hint didn't bring back the original post, don't leave the
            // reader on an unrelated one. Never issue a navigation.
            const restoreY = auto.beforeProbe;
            cancelAuto();
            if (restoreY !== null && getY() !== restoreY)
              win.scrollBy({top: restoreY - getY(), behavior:'instant'});
            baselineY = getY();
          } else if (doc.visibilityState !== 'hidden' && auto.checkpoint && auto.beforeProbe === null &&
              now() >= auto.probeAfter) {
            const y = auto.checkpoint.scrollY;
            const root = doc.scrollingElement || doc.documentElement;
            const maxY = root?.scrollHeight - (root?.clientHeight || win.innerHeight);
            // Try the old document offset just once, and only if already
            // reachable. Never scroll to the bottom to force-load more posts.
            if (Number.isFinite(y) && y <= maxY - 8 && Math.abs(y - getY()) >= 20) {
              auto.beforeProbe = getY();
              win.scrollBy({top: y - getY(), behavior:'instant'});
            }
          }
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
      if (!feedKey || pendingReturn || settlingReturn || auto || Math.abs(getY() - baselineY) < 20 || !stage()) return;
      const key = feedKey;
      if (scrollTimer !== null) win.clearTimeout(scrollTimer);
      scrollTimer = win.setTimeout(() => { scrollTimer = null; flush(key); }, SCROLL_SAVE_MS);
    }
    function pagehide(event) {
      persistedDeparture = event?.persisted ? crossDeparture : null;
      crossDeparture = null;
      clearSettlingReturn();
      cancelAuto();
      if (scrollTimer !== null) win.clearTimeout(scrollTimer);
      scrollTimer = null;
      // The tab-private write has already been sent by stage(). The deferred
      // record still serves new tabs and later browser sessions.
      flush();
    }
    function onNavigate(event) {
      crossDeparture = null;
      const candidate = pendingOpen;
      const destination = event.destination;
      if (!candidate || destination?.sameDocument !== false || typeof destination.url !== 'string' ||
          event.isTrusted === false || now() > candidate.expiresAt) return;
      let url;
      try { url = new URL(destination.url); } catch { return; }
      const status = /^\/(?:[a-z0-9_]{1,15}|i\/web)\/status\/(\d{1,25})\/?$/i.exec(url.pathname);
      if (url.origin !== win.location?.origin || status?.[1] !== candidate.detailId) return;
      const departure = crossDeparture = candidate;
      // Other navigate handlers can still cancel within this event turn.
      Promise.resolve().then(() => {
        if (event.defaultPrevented && crossDeparture === departure) crossDeparture = null;
      });
    }
    function onPageShow(event) {
      const departure = persistedDeparture;
      persistedDeparture = null;
      if (!event.persisted || !departure || !departure.path || routePath() !== departure.path ||
          adapter.getDetailId?.()) return;
      const activeFeed = adapter.getFeedKey?.();
      if (activeFeed && activeFeed !== departure.feedKey) return;
      let saved;
      try { saved = adapter.loadReturnCheckpoint?.(departure.feedKey); } catch { return; }
      if (saved?.id !== departure.detailId || saved?.path !== departure.path || saved?.at !== departure.at ||
          now() < saved.at || now() - saved.at > RETURN_CHECKPOINT_MS) return;
      pendingOpen = null;
      waitForReturn(departure);
      update();
    }
    function step(direction) {
      clearSettlingReturn();
      cancelAuto();
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
      clearSettlingReturn();
      cancelAuto();
      update();
      const saved = getProgress().saved;
      if (!saved || !jump(saved)) { boundary('missing', { saved }); return false; }
      update();
      return true;
    }
    function beforeOpen(post) {
      clearSettlingReturn();
      cancelAuto();
      update();
      const id = String(post?.id ?? '');
      if (!feedKey || !ID.test(id) || !posts().some(item => String(item.id) === id)) return false;
      const at = now();
      const candidate = pendingOpen = {detailId:id, feedKey, path:routePath(), position:{id,center:true}, at, expiresAt:at + OPEN_WINDOW_MS};
      try { adapter.saveReturnCheckpoint?.(feedKey, {id, path:candidate.path, at}); } catch {}
      // X can change the route in the click turn before the content observer's
      // next animation frame. Verify that exact route before a fast browser Back.
      Promise.resolve().then(() => {
        if (started && pendingOpen === candidate && now() <= candidate.expiresAt &&
            String(adapter.getDetailId?.() ?? '') === id) update();
      });
      capture();
      return true;
    }
    function open() {
      clearSettlingReturn();
      cancelAuto();
      update();
      const post = posts().find(candidate => String(candidate.id) === current?.id);
      if (!post || typeof adapter.openPost !== 'function' || !beforeOpen(post)) return false;
      if (adapter.openPost(post) !== false) return true;
      pendingOpen = null;
      return false;
    }
    function scheduleReturnExpiry(marker) {
      if (returnTimer !== null) win.clearTimeout(returnTimer);
      returnTimer = win.setTimeout(() => {
        if (pendingReturn !== marker) return;
        update();
        if (pendingReturn === marker && now() > marker.expiresAt) {
          clearReturn(); originMarker = null; boundary('missing-origin'); publish();
        }
      }, Math.max(0, marker.expiresAt - now() + 1));
    }
    function waitForReturn(marker) {
      const hardExpiresAt = now() + RETURN_HARD_LIMIT_MS;
      pendingReturn = {...marker, homeReached:false, hardExpiresAt, expiresAt:hardExpiresAt};
      scheduleReturnExpiry(pendingReturn);
      return true;
    }
    function armReturn() {
      if (!originMarker || detailId !== originMarker.detailId || pendingReturn) return false;
      return waitForReturn(originMarker);
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
      clearSettlingReturn();
      cancelAuto();
      historyPath = path;
      update(false, true);
    }
    function onKey(event) {
      if (!event.isComposing && !event.defaultPrevented && !editableEvent(event) &&
          SCROLL_KEYS.has(String(event.key).toLowerCase())) noteInput();
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
      for (const type of ['wheel', 'touchmove', 'pointerdown']) win.addEventListener(type, noteInput, { capture: true, passive: true });
      win.addEventListener('scroll', onScroll, { passive: true });
      win.addEventListener('resize', update);
      win.addEventListener('popstate', onPopState);
      win.addEventListener('pagehide', pagehide);
      win.addEventListener('pageshow', onPageShow);
      win.navigation?.addEventListener?.('navigate', onNavigate);
      update();
    }
    function stop() {
      if (!started) return;
      pagehide();
      clearReturn();
      started = false;
      win.removeEventListener('keydown', onKey, true);
      for (const type of ['wheel', 'touchmove', 'pointerdown']) win.removeEventListener(type, noteInput, true);
      win.removeEventListener('scroll', onScroll);
      win.removeEventListener('resize', update);
      win.removeEventListener('popstate', onPopState);
      win.removeEventListener('pagehide', pagehide);
      win.removeEventListener('pageshow', onPageShow);
      win.navigation?.removeEventListener?.('navigate', onNavigate);
    }
    return { start, stop, update, refresh: () => update(true), capture, resume, next: () => step(1), previous: () => step(-1),
      open, beforeOpen, beforeBack, origin, getProgress, setKeys };
  }

  const api = { init, DEFAULT_KEYS, savedRecord, normalizeKey, editableEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.XFRReading = api;
})(globalThis);
