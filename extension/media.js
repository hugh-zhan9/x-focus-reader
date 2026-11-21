'use strict';
(() => {
  const photo = '[data-testid="tweetPhoto"]';
  const carousel = '[data-testid="ScrollSnap-List"],[data-testid="ScrollSnap-SwipeableList"]';
  const arrows = '[data-testid="ScrollSnap-prevButtonWrapper"],[data-testid="ScrollSnap-nextButtonWrapper"]';
  const gating = '[data-testid*="sensitive" i],[data-testid*="interstitial" i],[data-testid*="mediawarning" i]';
  const excluded = '[data-testid="quoteTweet"],[inert],[hidden],' + gating;
  const mixed = 'video,[data-testid="videoPlayer"],[data-testid="gifPlayer"],[data-testid="card.wrapper"]';
  const controls = 'button,[role="button"],input,select,textarea,[contenteditable="true"]';
  const nativeAttr = 'data-xfr-native-photos';
  const mounted = new Map();
  const unavailable = new WeakMap();

  function photoLink(href, postId, origin) {
    try {
      const url = new URL(href, origin);
      if (url.origin !== origin) return null;
      const m = /^\/(?:[a-z0-9_]{1,15}|i\/web)\/status\/(\d{1,25})\/photo\/([1-4])\/?$/i.exec(url.pathname);
      return m && m[1] === postId ? {href: url.href, index: Number(m[2])} : null;
    } catch { return null; }
  }

  function photoSource(src) {
    try {
      const url = new URL(src);
      if (url.origin !== 'https://pbs.twimg.com' || !/^\/media\/[a-z0-9_-]+(?:\.(?:jpg|jpeg|png|webp|gif))?$/i.test(url.pathname)) return null;
      // Use the same photo; X's named thumbnails and square variants can be cropped server-side.
      if (/^(?:thumb|\d+x\d+)$/i.test(url.searchParams.get('name') || '')) url.searchParams.set('name', 'large');
      return url.href;
    } catch { return null; }
  }

  function discover(article, postId, origin) {
    if (article.querySelector(gating)) return null;
    const entries = new Map();
    for (const wrapper of article.querySelectorAll(photo)) {
      if (wrapper.closest('article') !== article || wrapper.closest(excluded)) continue;
      const anchor = wrapper.closest('a[href]') || wrapper.querySelector('a[href]');
      const link = anchor && photoLink(anchor.getAttribute('href'), postId, origin);
      if (!link) continue; // quoted or unrelated media may not become part of this post's gallery
      const img = Array.from(wrapper.querySelectorAll('img')).find(image => photoSource(image.getAttribute('src') || image.currentSrc));
      if (!img || entries.has(link.index)) return null;
      entries.set(link.index, {...link, anchor, wrapper, src:photoSource(img.getAttribute('src') || img.currentSrc), alt:img.getAttribute('alt') || ''});
    }
    const items = [...entries.values()].sort((a,b)=>a.index-b.index);
    if (!items.length || items.some((item, i) => item.index !== i + 1)) return null;
    let native = items[0].anchor;
    const scrollRoot = items[0].wrapper.closest(carousel);
    // Do not replace a carousel with only its currently mounted first slide.
    if (scrollRoot && items.length < 2) return null;
    if (scrollRoot && Array.from(scrollRoot.querySelectorAll('a[href]')).some(a =>
      photoLink(a.getAttribute('href'), postId, origin) && !items.some(item => item.anchor === a))) return null;
    if (scrollRoot && items.every(item => scrollRoot.contains(item.anchor))) native = scrollRoot;
    while (native && native !== article && !items.every(item => native.contains(item.anchor))) native = native.parentElement;
    const anchors = new Set(items.map(item => item.anchor));
    function pure(group) {
      if (!group || group === article || !article.contains(group) || group.matches(excluded)) return false;
      // X puts the arrows next to the track inside an aspect-ratio shell.
      // Retire that shell as a unit, but only when it owns this photo track
      // and has no other carousel or unrelated controls.
      const ownsTrack = scrollRoot && group.contains(scrollRoot) &&
        [...group.querySelectorAll(carousel)].every(list => list.contains(scrollRoot) || scrollRoot.contains(list));
      const isArrowPart = el => {
        const wrapper = ownsTrack && el.closest(arrows);
        return wrapper && group.contains(wrapper) && !wrapper.contains(scrollRoot) && !scrollRoot.contains(wrapper);
      };
      return !group.querySelector(gating + ',' + mixed) &&
        Array.from(group.querySelectorAll(excluded + ',' + controls)).every(isArrowPart) &&
        !group.textContent.trim() && Array.from(group.querySelectorAll('a[href]')).every(a => anchors.has(a)) &&
        Array.from(group.querySelectorAll(photo)).every(w => items.some(item => item.wrapper === w));
    }
    if (!pure(native)) return null;
    // Bypass fixed aspect-ratio ancestors without changing React's original nodes.
    while (pure(native.parentElement)) native = native.parentElement;
    return {native, items};
  }

  function own(article, selector) {
    return [...article.querySelectorAll(selector)].find(el =>
      el.closest('article') === article && !el.closest(excluded + ',div[role="link"]'));
  }

  function childOf(parent, descendant) {
    let child = descendant;
    while (child && child.parentElement !== parent) child = child.parentElement;
    return child;
  }

  function findSlot(article, native) {
    const body = own(article, '[data-testid="tweetText"]') || own(article, '[data-testid="User-Name"]');
    if (!body) return null;
    const reply = own(article, '[data-testid="reply"]');
    const actions = reply?.closest('[role="group"]') || reply;
    const styleOf = el => article.ownerDocument.defaultView.getComputedStyle(el);
    for (let branch = native; branch.parentElement; branch = branch.parentElement) {
      const host = branch.parentElement;
      if (!article.contains(host)) break;
      const before = childOf(host, body);
      if (!before || before === branch) continue;
      const children = [...host.children];
      const at = children.indexOf(branch);
      if (children.indexOf(before) >= at) continue;
      const after = actions && childOf(host, actions);
      if (after && children.indexOf(after) <= at) continue;
      // The gallery must be a sibling of the content branch, never inside
      // X's absolutely positioned media viewport or a horizontal flex row.
      const style = styleOf(host);
      if (!['block', 'flow-root'].includes(style.display) &&
          !(['flex', 'inline-flex'].includes(style.display) && style.flexDirection === 'column')) continue;
      let normalFlow = true;
      for (let el = host; el && el !== article; el = el.parentElement) {
        const ancestor = styleOf(el);
        if (['absolute', 'fixed'].includes(ancestor.position) ||
            ['hidden', 'clip', 'scroll', 'auto'].includes(ancestor.overflowY) || ancestor.contain?.split(' ').some(v => ['size','strict','content','paint'].includes(v))) {
          normalFlow = false;
          break;
        }
      }
      if (normalFlow) return {host, branch, body, actions};
    }
    return null;
  }

  function fits(article, gallery, body, actions) {
    const g = gallery.getBoundingClientRect();
    if (!g.width || !g.height) return true; // a collapsed or not-yet-loaded card
    const r = body.getBoundingClientRect();
    const a = article.getBoundingClientRect();
    const footer = actions?.getBoundingClientRect();
    return (!r.height || g.top >= r.bottom - 1) && g.bottom <= a.bottom + 1 &&
      (!footer?.height || g.bottom <= footer.top + 1);
  }

  function clear(article) {
    const view = mounted.get(article);
    if (!view) return;
    view.observer?.disconnect();
    view.gallery.remove();
    view.native.removeAttribute(nativeAttr);
    mounted.delete(article);
  }

  function show(article, postId, origin) {
    const next = discover(article, postId, origin);
    if (!next) { clear(article); return; }
    const {native, items} = next;
    const slot = findSlot(article, native);
    if (!slot) { clear(article); return; }
    const {host, branch, body, actions} = slot;
    const signature = JSON.stringify(items.map(({href,src,alt}) => [href,src,alt]));
    const previous = mounted.get(article);
    const failed = unavailable.get(article);
    if (failed?.native === native && failed.host === host && failed.signature === signature) { clear(article); return; }
    if (previous?.native === native && previous.signature === signature && previous.gallery.parentElement === host && previous.branch === branch && previous.body === body && previous.actions === actions) return;
    clear(article);
    const gallery = article.ownerDocument.createElement('div');
    gallery.className = 'xfr xfr-gallery';
    gallery.setAttribute('role','group');
    gallery.setAttribute('aria-label','推文图片');
    let observer;
    const restore = () => {
      if (mounted.get(article)?.gallery !== gallery) return;
      unavailable.set(article, {native, host, signature});
      clear(article);
    };
    const check = () => {
      if (mounted.get(article)?.gallery === gallery && !fits(article, gallery, body, actions)) restore();
    };
    for (const {anchor, href, src, alt, index} of items) {
      const link = article.ownerDocument.createElement('a');
      link.href = href;
      const image = article.ownerDocument.createElement('img');
      image.alt = alt || '图片 ' + index;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', restore, {once:true});
      image.addEventListener('load', check, {once:true});
      image.src = src;
      link.append(image);
      link.addEventListener('click', event => {
        event.stopPropagation();
        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (!anchor.isConnected || photoLink(anchor.getAttribute('href'), postId, origin)?.href !== href) return;
        event.preventDefault();
        anchor.click();
      });
      gallery.append(link);
    }
    host.insertBefore(gallery, branch);
    native.setAttribute(nativeAttr, '');
    const Resize = article.ownerDocument.defaultView.ResizeObserver;
    if (Resize) {
      observer = new Resize(check);
      for (const el of [gallery, body, article, actions].filter(Boolean)) observer.observe(el);
    }
    mounted.set(article, {native, gallery, signature, observer, branch, body, actions});
    check();
  }

  function prune(visible) {
    for (const article of mounted.keys()) if (!visible.has(article)) clear(article);
  }

  globalThis.XFRMedia = {show, prune, discover, photoLink, photoSource};
})();
