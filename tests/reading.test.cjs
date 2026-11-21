const assert = require('node:assert/strict');
const test = require('node:test');
const { init } = require('../extension/reading.js');

const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const listeners = new Map();
  const events = [];
  const saves = [];
  const loads = [];
  const positions = [];
  const boundaries = [];
  const state = { y: 0, feed: 'home:following', detail: null, ids: ['11', '22', '33', '44'], back: 0, now: 1_000, ...options.state };
  const fakeWindow = {
    innerHeight: 600,
    performance: {getEntriesByType: () => [{type: options.navigationType}]},
    get scrollY() { return state.y; },
    get location() { return { pathname: state.path }; },
    document: { documentElement: {scrollHeight: options.scrollHeight} },
    addEventListener(type, fn, capture) {
      if (type === 'keydown') assert.equal(capture, true);
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    scrollBy(request) { events.push(['scroll', request.top]); state.y += request.top; },
    setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout
  };
  const reader = init({
    window: fakeWindow,
    now: () => state.now,
    getFeedKey: () => state.feed,
    getDetailId: () => state.detail,
    getPosts: () => state.ids.map((id, index) => ({ id, element: {
      getBoundingClientRect: () => ({ top: index * 350 - state.y, bottom: index * 350 + 330 - state.y })
    } })),
    load(key) { loads.push(key); return options.load?.(key) ?? null; },
    save(key, value) { saves.push([key, value]); },
    openPost(post) { events.push(['open', post.id]); state.feed = null; state.detail = post.id; state.y = 0; },
    goBack() { state.back++; },
    onProgress: snapshot => positions.push(snapshot),
    onBoundary: (kind, snapshot) => boundaries.push([kind, snapshot]),
    canHandleKey: options.canHandleKey,
    loadCheckpoint: options.loadCheckpoint,
    saveCheckpoint: options.saveCheckpoint,
  });
  reader.start();
  t.after(() => reader.stop());
  return { reader, state, listeners, events, saves, loads, positions, boundaries };
}

function key(listeners, value, props = {}) {
  let prevented = 0;
  let stopped = 0;
  listeners.get('keydown')({
    key: value, preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; }, ...props
  });
  return [prevented, stopped];
}

test('auto-resumes the exact feed anchor once without writing it; never approximates an absent ID', async t => {
  const f = fixture(t, { load: key => ({ id: key === 'home:following' ? '33' : '99', index: 1, offset: 60 }) });
  await tick();
  assert.equal(f.reader.getProgress().saved.id, '33');
  assert.equal(f.reader.getProgress().current.id, '33');
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.events, [['scroll', 640]]);
  assert.deepEqual(f.boundaries.map(x => x[0]), ['saved']);
  f.state.y = 620;
  f.reader.refresh();
  assert.deepEqual(f.events, [['scroll', 640]]);
  f.state.feed = 'home:for-you'; f.state.y = 0;
  f.reader.refresh();
  await tick();
  assert.deepEqual(f.loads, ['home:following', 'home:for-you']);
  assert.deepEqual(f.events, [['scroll', 640]]);
});

test('an exact anchor may mount later, but deliberate scroll input or browser Back wins', async t => {
  const f = fixture(t, { state: { ids: ['11', '22'], path: '/home' }, load: () => ({id:'33', offset:60}) });
  await tick();
  assert.deepEqual(f.events, []);
  f.state.ids.push('33');
  f.reader.update();
  assert.deepEqual(f.events, [['scroll', 640]]);
  f.state.feed = 'home:for-you'; f.state.y = 0; f.state.ids = ['11'];
  f.reader.update();
  await tick();
  f.listeners.get('wheel')();
  f.state.ids.push('33');
  f.reader.update();
  assert.equal(f.state.y, 0);
  f.state.feed = null; f.state.path = '/explore';
  f.reader.update();
  f.state.path = '/home';
  f.listeners.get('popstate')();
  f.state.feed = 'home:following';
  f.reader.update();
  assert.equal(f.state.y, 0);
});

test('a missing home anchor never opens a detail, and a late exact card gets priority', async t => {
  for (const hasCard of [false, true]) {
    const timers = new Map();
    const f = fixture(t, {
      load: () => ({id:'99', href:'https://x.com/u/status/99', offset:60}),
      setTimeout: (fn,ms) => { const token = Symbol(ms); timers.set(token,fn); return token; },
      clearTimeout: token => timers.delete(token),
    });
    await tick();
    if (hasCard) f.state.ids.push('99');
    for (const fn of timers.values()) fn();
    assert.equal(f.state.feed,'home:following');
    assert.equal(f.state.detail,null);
    assert.deepEqual(f.events.map(e=>e[0]),hasCard ? ['scroll'] : []);
    if (hasCard) assert.equal(f.reader.getProgress().current.id,'99');
  }
});

