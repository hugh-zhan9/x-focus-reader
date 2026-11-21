'use strict';
(() => {
  const ARTICLE = 'article[data-testid="tweet"]';
  const CONTROL = '[data-testid="tweet-text-show-more-link"],[data-testid="tweet-text-show-more-button"]';
  const UNSAFE = 'a,[href],[role="link"],[data-testid="quoteTweet"],[data-testid="card.wrapper"],[data-testid="card.layoutSmall.detail"],[data-testid="card.layoutLarge.detail"],[data-testid="tweetPhoto"],[data-testid="videoPlayer"]';
  const activated = new WeakMap();

  function expand(article, postId) {
    if (!article?.isConnected || !article.matches(ARTICLE) || article.hasAttribute('data-xfr-collapsed') ||
        typeof postId !== 'string' || !/^\d{1,25}$/.test(postId)) return false;
    let seen = activated.get(article);
    if (seen && (seen.has(postId) || seen.size >= 128)) return false;
    for (const control of article.querySelectorAll(CONTROL)) {
      if (!control.isConnected || control.closest('article') !== article || control.closest(UNSAFE) ||
          !control.matches('button,[role="button"]') || control.disabled || control.form ||
          control.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]') ||
          control.getAttribute('aria-expanded') === 'true' || control.querySelector('a,[href],[role="link"]')) continue;
      if (!seen) { seen = new Set(); activated.set(article, seen); }
      seen.add(postId); // Mark before clicking, in case React mutates or reuses this card immediately.
      control.click();
      return true;
    }
    return false;
  }
  globalThis.XFRTextExpand = Object.freeze({expand});
})();
