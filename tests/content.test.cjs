'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const dir = require('node:path').join(__dirname,'..','extension');

class E {
  constructor(tag) { this.tagName=tag; this.parentElement=null; this.children=[]; this.className=''; this.textContent=''; this.attrs={}; this.isConnected=true; this.handlers={}; }
  append(...nodes) { for (const n of nodes) { n.remove(); this.children.push(n); n.parentElement=this; } }
  prepend(n) { n.remove(); this.children.unshift(n); n.parentElement=this; }
  remove() { if (this.parentElement) { const a=this.parentElement.children; a.splice(a.indexOf(this),1); this.parentElement=null; } }
  replaceChildren(...nodes) { for(const e of [...this.children]) e.remove(); this.append(...nodes); }
  querySelector(s) { return this.special?.[s] || this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return this.special?.[s] || []; }
  closest(s) {
    if(s==='[role="group"]') return this.getAttribute('role')==='group' ? this : this.parentElement?.closest(s);
    if(s==='a') return this.tagName==='a' ? this : this.parentElement?.closest(s);
    if(s==='article'||s==='article[data-testid="tweet"]') return this.tagName==='article'?this:this.parentElement?.closest(s);
    if(s==='.xfr') return this.className.split(' ').includes('xfr') ? this : this.parentElement?.closest(s);
    return null;
  }
  addEventListener(a,b) { this.handlers[a]=b; }
  setAttribute(a,b) { this.attrs[a]=b; }
  hasAttribute(a) { return Object.hasOwn(this.attrs,a); }
  getAttribute(a) { return this.attrs[a]??null; }
  removeAttribute(a) { delete this.attrs[a]; }
  toggleAttribute(a,b) { if(b) this.setAttribute(a,''); else this.removeAttribute(a); }
}
async function harness(settings = {}) {
  const body=new E('body');
  const col=new E('div');
  const selected=new E('a');
  selected.textContent='Following';
  const article=new E('article');
  const anchor=new E('a');
  const time=new E('time');
  const text=new E('span');
  text.textContent='今天抽奖 #测试';
  const topic=new E('a');
  topic.textContent='#测试';
  text.special={'a':[topic]};
  anchor.setAttribute('href','/Example/status/123');
  anchor.append(time);
  article.append(anchor,text);
  article.special={'time':[time],'[data-testid="tweetText"]':[text]};
  col.special={'article[data-testid="tweet"]':[article],'[role="tab"][aria-selected="true"]':selected};
  const docEl=new E('html');
  const classes=new Set();
  docEl.classList={toggle(c,on){if(on) classes.add(c); else classes.delete(c);}};
  let change, observe;
  const frames = [], intervals=[], feedStates=[], writes=[], expanded=[], media=[];
  let adapter;
  const redirects=[], messages=[];
  const history={state:{x:'preserved'},back(){},replaceState(value){this.state=value;}};
  const loc={origin:'https://x.com',pathname:'/home',assign(href){redirects.push(href)}};
  const context=vm.createContext({
    URL, Element:E, location:loc, history,
    document: { body, documentElement:docEl, querySelector:s => s.startsWith('main') ? col : null, createElement:t=>new E(t), createElementNS:(_,t)=>new E(t) },
    XFRTextExpand:{expand(el,id){expanded.push(id)}},
    XFRMedia:{show(el,id){media.push(id)},prune(visible){media.push(visible.size)}},
    XFRReading: {init(a){adapter=a;return {start(){},refresh(){feedStates.push(a.getRoute())},setKeys(){},beforeOpen(){}}}},
    MutationObserver: class { constructor(fn){observe=fn} observe(){} },
    chrome:{runtime:{sendMessage:async msg=>{messages.push(msg);return {position:{id:'234'}}}},storage:{local:{async get(){return {settings}},async set(data){settings=data.settings;writes.push(settings)}},onChanged:{addListener(fn){change=fn}}}},
    window:{addEventListener(){},innerHeight:750,location:{pathname:'/home'},document:null},
    addEventListener(){},requestAnimationFrame(fn){frames.push(fn); return frames.length},setTimeout(){return 1},clearTimeout(){},setInterval(fn){intervals.push(fn)},console
  });
  context.window.document=context.document;
  for(const f of ['rules.js','content.js']) vm.runInContext(fs.readFileSync(dir+'/'+f,'utf8'),context,{filename:f});
  await new Promise(resolve=>setImmediate(resolve));
  const frame=()=>{ for(const fn of frames.splice(0)) fn(); };
  frame();
  return {article,selected,context,frame,intervals,feedStates,observe,body,writes,anchor,adapter,redirects,messages,history,classes,expanded,media,update(settings){change({settings:{newValue:settings}},'local');frame()}};
}
test('filter decorates only recognized feeds, gives a reason and restores original mode',async()=>{
  const h=await harness({keywords:['抽奖']});
  assert.ok(h.article.hasAttribute('data-xfr-collapsed'));
  assert.match(h.article.children[0].children[0].textContent,/关键词：抽奖/);
  h.update({keywords:['抽奖'],preset:'original'});
  assert.equal(h.article.hasAttribute('data-xfr-collapsed'),false);
  assert.equal(h.article.children.length,2);
  h.update({keywords:['抽奖']});
  assert.ok(h.article.hasAttribute('data-xfr-collapsed'));
  h.context.location.pathname='/Example/status/123';
  h.intervals[0](); h.frame();
  assert.equal(h.article.hasAttribute('data-xfr-collapsed'),false);
});
test('allowlisted authors remain visible; localized home tabs remain separate',async()=>{
  const h=await harness({keywords:['抽奖'],whitelistedAuthors:['example']});
  assert.equal(h.article.hasAttribute('data-xfr-collapsed'),false);
  h.selected.textContent='为你推荐';
  h.intervals[0](); h.frame();
  h.selected.textContent='unknown';
  h.intervals[0](); h.frame();
  assert.equal(h.article.children.length,2);
  assert.equal(h.feedStates[0]?.feed,'home:following');
  assert.equal(h.feedStates[1]?.feed,'home:for-you');
  assert.equal(h.feedStates[2]?.feed,null);
});

