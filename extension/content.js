'use strict';
(() => {
  const Rules = globalThis.XFRRules;
  const ARTICLE = 'article[data-testid="tweet"]';
  const timeline = new WeakMap();
  const current = new Map();
  const local = chrome.storage.local;
  let raw = {}, verdict = Rules.compile({});
  let raf = 0, ready = false, activeFeed = null, activeRoute = '', expirationsAt = Infinity, ownWrites = Promise.resolve();
  let reader;
  const root = () => document.querySelector('main [data-testid="primaryColumn"]') || document.querySelector('main');

  function statusLink(anchor) {
    if (!anchor) return null;
    let url;
    try { url = new URL(anchor.getAttribute('href'), location.origin); } catch { return null; }
    if (url.origin !== location.origin) return null;
    const m = /^\/(?:([a-z0-9_]{1,15})|i\/web)\/status\/(\d{1,25})\/?$/i.exec(url.pathname);
    return m ? { id: m[2], author: (m[1] || '').toLowerCase(), url: 'https://x.com/i/web/status/' + m[2] } : null;
  }

  function parse(article) {
    if (!article.isConnected || article.closest('article article')) return null;
    const times = Array.from(article.querySelectorAll('time')).filter(t => t.closest('article') === article);
    const primaryTime = times.find(time => statusLink(time.closest('a')));
    const primary = primaryTime && statusLink(primaryTime.closest('a'));
    if (!primary) return null;
    const quote = times.map(time => statusLink(time.closest('a'))).find(p => p && p.id !== primary.id);
    const quoteSelector = '[data-testid="quoteTweet"],div[role="link"] [data-testid="User-Name"]';
    const quoteUser = article.querySelector(quoteSelector);
    const nestedName = quoteUser?.matches('[data-testid="User-Name"]') ? quoteUser :
      quoteUser?.querySelector('[data-testid="User-Name"]');
    const quoteHandle = [...(nestedName?.querySelectorAll('span') || [])]
      .map(span => span.textContent.trim())
      .find(text => /^@[a-z0-9_]{1,15}$/i.test(text));
    const texts = Array.from(article.querySelectorAll('[data-testid="tweetText"]')).filter(t => t.closest('article') === article);
    const primaryText = texts.find(t => !t.closest('[data-testid="quoteTweet"],div[role="link"]')) ||
      (!quote && !quoteUser ? texts[0] : null);
    const text = primaryText?.textContent || '';
    const topics = Array.from(primaryText?.querySelectorAll('a') || []).map(a => a.textContent)
      .filter(t => /^#[\p{L}\p{N}_]+$/u.test(t));
    const mediaTypes = [];
    const media = selector => [...article.querySelectorAll(selector)].some(item =>
      item.closest('article') === article && !item.closest('[data-testid="quoteTweet"],div[role="link"]'));
    if (media('[data-testid="tweetPhoto"] img[src*="/media/"]')) mediaTypes.push('image');
    if (media('[data-testid="videoPlayer"][aria-label*="GIF" i],[data-testid="gifPlayer"]')) mediaTypes.push('gif');
    else if (media('video,[data-testid="videoPlayer"]')) mediaTypes.push('video');
    if (media('[data-testid="card.wrapper"],[data-testid="card.layoutSmall.detail"],[data-testid="card.layoutLarge.detail"]') ||
        primaryText?.querySelector('a[href^="https://t.co/"],a[href^="http://t.co/"]')) mediaTypes.push('link');
    if (!mediaTypes.length && text.trim()) mediaTypes.push('text');
    return { ...primary, href: primary.url, anchor: primaryTime.closest('a'), element: article,
      quotedAuthor: quote?.author || Rules.normalizeHandle(quoteHandle), text, topics, mediaTypes };
  }

  function route() {
    const path = location.pathname.replace(/\/$/, '');
    const post = /\/(?:status)\/(\d{1,25})(?:\/|$)/.exec(path);
    if (post) return { feed: null, post: post[1] };
    const list = /^\/i\/lists\/(\d{1,25})$/.exec(path);
    if (list) return { feed: 'list:' + list[1], post: null };
    if (path !== '/home' && path !== '') return { feed: null, post: null };
    const tab = root()?.querySelector('[role="tab"][aria-selected="true"]');
    if (!tab) return {feed:null,post:null};
    let label = tab.textContent.trim().normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
    if (/^(for you|为你推荐|为你|為你推薦|推荐|推薦|pour vous|para ti|für dich|おすすめ|추천)$/.test(label)) label = 'for-you';
    else if (/^(following|正在关注|正在關注|关注|關注|已关注|フォロー中|abonnements|siguiendo|folge ich|팔로잉)$/.test(label)) label = 'following';
    else return {feed:null,post:null}; // 未知页面不混用进度
    return { feed: 'home:' + label, post: null };
  }

  function node(tag, name, label) {
    const out = document.createElement(tag);
    if (name) out.className = name;
    if (label) out.textContent = label;
    return out;
  }

  function action(label, fn) {
    const el = node('button', '', label);
    el.type = 'button';
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      Promise.resolve().then(fn).catch(() => announce('暂时无法保存，请重试。'));
    });
    return el;
  }

  let notice, noticeText, noticeAction, noticeTimer;
  function announce(message, undo) {
    if (!notice) {
      notice = node('aside', 'xfr xfr-panel');
      notice.setAttribute('aria-label', 'X Focus Reader 消息');
      const row = node('div');
      noticeText = node('span');
      noticeText.setAttribute('role', 'status');
      noticeAction = node('span');
      row.append(noticeText, noticeAction, action('关闭', () => notice.hidden = true));
      notice.append(row);
      document.body.append(notice);
    }
    noticeText.textContent = message;
    noticeAction.replaceChildren(...(undo ? [action('撤销', undo)] : []));
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.hidden = true, undo ? 15000 : 6000);
  }

  function onSettings(value) {
    raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    verdict = Rules.compile(raw);
    reader?.setKeys?.(raw.shortcuts);
    schedule();
  }

  function changeBlock(handle, expiresAt, remove = false, expectedExpiry) {
    ownWrites = ownWrites.catch(() => {}).then(async () => {
      const { settings } = await local.get('settings');
      const parsed = Rules.normalizeSettings(settings);
      const prior = parsed.blockedAuthors.find(entry => entry.handle === handle);
      if (expectedExpiry !== undefined &&
          (!prior || prior.expiresAt !== expectedExpiry)) return;
      if (expectedExpiry === undefined && !remove && prior?.expiresAt === null) return;
      const blockedAuthors = parsed.blockedAuthors.filter(entry => entry.handle !== handle);
      if (!remove) blockedAuthors.unshift({handle, expiresAt});
      const next = {...settings, blockedAuthors:Rules.normalizeSettings({blockedAuthors}).blockedAuthors};
      await local.set({settings: next});
      onSettings(next);
      if (expectedExpiry !== undefined) announce('已撤销本次屏蔽。');
      else if (!remove) announce('已屏蔽 @' + handle, () =>
        changeBlock(handle, prior?.expiresAt ?? null, !prior, expiresAt));
    });
    return ownWrites;
  }

  function whitelist(handle, remove = false) {
    if (!handle) return;
    ownWrites = ownWrites.catch(() => {}).then(async () => {
      const { settings } = await local.get('settings');
      const { whitelistedAuthors } = Rules.normalizeSettings(settings);
      if (whitelistedAuthors.includes(handle) === !remove) return;
      const list = whitelistedAuthors.filter(value => value !== handle);
      if (!remove) list.unshift(handle);
      const next = { ...settings, whitelistedAuthors: Rules.normalizeSettings({ whitelistedAuthors: list }).whitelistedAuthors };
      await local.set({ settings: next });
      onSettings(next);
      if (remove) announce('已撤销这条白名单。');
      else announce('已放行 @' + handle + ' 的内容规则。', () => whitelist(handle, true));
    });
    return ownWrites;
  }

  function blockTarget(article) {
    const row = article.querySelector('[data-testid="reply"]')?.closest('[role="group"]');
    return row?.closest('article') === article &&
      row.querySelector('[data-testid="like"],[data-testid="unlike"],[data-testid="bookmark"]') ? row : article;
  }

  function blockIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M20 12a8 8 0 1 0-16 0 8 8 0 0 0 16 0ZM6.35 6.35l11.3 11.3');
    svg.append(path);
    return svg;
  }

  function viewFor(article, post) {
    let view = timeline.get(article);
    const author = Rules.normalizeHandle(post.author);
    const target = blockTarget(article);
    if (view?.id === post.id && view.author === author && view.control.parentElement === target) return view;
    if (view) {
      view.control.remove(); view.box.remove();
      article.removeAttribute('data-xfr-collapsed');
    }
    const control = node('div', 'xfr xfr-control' + (target === article ? ' xfr-control-fallback' : ''));
    control.hidden = !author;
    if (author) {
      const block = action('', () => {
        const live = parse(article);
        if (control.parentElement !== target || control.closest('article') !== article || live?.id !== post.id || live.author !== author) return;
        return changeBlock(author, null);
      });
      block.setAttribute('aria-label', '屏蔽 @' + author);
      block.title = '屏蔽 @' + author;
      block.append(blockIcon());
      control.append(block);
    }
    const box = node('div', 'xfr xfr-filter');
    const reason = node('span');
    const toggle = action('展开帖子', () => {
      view.override = !view.override; renderFiltered(article, view, view.reasons);
    });
    const unhide = action('取消作者屏蔽', () => changeBlock(author, null, true));
    const allow = action('加入白名单', () => whitelist(author));
    box.append(reason, toggle, unhide, allow);
    target.append(control);
    view = { id: post.id, control, box, reason, toggle, unhide, allow, override: false, reasons: [], signature: '', author };
    timeline.set(article, view);
    return view;
  }

  const labels = {'blocked-author':'屏蔽作者','blocked-quoted-author':'屏蔽引用作者','keyword':'关键词','topic':'话题','media-type':'内容类型'};
  const mediaLabel = { image:'图片', video:'视频', link:'链接', poll:'投票', gif:'动图' };

  function renderFiltered(article, view, reasons) {
    view.reasons = reasons;
    const signature = JSON.stringify(reasons);
    if (view.signature !== signature) {
      view.signature = signature; view.reason.textContent = reasons.length ?
        '已折叠 · ' + reasons.map(r => (labels[r.id] || r.id) + '：' + (mediaLabel[r.value] || r.value)).join(' / ') : '';
      view.unhide.hidden = !view.author || !reasons.some(r => r.id === 'blocked-author');
      view.allow.hidden = !view.author || !reasons.some(r => !r.id.startsWith('blocked-'));
    }
    const hideBlock = !view.author || reasons.some(r => r.id === 'blocked-author');
    if (view.control.hidden !== hideBlock) view.control.hidden = hideBlock;
    const collapsed = reasons.length > 0 && !view.override;
    if (collapsed !== article.hasAttribute('data-xfr-collapsed'))
      article.toggleAttribute('data-xfr-collapsed', collapsed);
    const label = collapsed ? '展开帖子' : '重新折叠';
    if (view.toggle.textContent !== label) view.toggle.textContent = label;
    if (reasons.length && view.box.parentElement !== article) article.prepend(view.box);
    if (!reasons.length) { view.box.remove(); view.override = false; }
    if (!view.toggle.hasAttribute('aria-expanded') || view.toggle.getAttribute('aria-expanded') !== String(!collapsed))
      view.toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; refresh(); });
  }

  function clearArticle(article) {
    const view = timeline.get(article);
    if (!view) return;
    view.control.remove(); view.box.remove();
    article.removeAttribute('data-xfr-collapsed');
    timeline.delete(article);
  }

  function refresh() {
    if (!ready) return;
    const state = route();
    const col = root();
    activeFeed = state.feed;
    activeRoute = (state.feed || '') + '|' + (state.post || '');
    const now = Date.now();
    expirationsAt = (Array.isArray(raw.blockedAuthors) ? raw.blockedAuthors : []).slice(0, 1000)
      .reduce((soonest, block) => typeof block?.expiresAt === 'number' && block.expiresAt > now
        ? Math.min(soonest, block.expiresAt) : soonest, Infinity);
    current.clear();
    const improvedLayout = raw.preset !== 'original' && Boolean(col && (state.feed || state.post));
    document.documentElement.classList.toggle('xfr-wide', improvedLayout);
    const mediaArticles = new Set();
    // Never decorate conversations, DMs, profile views or off-domain pages.
    if (col && state.feed && raw.preset !== 'original') {
      for (const article of col.querySelectorAll(ARTICLE)) {
        const post = parse(article);
        if (!post || current.has(post.id)) { clearArticle(article); continue; }
        const view = viewFor(article, post);
        const outcome = verdict(post);
        renderFiltered(article, view, outcome.reasons);
        post.collapsed = article.hasAttribute('data-xfr-collapsed');
        current.set(post.id, post);
        if (!post.collapsed) {
          if (!outcome.reasons.length) globalThis.XFRTextExpand?.expand(article, post.id);
          globalThis.XFRMedia?.show(article, post.id, location.origin);
          mediaArticles.add(article);
        }
      }
    } else if (col) {
      for (const article of col.querySelectorAll(ARTICLE)) {
        clearArticle(article);
      }
    }
    if (improvedLayout && !state.feed) {
      for (const article of col.querySelectorAll(ARTICLE)) {
        const post = parse(article);
        if (!post) continue;
        globalThis.XFRMedia?.show(article, post.id, location.origin);
        mediaArticles.add(article);
      }
    }
    globalThis.XFRMedia?.prune(mediaArticles);
    document.documentElement.classList.toggle('xfr-clean', Boolean(state.feed && raw.preset === 'clean'));
    reader?.refresh?.();
  }

  // Reader records the post before SPA navigation. Only plain post-detail clicks count.
  addEventListener('click', ev => {
    if (!(ev.target instanceof Element) || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const anchor = ev.target.closest('a');
    if (anchor?.target === '_blank') return;
    if (route().post && ev.target.closest('button[data-testid="app-bar-back"],[role="button"][data-testid="app-bar-back"]')) {
      reader?.beforeBack?.();
      return;
    }
    if (!activeFeed) return;
    const article = ev.target.closest(ARTICLE);
    const p = article && timeline.get(article);
    if (!p || ev.target.closest('.xfr,[data-testid="tweet-text-show-more-link"],[data-testid="tweet-text-show-more-button"]')) return;
    const link = statusLink(anchor);
    if (anchor && (!link || link.id !== p.id)) return;
    if (!anchor && ev.target.closest('button,[role="button"],[role="link"],input,textarea,select,summary,video,[contenteditable]')) return;
    reader?.beforeOpen?.(current.get(p.id));
  }, true);

  let boundary, outlined;
  function renderProgress(snapshot) {
    if (!boundary) boundary = node('div','xfr xfr-boundary','上次读到这里');
    const entry = snapshot?.boundary || snapshot?.saved;
    const recorded = entry && /^\d{1,25}$/.test(String(entry.id));
    const canShow = Boolean(raw.preset !== 'original' && snapshot?.feedKey && recorded);
    const last = canShow ? current.get(String(entry.id)) : null;
    if (canShow && snapshot.feedKey === 'home:following' && last && !last.collapsed) {
      if (boundary.parentElement !== last.element) last.element.prepend(boundary);
    } else boundary.remove();
    const nextOutline = snapshot?.current && current.get(snapshot.current.id)?.element;
    if (outlined !== nextOutline) {
      outlined?.classList?.remove('xfr-current');
      nextOutline?.classList?.add('xfr-current');
      outlined = nextOutline;
    }
  }

  function readerAdapter() {
    const progressKey = key => 'reading:' + key;
    return {
      getPosts: () => Array.from(current.values()).filter(post =>
        !post.collapsed && post.anchor?.isConnected && statusLink(post.anchor)?.id === post.id),
      getFeedKey: () => raw.preset === 'original' ? null : route().feed,
      getDetailId: () => raw.preset === 'original' ? null : route().post,
      getRoute: () => raw.preset === 'original' ? {feed:null,post:null} : route(),
      async load(key) { const slot=progressKey(key); return (await local.get(slot))[slot]; },
      async save(key,value) { await local.set({[progressKey(key)]:value}); },
      loadCheckpoint(key) {
        const checkpoint = history.state?.xfrReadingCheckpoint;
        return checkpoint?.key === key ? checkpoint.position : null;
      },
      saveCheckpoint(key,position) {
        const state = history.state;
        if (state !== null && (typeof state !== 'object' || Array.isArray(state))) return;
        history.replaceState({...state, xfrReadingCheckpoint:{key,position}}, '');
      },
      openPost(post) {
        if (!post?.anchor?.isConnected || statusLink(post.anchor)?.id !== post.id) return false;
        post.anchor.click();
        return true;
      },
      goBack: () => history.back(),
      onProgress: renderProgress,
      canHandleKey(ev) {
        if (raw.preset === 'original' || raw.shortcutsEnabled === false) return false;
        const el = ev.target;
        if (el instanceof Element && el.closest('.xfr,input,textarea,select,button,a,[role="button"],[role="textbox"],[contenteditable]')) return false;
        return !document.querySelector('[role="dialog"][aria-modal="true"],[data-testid="sheetDialog"]');
      },
    };
  }

  const observer = new MutationObserver(records => {
    if (records.some(r => {
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      return target && !target.closest('.xfr') && (r.type !== 'childList' ||
        !Array.from([...r.addedNodes, ...r.removedNodes]).every(n => n instanceof Element && n.matches('.xfr')));
    })) schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter:['aria-selected','href','data-testid','src','srcset','alt','hidden','inert'] });
  window.addEventListener('popstate', schedule);
  addEventListener('load', event => {
    const img = event.target;
    if (img instanceof Element && img.matches('img') && !img.closest('.xfr') &&
        img.closest(ARTICLE) && globalThis.XFRMedia?.photoSource(img.currentSrc)) schedule();
  }, true);
  setInterval(() => {
    const state = route();
    if ((state.feed || '') + '|' + (state.post || '') !== activeRoute || Date.now() >= expirationsAt) schedule();
  }, 500);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) onSettings(changes.settings.newValue);
  });
  local.get('settings').then(({settings}) => {
    reader = globalThis.XFRReading.init(readerAdapter());
    onSettings(settings);
    ready = true;
    reader.start();
    schedule();
  }).catch(() => announce('扩展设置读取失败，请重新载入页面。'));
})();