test('a reload uses an in-page hint only once and rolls it back if the exact post remains missing', async t => {
  for (const behavior of ['found','missing','interrupted','unreachable']) {
    const timers = new Map();
    const f = fixture(t, {
      navigationType:'reload', state:{ids:['11','22'],y:130},
      scrollHeight: behavior === 'unreachable' ? 900 : 2400,
      loadCheckpoint: () => ({id:'99', offset:60, scrollY:750}),
      setTimeout: (fn,ms) => { timers.set(ms,fn); return ms; },
      clearTimeout: ms => timers.delete(ms),
    });
    await tick();
    f.state.now += 750;
    timers.get(750)();
    assert.equal(f.state.y,behavior === 'unreachable' ? 130 : 750);
    if (behavior === 'found') {
      f.state.ids = ['11','22','99'];
      f.reader.update();
      assert.equal(f.state.y,640); // exact card offset beats the viewport hint
    } else if (behavior === 'interrupted') {
      f.listeners.get('wheel')();
      assert.equal(timers.has(8000),false);
      assert.equal(f.state.y,750);
    } else {
      timers.get(8000)();
      assert.equal(f.state.y,130);
    }
    assert.equal(f.state.feed,'home:following');
    assert.equal(f.state.detail,null);
  }
});

test('reload uses the latest same-entry checkpoint even if an earlier storage write is pending', async t => {
  const checkpoints = new Map();
  const oldDisk = {id:'11', offset:0, updatedAt:1};
  const outgoing = fixture(t, {
    load: () => oldDisk,
    saveCheckpoint: (key,position) => checkpoints.set(key,position)
  });
  await tick();
  outgoing.state.y = 595;
  outgoing.listeners.get('scroll')();
  assert.deepEqual(outgoing.saves, []); // storage debounce has not fired
  outgoing.listeners.get('pagehide')();
  assert.equal(checkpoints.get('home:following').id, '33');
  const incoming = fixture(t, {
    navigationType: 'reload',
    state: {ids:['11','22'], y:240},
    loadCheckpoint: key => checkpoints.get(key),
    load: () => oldDisk,
  });
  await tick();
  assert.equal(incoming.state.y, 240); // no approximation while virtualized
  incoming.state.y = 100; // browser/native restoration while the feed hydrates
  incoming.listeners.get('scroll')();
  incoming.state.ids.push('33');
  incoming.reader.update();
  assert.equal(incoming.state.y, 595);
  assert.deepEqual(incoming.saves, []); // automatic scroll isn't a new position
  assert.equal(incoming.reader.getProgress().saved.id, '11'); // boundary unchanged
});

test('reload does not reuse another feed checkpoint or override manual scrolling', async t => {
  const checkpoints = new Map([['home:following',{id:'33', offset:100}]]);
  const config = {navigationType:'reload', loadCheckpoint:key => checkpoints.get(key)};
  const other = fixture(t, {...config,state:{feed:'home:for-you'}});
  const manual = fixture(t, {...config,state:{ids:['11','22']}});
  await tick();
  manual.listeners.get('wheel')();
  manual.state.ids.push('33');
  manual.reader.update();
  assert.deepEqual(manual.events, []);
  assert.deepEqual(other.events, []);
});

test('keyboard consumes verified actions, never editing, modifiers or unhandled direct details', async t => {
  const f = fixture(t);
  await tick();
  assert.deepEqual(key(f.listeners, 'j', { target: { closest: () => ({}) } }), [0, 0]);
  assert.deepEqual(key(f.listeners, 'J', { isComposing: true }), [0, 0]);
  assert.deepEqual(key(f.listeners, 'J', { ctrlKey: true }), [0, 0]);
  assert.deepEqual(key(f.listeners, 'J', { defaultPrevented: true }), [0, 0]);
  assert.deepEqual(key(f.listeners, 'k'), [0, 0]); // no earlier article is loaded
  assert.deepEqual(key(f.listeners, 'J'), [1, 1]);
  assert.equal(f.reader.getProgress().current.id, '22');
  assert.equal(f.saves.at(-1)[1].id, '22');
  f.reader.setKeys({ previous: 'p' });
  assert.deepEqual(key(f.listeners, 'k'), [0, 0]);
  assert.deepEqual(key(f.listeners, 'p'), [1, 1]);
  assert.deepEqual(key(f.listeners, 'Enter'), [1, 1]);
  f.reader.update();
  assert.equal(f.reader.getProgress().canReturn, true);
  assert.deepEqual(f.events.at(-1), ['open', '11']);
  assert.deepEqual(key(f.listeners, 'Escape'), [1, 1]);
  assert.equal(f.state.back, 1);
  assert.deepEqual(key(f.listeners, 'Escape'), [0, 0]); // no duplicate history navigation
  f.reader.stop();
  assert.equal(f.listeners.size, 0);
});