test('recycled article without a valid anchor loses stale fold state',async()=>{
  const h=await harness({keywords:['抽奖']});
  assert.ok(h.article.hasAttribute('data-xfr-collapsed'));
  h.article.special.time.length=0;
  h.observe([{target:h.article,type:'attributes'}]); h.frame();
  assert.equal(h.article.hasAttribute('data-xfr-collapsed'),false);
  assert.equal(h.article.children.length,2);
});

function click(button) {
  let stopped = false;
  button.handlers.click({stopPropagation(){stopped=true}});
  assert.ok(stopped);
}

test('one visible block button writes a permanent rule and offers undo even after a double click', async()=>{
  const expiry = Date.now() + 3600000;
  const h = await harness({blockedAuthors:[{handle:'legacy',expiresAt:expiry}]});
  const control = h.article.children.at(-1);
  assert.equal(control.className, 'xfr xfr-control xfr-control-fallback');
  assert.deepEqual(control.children.map(el=>[el.tagName,el.textContent]),[['button','']]);
  assert.equal(control.children[0].children[0].tagName,'svg');
  const block = control.children[0];
  assert.equal(block.getAttribute('aria-label'),'屏蔽 @example');
  click(block);
  click(block);
  await new Promise(setImmediate);
  h.frame();
  assert.equal(h.writes.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes[0].blockedAuthors)),[
    {handle:'example',expiresAt:null},{handle:'legacy',expiresAt:expiry}
  ]);
  assert.equal(h.article.hasAttribute('data-xfr-collapsed'),true);
  assert.equal(control.hidden,true);
  const row = h.body.children.find(el=>el.getAttribute('aria-label')==='X Focus Reader 消息').children[0];
  assert.match(row.children[0].textContent,/已屏蔽 @example/);
  const undo = row.children[1].children[0];
  assert.equal(undo.textContent,'撤销');
  click(undo);
  await new Promise(setImmediate);
  h.frame();
  assert.equal(h.article.hasAttribute('data-xfr-collapsed'),false);
  assert.equal(control.hidden,false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes[1].blockedAuthors)),[{handle:'legacy',expiresAt:expiry}]);
});

