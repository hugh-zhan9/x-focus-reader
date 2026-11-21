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
    get location() { return { pathname: state.path, origin:'https://x.com' }; },
    navigation: options.navigation,
    document: { documentElement: {scrollHeight: options.scrollHeight} },
    addEventListener(type, fn, capture) {
      if (type === 'keydown') assert.equal(capture, true);
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    scrollBy(request) { events.push(['scroll', request.top]); state.y += request.top; },
    setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
    requestAnimationFrame: options.requestAnimationFrame, cancelAnimationFrame: options.cancelAnimationFrame
  };
  const reader = init({
    window: fakeWindow,
    now: () => state.now,
    getFeedKey: () => state.feed,
    getDetailId: () => state.detail,
    getPosts: () => state.ids.map((id, index) => ({ id, element: {
      getBoundingClientRect: () => ({ top: index * 350 - state.y + (state.layoutShift || 0), bottom: index * 350 + 330 - state.y + (state.layoutShift || 0) })
    } })),
    load(key) { loads.push(key); return options.load?.(key) ?? null; },
    save(key, value) { saves.push([key, value]); },
    openPost(post) { events.push(['open', post.id]); state.feed = null; state.detail = post.id; state.y = 0; },
    goBack() { state.back++; },
    onProgress: snapshot => positions.push(snapshot),
    onBoundary: (kind, snapshot) => boundaries.push([kind, snapshot]),
    canHandleKey: options.canHandleKey,
    loadCheckpoint: options.loadCheckpoint,
    loadTabCheckpoint: options.loadTabCheckpoint,
    saveTabCheckpoint: options.saveTabCheckpoint,
    loadReturnCheckpoint: options.loadReturnCheckpoint,
    saveReturnCheckpoint: options.saveReturnCheckpoint,
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
    saveTabCheckpoint: (key,position) => checkpoints.set(key,position)
  });
  await tick();
  outgoing.state.y = 595;
  outgoing.listeners.get('scroll')();
  assert.deepEqual(outgoing.saves, []); // feed-wide debounce has not fired
  assert.equal(checkpoints.get('home:following').id, '33'); // sent before pagehide
  outgoing.listeners.get('pagehide')();
  assert.equal(checkpoints.get('home:following').id, '33');
  const incoming = fixture(t, {
    navigationType: 'reload',
    state: {ids:['11','22'], y:240},
    loadCheckpoint: () => ({id:'22',offset:100,updatedAt:1}),
    loadTabCheckpoint: async key => checkpoints.get(key),
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

test('normal browser Back and an explicitly recognized X Back center the opened post, not an unrelated reading anchor', async t => {
  const f = fixture(t, { state: { y: 250 } });
  await tick();
  const open = () => {
    assert.equal(f.reader.beforeOpen({ id: '33' }), true);
    f.state.feed = null; f.state.detail = '33'; f.state.y = 0;
    f.reader.update();
  };
  open();
  f.state.feed = 'home:following'; f.state.detail = null;
  f.listeners.get('popstate')();
  assert.equal(f.state.y, 565);
  assert.equal(f.state.back, 0); // browser already moved; extension never goes back again
  assert.equal(f.reader.getProgress().canReturn, false);
  open();
  assert.equal(f.reader.beforeBack(), true);
  f.state.feed = 'home:following'; f.state.detail = null;
  f.reader.refresh();
  assert.equal(f.state.y, 565);
  assert.deepEqual(f.events, [['scroll', 565], ['scroll', 565]]);
  open();
  f.state.feed = 'home:for-you'; f.state.detail = null;
  f.listeners.get('popstate')();
  assert.equal(f.state.y, 0);
  assert.equal(f.events.length, 2);
});

test('Back verifies exact centering once after delayed native scroll and layout shift, without saving either', async t => {
  const timers = new Map();
  const f = fixture(t, {
    state: {path:'/home'},
    setTimeout: (fn,ms) => { timers.set(ms,fn); return ms; },
    clearTimeout: ms => timers.delete(ms),
  });
  await tick();
  assert.equal(f.reader.beforeOpen({id:'22'}), true);
  f.state.feed = null; f.state.detail = '22'; f.state.path = '/user/status/22'; f.reader.update();
  f.state.feed = 'home:following'; f.state.detail = null; f.state.path = '/home'; f.listeners.get('popstate')();
  assert.equal(f.state.y, 215);
  const writes = f.saves.length;
  f.state.now += 120;
  f.state.y = 70;
  f.listeners.get('scroll')(); // persisted native history scroll
  f.state.now += 250;
  f.state.layoutShift = 90;
  f.reader.update(); // X mounts a taller preceding card
  assert.deepEqual(f.events, [['scroll',215]]);
  f.state.now += 130;
  timers.get(500)();
  assert.equal(f.state.y, 305);
  assert.deepEqual(f.events, [['scroll',215],['scroll',235]]);
  f.listeners.get('scroll')(); // our own correction isn't reading progress
  assert.equal(f.saves.length, writes);
  assert.equal(timers.has(160), false);
  assert.equal(timers.has(500), false);
});

test('Back corrects visible drift on the next frame and only once before the final check', async t => {
  const timers = new Map(), frames = new Map();
  let frameId = 0;
  const f = fixture(t, {
    state:{path:'/home'},
    setTimeout:(fn,ms)=>{ timers.set(ms,fn);return ms; },
    clearTimeout:ms=>timers.delete(ms),
    requestAnimationFrame:fn=>{ frames.set(++frameId,fn);return frameId; },
    cancelAnimationFrame:id=>frames.delete(id),
  });
  const nextFrame = () => { const next = [...frames.values()];frames.clear();next.forEach(run=>run()); };
  await tick();
  f.reader.beforeOpen({id:'22'});
  f.state.feed=null;f.state.detail='22';f.state.path='/x/status/22';f.reader.update();
  f.state.feed='home:following';f.state.detail=null;f.state.path='/home';f.listeners.get('popstate')();
  assert.equal(f.state.y,215);
  f.state.now+=120;f.state.y=0;nextFrame();
  assert.equal(f.state.y,215);
  assert.equal(frames.size,0);
  assert.deepEqual(f.events,[['scroll',215],['scroll',215]]);
  f.state.now+=250;f.state.layoutShift=80;nextFrame();
  assert.equal(f.state.y,215);
  f.state.now+=130;timers.get(500)();
  assert.equal(f.state.y,295);
  assert.deepEqual(f.events,[['scroll',215],['scroll',215],['scroll',80]]);
});

test('Back still verifies after a late target mount and subsequent preceding-card growth', async t => {
  const timers = new Map();
  const f = fixture(t, {
    state: {path:'/'},
    setTimeout: (fn,ms) => { timers.set(ms,fn); return ms; },
    clearTimeout: ms => timers.delete(ms),
  });
  await tick();
  f.reader.beforeOpen({id:'22'});
  f.state.feed = null; f.state.detail = '22'; f.state.path = '/user/status/22'; f.reader.update();
  f.state.feed = 'home:following'; f.state.detail = null; f.state.path = '/home';
  f.state.ids = ['11','33','44'];
  f.listeners.get('popstate')();
  f.state.now += 120;
  f.state.y = 0; f.listeners.get('scroll')();
  assert.deepEqual(f.events, []);
  f.state.now += 80;
  f.state.ids = ['11','22','33','44']; f.reader.update();
  assert.deepEqual(f.events, [['scroll',215]]);
  f.state.now += 170;
  f.state.layoutShift = 280; f.reader.update();
  f.state.now += 330;
  timers.get(500)();
  const targetTop = 350 + f.state.layoutShift - f.state.y;
  assert.equal(targetTop + 330 / 2, 600 / 2);
  assert.deepEqual(f.events, [['scroll',215],['scroll',280]]);
});

test('Back correction yields to manual input, a missing exact post, or a different pathname', async t => {
  for (const change of ['wheel','touchmove','pointerdown','space','missing','path']) {
    const timers = new Map();
    const f = fixture(t, {
      state: {path:'/home'},
      canHandleKey: () => false,
      setTimeout: (fn,ms) => { timers.set(ms,fn); return ms; },
      clearTimeout: ms => timers.delete(ms),
    });
    await tick();
    f.reader.beforeOpen({id:'22'});
    f.state.feed = null; f.state.detail = '22'; f.state.path = '/user/status/22'; f.reader.update();
    f.state.feed = 'home:following'; f.state.detail = null; f.state.path = '/home'; f.listeners.get('popstate')();
    if (change === 'space') key(f.listeners, ' ', {shiftKey:true});
    else if (change === 'missing') f.state.ids = ['11','33','44'];
    else if (change === 'path') f.state.path = '/different';
    else f.listeners.get(change)();
    f.state.y = 80;
    timers.get(500)?.();
    assert.deepEqual(f.events, [['scroll',215]], change);
    assert.equal(f.state.y, 80, change);
  }
});

test('return from an untracked detail never jumps to ordinary saved reading progress', async t => {
  const f = fixture(t, {
    state:{feed:null, detail:'22', path:'/user/status/22'},
    load: () => ({id:'44', offset:100}),
  });
  f.state.detail = null; f.state.path = '/home';
  f.reader.update(); // tab not yet mounted
  f.state.feed = 'home:following'; f.state.y = 170;
  f.reader.update();
  await tick();
  assert.deepEqual(f.events, []);
  assert.equal(f.state.y, 170);
});

test('app-bar Back waits past 3.4s of Home hydration for the exact card only', async t => {
  for (const mode of ['late-exact','manual','wrong-feed','never-mounted','hard-timeout']) {
    const f = fixture(t, {state:{path:'/home'}});
    await tick();
    f.reader.beforeOpen({id:'22'});
    f.state.feed = null; f.state.detail = '22'; f.state.path = '/user/status/22'; f.reader.update();
    assert.equal(f.reader.beforeBack(), true);
    f.state.now += 2500; // click time is not Home ready time
    f.state.detail = null; f.state.path = '/home'; f.reader.update();
    f.state.feed = 'home:following'; f.state.ids = ['11','33','44']; f.state.y = 100;
    f.reader.update();
    f.state.now += 1200; f.state.y = 180; f.listeners.get('scroll')();
    if (mode === 'manual') f.listeners.get('wheel')();
    if (mode === 'wrong-feed') { f.state.feed = 'home:for-you'; f.reader.update(); }
    f.state.now += mode === 'hard-timeout' ? 9500 : 2300;
    f.state.y = 2400;
    if (mode !== 'never-mounted') f.state.ids = ['11','22','33','44'];
    f.reader.update();
    assert.deepEqual(f.events,mode === 'late-exact' ? [['scroll',-2185]] : [],mode);
  }
});

test('an exact app-bar return survives same-Home virtual gaps through 2.13s and corrects only once', async t => {
  const timers = new Map();
  const f = fixture(t, {
    state:{path:'/home', ids:['11','22','33','44']},
    setTimeout:(fn,ms) => { timers.set(ms,fn); return ms; },
    clearTimeout:ms => timers.delete(ms),
  });
  await tick();
  f.reader.beforeOpen({id:'22'});
  f.state.feed = null; f.state.detail = '22'; f.state.path = '/user/status/22'; f.reader.update();
  assert.equal(f.reader.beforeBack(), true);
  f.state.feed = 'home:following'; f.state.detail = null; f.state.path = '/home'; f.reader.update();
  assert.equal(f.state.y,215);
  const writes = f.saves.length;
  f.state.now += 500;
  timers.get(500)();
  f.state.now += 300;
  f.state.ids = ['11','33','44']; f.reader.update();
  f.state.now += 300;
  f.state.feed = null; f.reader.update();
  f.state.now += 1030;
  f.state.feed = 'home:following'; f.state.ids = ['11','22','33','44'];
  f.state.y = 2400; f.reader.update(); // remount: exact target top = -2050
  assert.equal(f.state.y,215);
  assert.deepEqual(f.events,[['scroll',215],['scroll',-2185]]);
  f.listeners.get('scroll')();
  assert.equal(f.saves.length,writes);
  f.state.ids = ['11','33','44']; f.reader.update();
  f.state.ids = ['11','22','33','44']; f.state.y = 800; f.reader.update();
  assert.equal(f.state.y,800,'second virtual gap cannot trigger another correction');
});

test('late exact remount cannot override input during an unresolved tab, a different feed, or timeout', async t => {
  for (const mode of ['input','wrong-feed','timeout']) {
    const timers = new Map();
    const f = fixture(t, {
      state:{path:'/home'},
      setTimeout:(fn,ms) => { timers.set(ms,fn); return ms; },
      clearTimeout:ms => timers.delete(ms),
    });
    await tick();
    f.reader.beforeOpen({id:'22'});
    f.state.feed = null; f.state.detail = '22'; f.state.path = '/user/status/22'; f.reader.update();
    f.reader.beforeBack();
    f.state.feed = 'home:following'; f.state.detail = null; f.state.path = '/home'; f.reader.update();
    f.state.now += 500; timers.get(500)();
    f.state.feed = null; f.state.ids = ['11','33']; f.reader.update();
    if (mode === 'input') f.listeners.get('wheel')();
    if (mode === 'wrong-feed') { f.state.feed = 'home:for-you'; f.reader.update(); }
    if (mode === 'timeout') f.state.now += 8001;
    f.state.feed = 'home:following'; f.state.ids = ['11','22','33','44'];
    f.state.y = 2400; f.reader.update();
    assert.equal(f.state.y,2400,mode);
    assert.deepEqual(f.events,[['scroll',215]],mode);
  }
});

test('a quick SPA Back before the reader refresh still centers the verified opened post', async t => {
  const f = fixture(t, {state:{path:'/home'}});
  await tick();
  f.reader.beforeOpen({id:'22'});
  f.state.feed = null; f.state.detail = '22'; f.state.path = '/user/status/22';
  await Promise.resolve(); // native same-task pushState, then queued history traversal
  f.state.feed = 'home:following'; f.state.detail = null; f.state.path = '/home';
  f.listeners.get('popstate')();
  assert.equal(f.state.y, 215);
});

test('persisted Back can restore only a confirmed cross-document departure on the same entry', async t => {
  for (const kind of ['exact','wrong-target','prevented','different-entry','ordinary-pageshow']) {
    const routeEvents = new Map();
    let entry;
    const f = fixture(t, {
      state:{path:'/home'},
      navigation:{
        addEventListener:(name, fn) => routeEvents.set(name,fn),
        removeEventListener:(name, fn) => { if (routeEvents.get(name) === fn) routeEvents.delete(name); }
      },
      loadReturnCheckpoint:() => entry,
      saveReturnCheckpoint:(_key,value) => { entry = value; },
    });
    await tick();
    f.reader.beforeOpen({id:'22'});
    routeEvents.get('navigate')?.({
      destination:{sameDocument:false,url:'https://x.com/user/status/' + (kind === 'wrong-target' ? '33' : '22')},
      defaultPrevented: kind === 'prevented',
    });
    await Promise.resolve();
    f.listeners.get('pagehide')({persisted:true});
    if (kind === 'different-entry') entry = {...entry,at:entry.at + 1};
    f.listeners.get('pageshow')?.({persisted:kind !== 'ordinary-pageshow'});
    assert.equal(f.state.y,kind === 'exact' ? 215 : 0,kind);
    f.state.y = 10;
    f.listeners.get('pageshow')?.({persisted:true});
    assert.equal(f.state.y,10,'not reusable for unrelated Back');
  }
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
  f.state.now += 8_001;
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
  assert.deepEqual(f.events, [['scroll', 215]]);
  open();
  f.state.path = '/explore'; f.state.detail = null;
  f.listeners.get('popstate')();
  f.state.path = '/home'; f.state.feed = 'home:following';
  f.reader.refresh();
  assert.deepEqual(f.events, [['scroll', 215]]);
});

test('a fresh browser Back restores the opened post from the originating history entry', async t => {
  let entry;
  const outgoing = fixture(t, {
    state:{y:250,path:'/home'},
    saveReturnCheckpoint:(key,position) => { entry = {key,position}; }
  });
  await tick();
  assert.equal(outgoing.reader.beforeOpen({id:'33'}),true);
  assert.equal(entry.position.id,'33');
  for (const [path,expected] of [['/home',565], ['/explore',0]]) {
    const incoming = fixture(t, {
      navigationType:'back_forward', state:{path,now:2000},
      loadReturnCheckpoint:key => key === entry.key ? entry.position : null
    });
    await tick();
    assert.equal(incoming.state.y,expected);
    assert.equal(incoming.state.detail,null);
  }
});

test('X returning directly from the tracked detail centers it on the original feed', async t => {
  const f = fixture(t,{state:{y:250,path:'/home'}});
  await tick();
  assert.equal(f.reader.beforeOpen({id:'33'}),true);
  f.state.feed=null; f.state.detail='33'; f.state.path='/user/status/33'; f.reader.update();
  f.state.feed='home:following'; f.state.detail=null; f.state.path='/home'; f.state.y=0; f.reader.update();
  assert.equal(f.state.y,565);
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

test("reload awaits the tab position before scrolling to a visible stale history or another tab's feed record", async t => {
  let resolveTab;
  const f = fixture(t, {
    navigationType:'reload',
    loadCheckpoint:() => ({id:'11',offset:20,updatedAt:1}),
    loadTabCheckpoint:() => new Promise(resolve => { resolveTab = resolve; }),
    load:() => ({id:'22',offset:45,updatedAt:1000})
  });
  await tick();
  assert.deepEqual(f.events,[]);
  resolveTab({id:'33',offset:52,scrollY:648,updatedAt:800});
  await tick();
  assert.deepEqual(f.events,[['scroll',648]]);
  assert.equal(f.state.feed,'home:following');
  assert.equal(f.state.detail,null);
});