test('normal browser Back and an explicitly recognized X Back restore only the originating feed and offset', async t => {
  const f = fixture(t, { state: { y: 250 } });
  await tick();
  const open = () => {
    assert.equal(f.reader.beforeOpen({ id: '22' }), true);
    f.state.feed = null; f.state.detail = '22'; f.state.y = 0;
    f.reader.update();
  };
  open();
  f.state.feed = 'home:following'; f.state.detail = null;
  f.listeners.get('popstate')();
  assert.equal(f.state.y, 250);
  assert.equal(f.state.back, 0); // browser already moved; extension never goes back again
  assert.equal(f.reader.getProgress().canReturn, false);
  open();
  assert.equal(f.reader.beforeBack(), true);
  f.state.feed = 'home:following'; f.state.detail = null;
  f.reader.refresh();
  assert.equal(f.state.y, 250);
  assert.deepEqual(f.events, [['scroll', 250], ['scroll', 250]]);
  open();
  f.state.feed = 'home:for-you'; f.state.detail = null;
  f.listeners.get('popstate')();
  assert.equal(f.state.y, 0);
  assert.equal(f.events.length, 2);
});

test('direct details and mismatched details never pop history; missing original anchor never causes deep scroll', async t => {
  const f = fixture(t, { state: { feed: null, detail: '22' } });
  assert.deepEqual(key(f.listeners, 'Escape'), [0, 0]);
  assert.equal(f.reader.beforeBack(), false);
  f.state.feed = 'home:following'; f.state.detail = null; f.state.y = 250;
  f.reader.update();
  await tick();
  f.reader.beforeOpen({ id: '22' });
  f.state.feed = null; f.state.detail = '99';
  f.reader.update();
  assert.deepEqual(key(f.listeners, 'Escape'), [0, 0]);
  f.state.feed = 'home:following'; f.state.detail = null;
  f.reader.update();
  f.reader.beforeOpen({ id: '22' });
  f.state.feed = null; f.state.detail = '22';
  f.reader.update();
  assert.equal(f.reader.beforeBack(), true);
  f.state.feed = 'home:following'; f.state.detail = null; f.state.y = 0; f.state.ids = ['11', '33'];
  f.reader.update();
  f.state.now += 4_000;
  f.reader.refresh();
  assert.deepEqual(f.events, []);
  assert.equal(f.state.back, 0);
  assert.equal(f.boundaries.at(-1)[0], 'missing-origin');
});

test('native Back waits for the exact tab to render, rejecting unrelated paths before they can restore', async t => {
  const f = fixture(t, { state: { y: 250, path: '/home' } });
  const open = () => {
    f.reader.beforeOpen({ id: '22' });
    f.state.feed = null; f.state.detail = '22'; f.state.y = 0; f.state.path = '/user/status/22';
    f.reader.update();
  };
  open();
  f.state.path = '/home'; f.state.detail = null;
  f.listeners.get('popstate')();
  assert.deepEqual(f.events, []);
  f.state.feed = 'home:following';
  f.reader.refresh();
  assert.deepEqual(f.events, [['scroll', 250]]);
  open();
  f.state.path = '/explore'; f.state.detail = null;
  f.listeners.get('popstate')();
  f.state.path = '/home'; f.state.feed = 'home:following';
  f.reader.refresh();
  assert.deepEqual(f.events, [['scroll', 250]]);
});

test('late saved data stays with its feed and live capture does not move the frozen following boundary', async t => {
  let resolveFollowing;
  const f = fixture(t, { load: name => name === 'home:following' ? new Promise(resolve => { resolveFollowing = resolve; }) : { id: '44', offset: 0 } });
  await tick();
  assert.equal(f.reader.capture(), false);
  f.state.feed = 'list:1';
  f.reader.update();
  resolveFollowing({ id: '33', offset: 80 });
  await tick();
  assert.equal(f.reader.getProgress().saved.id, '44');
  f.state.feed = 'home:following'; f.state.y = 0;
  f.reader.update();
  f.reader.next();
  assert.equal(f.saves.at(-1)[1].id, '44');
  assert.equal(f.reader.getProgress().saved.id, '33');
  const oldSignals = f.positions.length;
  f.reader.refresh();
  assert.equal(f.positions.length, oldSignals + 1);
});
