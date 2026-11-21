'use strict';
(() => {
  const photo = '[data-testid="tweetPhoto"]';
  const carousel = '[data-testid="ScrollSnap-List"],[data-testid="ScrollSnap-SwipeableList"]';
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
      return group && group !== article && article.contains(group) &&
        !group.matches(excluded) && !group.querySelector(excluded + ',' + mixed + ',' + controls) &&
        !group.textContent.trim() && Array.from(group.querySelectorAll('a[href]')).every(a => anchors.has(a)) &&
        Array.from(group.querySelectorAll(photo)).every(w => items.some(item => item.wrapper === w));
    }
    if (!pure(native)) return null;
    // Bypass fixed aspect-ratio ancestors without changing React's original nodes.
    while (pure(native.parentElement)) native = native.parentElement;
    return {native, items};
  }

  function clear(article) {
    const view = mounted.get(article);
    if (!view) return;
    view.gallery.remove();
    view.native.removeAttribute(nativeAttr);
    mounted.delete(article);
  }

  function show(article, postId, origin) {
    const next = discover(article, postId, origin);
    if (!next) { clear(article); return; }
    const {native, items} = next;
    const signature = JSON.stringify(items.map(({href,src,alt}) => [href,src,alt]));
    const previous = mounted.get(article);
    const failed = unavailable.get(article);
    if (failed?.native === native && failed.signature === signature) { clear(article); return; }
    if (previous?.native === native && previous.signature === signature && previous.gallery.parentElement === native.parentElement) return;
    clear(article);
    const gallery = article.ownerDocument.createElement('div');
    gallery.className = 'xfr xfr-gallery';
    gallery.setAttribute('role','group');
    gallery.setAttribute('aria-label','推文图片');
    for (const {anchor, href, src, alt, index} of items) {
      const link = article.ownerDocument.createElement('a');
      link.href = href;
      const image = article.ownerDocument.createElement('img');
      image.alt = alt || '图片 ' + index;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => {
        if (mounted.get(article)?.gallery === gallery) {
          unavailable.set(article, {native, signature});
          clear(article);
        }
      }, {once:true});
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
    native.parentElement.insertBefore(gallery, native);
    native.setAttribute(nativeAttr, '');
    mounted.set(article, {native, gallery, signature});
  }

  function prune(visible) {
    for (const article of mounted.keys()) if (!visible.has(article)) clear(article);
  }

  globalThis.XFRMedia = {show, prune, discover, photoLink, photoSource};
})();
