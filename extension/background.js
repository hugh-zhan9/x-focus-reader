'use strict';
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// This is extension-owned, per-tab state. X can replace its history state
// without deleting the most recent position, and other tabs cannot replace it.
const queues = new Map();
const tabKey = tabId => 'xfr-tab-reading:' + tabId;
const MAX_FEEDS = 24;
const TAB_MESSAGE = 'xfr-tab-reading';
const SESSION = chrome.storage.session;

function matchingFeed(sender, key) {
  if (!Number.isInteger(sender.tab?.id) || sender.tab.id < 0 || sender.frameId !== 0) return false;
  let url;
  try { url = new URL(sender.url); } catch { return false; }
  if (url.origin !== 'https://x.com') return false;
  const path = url.pathname.replace(/\/$/, '');
  if (/^home:(?:following|for-you)$/.test(key)) return path === '/home' || path === '';
  return /^list:\d{1,25}$/.test(key) && path === '/i/lists/' + key.slice(5);
}

function fromMessage(value) {
  if (!value || !/^\d{1,25}$/.test(String(value.id)) ||
      !Number.isFinite(value.offset) || !Number.isFinite(value.scrollY) ||
      value.scrollY < 0 || !Number.isFinite(value.updatedAt)) return null;
  return { id:String(value.id), offset:Math.round(value.offset), scrollY:Math.round(value.scrollY), updatedAt:value.updatedAt };
}

function enqueue(tabId, task) {
  const before = queues.get(tabId) || Promise.resolve();
  const next = before.then(task, task);
  queues.set(tabId, next);
  const cleanup = () => { if (queues.get(tabId) === next) queues.delete(tabId); };
  next.then(cleanup, cleanup);
  return next;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== TAB_MESSAGE || typeof message.key !== 'string' ||
      !matchingFeed(sender, message.key) || !['read','save'].includes(message.op)) return false;
  const position = message.op === 'save' ? fromMessage(message.position) : null;
  if (message.op === 'save' && !position) return false;
  const tabId = sender.tab.id;
  const slot = tabKey(tabId);
  enqueue(tabId, async () => {
    const entries = (await SESSION.get(slot))[slot] ?? {};
    if (message.op === 'read') return entries[message.key] ?? null;
    const old = entries[message.key];
    if (old && old.updatedAt > position.updatedAt) return null;
    if (old && old.id === position.id && old.offset === position.offset && old.scrollY === position.scrollY) return null;
    entries[message.key] = position;
    const recent = Object.entries(entries).sort((a,b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_FEEDS);
    await SESSION.set({[slot]: Object.fromEntries(recent)});
    return null;
  }).then(position => reply({position}), () => reply({position:null}));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  enqueue(tabId, () => SESSION.remove(tabKey(tabId))).catch(() => {});
});