test('a recycled post button cannot block the former author', async()=>{
  const h = await harness();
  const block = h.article.children.at(-1).children[0];
  h.anchor.setAttribute('href','/NewAuthor/status/999');
  click(block);
  await new Promise(setImmediate);
  assert.equal(h.writes.length,0);
  h.observe([{target:h.anchor,type:'attributes'}]); h.frame();
  const next = h.article.children.at(-1).children[0];
  assert.equal(next.getAttribute('aria-label'),'屏蔽 @newauthor');
});


test('reading enhancements respect native mode, filtered cards and timeline versus detail',async()=>{
  const h=await harness({keywords:['抽奖']});
  assert.ok(h.classes.has('xfr-wide'));
  assert.deepEqual(h.expanded,[]);
  assert.deepEqual(h.media,[0]);
  h.update({});
  assert.deepEqual(h.expanded,['123']);
  assert.deepEqual(h.media,[0,'123',1]);
  h.context.location.pathname='/Example/status/123';
  h.intervals[0](); h.frame();
  assert.deepEqual(h.expanded,['123']);
  assert.deepEqual(h.media,[0,'123',1,'123',1]);
  h.update({preset:'original'});
  assert.ok(!h.classes.has('xfr-wide'));
  assert.equal(h.media.at(-1),0);
});


test('block icon joins the native action row when hydrated without leaving the fallback behind',async()=>{
  const h=await harness();
  const fallback=h.article.children.at(-1);
  const row=new E('div'), reply=new E('button'), like=new E('button');
  row.setAttribute('role','group');
  row.special={'[data-testid="like"],[data-testid="unlike"],[data-testid="bookmark"]':like};
  row.append(reply,like);
  h.article.special['[data-testid="reply"]']=reply;
  h.article.append(row);
  h.observe([{target:h.article,type:'attributes'}]); h.frame();
  const control=row.children.at(-1);
  assert.equal(fallback.parentElement,null);
  assert.equal(control.className,'xfr xfr-control');
  assert.equal(control.children[0].getAttribute('aria-label'),'屏蔽 @example');
  click(control.children[0]);
  await new Promise(setImmediate);
  h.frame();
  assert.ok(h.article.hasAttribute('data-xfr-collapsed'));
  assert.equal(control.hidden,true);
});


test('the feed offers no automatic permalink redirect or manual resume panel', async () => {
  const h = await harness();
  assert.equal(h.adapter.openSaved,undefined);
  assert.equal(h.body.children.some(n=>n.className.includes('xfr-reader-position')),false);
  assert.deepEqual(h.redirects,[]);
});

test('tab refresh uses extension messaging; detail Back preserves native history state', async () => {
  const h = await harness();
  assert.equal(h.adapter.getPosts()[0].id, '123');
  h.anchor.setAttribute('href', '/Example/status/456');
  assert.equal(h.adapter.getPosts().length, 0);
  const saved = {id:'123',offset:49};
  await h.adapter.saveTabCheckpoint('home:following',saved);
  assert.equal((await h.adapter.loadTabCheckpoint('home:following')).id,'234');
  assert.deepEqual(h.messages.map(m=>m.op),['save','read']);
  assert.equal(h.history.state.x,'preserved');
  assert.equal(h.history.state.xfrReadingCheckpoint,undefined);
  h.adapter.saveReturnCheckpoint('home:following',saved);
  assert.equal(h.history.state.x,'preserved');
  assert.equal(h.adapter.loadReturnCheckpoint('home:following'),saved);
  assert.equal(h.adapter.loadReturnCheckpoint('home:for-you'),null);
  h.history.state = ['native array'];
  h.adapter.saveReturnCheckpoint('home:following',saved);
  assert.deepEqual(h.history.state,['native array']);
});
