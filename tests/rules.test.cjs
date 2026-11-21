const assert = require('node:assert/strict');
const test = require('node:test');
require('../extension/rules.js');
const { compile, evaluate, normalizeHandle, normalizeSettings } = globalThis.XFRRules;

const permanent = handle => ({ handle, expiresAt: null });
const reason = (id, value) => ({ id, value });

test('normalizeHandles accepts Unicode presentation variants but not URLs or display names', () => {
  assert.equal(normalizeHandle(' ＠Ｆｏｃｕｓ＿１２３ '), 'focus_123');
  for (const invalid of ['https://x.com/user', '@a b', '@a.b', '@@a', '名字', 'a'.repeat(16), null]) {
    assert.equal(normalizeHandle(invalid), '');
  }
});

test('empty and malformed imported data are disabled by default; unrelated keys are omitted', () => {
  const baseline = { blockedAuthors: [], whitelistedAuthors: [], filterQuotedAuthors: false, keywords: [], topics: [], mediaTypes: [] };
  assert.deepEqual(normalizeSettings(), baseline);
  for (const invalid of [null, 123, 'auto', Object.create({ keywords: ['unexpected'] })]) {
    assert.deepEqual(normalizeSettings(invalid), baseline);
  }
  const imported = JSON.parse('{"version":1,"quote":"on","filterQuotedAuthors":"true","blockedAuthors":[{"handle":"@User","expiresAt":"5000"},{"handle":"@Other"},{"handle":"Longer","expiresAt":-1},null],"keywords":[null,{"toString":"x"}],"topics":"x","mediaTypes":[null,"executable"],"__proto__":{"filterQuotedAuthors":true}}');
  assert.deepEqual(normalizeSettings(imported), baseline);
  assert.deepEqual(evaluate(null, imported, 4000), { hidden: false, reasons: [] });
});

test('duplicates normalize, permanent block wins, and exact expiry expires', () => {
  const raw = {
    blockedAuthors: [
      { handle: '@Later', expiresAt: 4000 }, { handle: 'later', expiresAt: 5000 }, { handle: 'Later', expiresAt: 1000 },
      { handle: 'Never', expiresAt: 1000 }, permanent('@NEVER'), { handle: '@never', expiresAt: 9000 },
    ], whitelistedAuthors: [' @Good ', 'gOoD'], keywords: ['CAFÉ', 'cafe\u0301'],
    topics: ['＃攝影', '攝影'], mediaTypes: ['Photo', 'IMAGE', 'video', 'Other'],
  };
  const settings = normalizeSettings(raw);
  assert.deepEqual(settings.blockedAuthors, [{ handle: 'later', expiresAt: 5000 }, permanent('never')]);
  assert.deepEqual(settings.whitelistedAuthors, ['good']);
  assert.deepEqual(settings.keywords, ['café']);
  assert.deepEqual(settings.topics, ['攝影']);
  assert.deepEqual(settings.mediaTypes, ['image', 'video']);
  assert.deepEqual(normalizeSettings(settings), settings);
  assert.deepEqual(evaluate({ author: '@LATER' }, settings, 4999).reasons, [reason('blocked-author', 'later')]);
  assert.equal(evaluate({ author: 'later' }, settings, 5000).hidden, false);
  assert.equal(evaluate({ author: 'never' }, settings, Number.MAX_SAFE_INTEGER).hidden, true);
});

test('24 hour time is absolute and an expired rule does not block the next visit', () => {
  const now = Date.UTC(2026, 10, 21, 1, 30);
  const settings = { blockedAuthors: [{ handle: 'time', expiresAt: now + 24 * 60 * 60 * 1000 }] };
  const apply = compile(settings);
  assert.equal(apply({ author: 'time' }, now).hidden, true);
  assert.equal(apply({ author: 'time' }, now + 86_400_000).hidden, false);
});

test('quote blocks are opt-in; whitelist ignores content, never author block or enabled quoted block', () => {
  const post = { author: '@Allowed', quotedAuthor: '@Blocked', text: 'spam', topics: ['#Sport'], mediaTypes: ['VIDeo'] };
  const rules = { blockedAuthors: [permanent('blocked')], whitelistedAuthors: ['allowed'], keywords: ['spam'], topics: ['sport'], mediaTypes: ['video'] };
  assert.deepEqual(evaluate(post, rules, 1), { hidden: false, reasons: [] });
  assert.deepEqual(evaluate(post, { ...rules, filterQuotedAuthors: true }, 1), {
    hidden: true, reasons: [reason('blocked-quoted-author', 'blocked')],
  });
  assert.deepEqual(evaluate(post, { ...rules, blockedAuthors: [...rules.blockedAuthors, permanent('allowed')] }, 1), {
    hidden: true, reasons: [reason('blocked-author', 'allowed')],
  });
});

test('keyword uses own post text and literal tokens; topic requires explicit topic metadata', () => {
  const rules = { keywords: ['CAFÉ\nNOIR', '財經', '[ab]'], topics: ['#体育'], mediaTypes: ['Photo'] };
  assert.deepEqual(evaluate({
    author: 'x', text: 'Cafe\u0301\tnoir ・財經 [ab]', topics: ['＃体育', 'politique'], mediaTypes: ['image'],
  }, rules, 0).reasons, [
    reason('keyword', 'café noir'), reason('keyword', '財經'), reason('keyword', '[ab]'),
    reason('topic', '体育'), reason('media-type', 'image'),
  ]);
  assert.deepEqual(evaluate({ text: 'A alone in #体育', quotedText: '[ab] 財經' }, rules, 0).reasons, []);
});

test('compiled evaluator takes a detached rule snapshot and explanations are independent', () => {
  const settings = { keywords: ['old'] };
  const apply = compile(settings);
  settings.keywords[0] = 'new';
  const first = apply({ text: 'old' });
  first.reasons.pop();
  assert.deepEqual(apply({ text: 'old' }), { hidden: true, reasons: [reason('keyword', 'old')] });
  assert.equal(apply({ text: 'new' }).hidden, false);
  assert.equal(evaluate({ text: 'new' }, settings).hidden, true);
});

test('limits normalized rule size even when Unicode compatibility forms expand', () => {
  const p = normalizeSettings({
    keywords: ['ﬃ'.repeat(120), 'ok'],
    topics: ['##malformed', '#Tag'],
    whitelistedAuthors: Array.from({ length: 1100 }, (_, i) => 'user_' + i),
  });
  assert.deepEqual(p.keywords, ['ok']);
  assert.deepEqual(p.topics, ['tag']);
  assert.equal(p.whitelistedAuthors.length, 1000);
  assert.deepEqual(normalizeSettings(p), p);
});
