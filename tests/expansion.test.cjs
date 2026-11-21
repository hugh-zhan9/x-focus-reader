'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({URL});
for (const f of ['media.js','text-expand.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','extension',f),'utf8'),context);
}
const {XFRMedia:media,XFRTextExpand:textExpand} = context;
const origin = 'https://x.com';
const make = (tag, attrs = {}, kids = []) => new El(tag, attrs, kids);
class El {
  constructor(tag, attrs, kids) {
    this.tag=tag; this.attrs=attrs; this.children=[]; this.parentElement=null;
    this.isConnected=true; this.handlers={}; this.clicks=0;
    this.ownerDocument={createElement:make, defaultView:{getComputedStyle(el) {
      return el.geometry || {display:'block',position:'static',overflowY:'visible'};
    }}};
    this.rect={width:0,height:0,top:0,bottom:0};
    this.append(...kids);
  }
  getBoundingClientRect() { return this.rect; }
  get textContent() { return this.children.map(c => c.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement=this; this.children.push(node); } }
  insertBefore(node, ref) { node.remove(); node.parentElement=this; this.children.splice(this.children.indexOf(ref),0,node); }
  remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this),1); this.parentElement=null; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  hasAttribute(key) { return Object.hasOwn(this.attrs,key); }
  setAttribute(key,val) { this.attrs[key]=val; }
  removeAttribute(key) { delete this.attrs[key]; }
  matches(list) {
    return list.split(',').some(rule => {
      const m=/^([\w-]+)?(?:\[([\w-]+)(?:([*]?=)"([^"]*)"( i)?)?\])?$/.exec(rule);
      if (!m) throw Error('Unsupported test selector: '+rule);
      if (m[1] && m[1] !== this.tag) return false;
      if (!m[2]) return true;
      let actual=this.getAttribute(m[2]);
      if (actual === null) return false;
      let expected=m[4];
      if (m[5]) { actual=actual.toLowerCase(); expected=expected.toLowerCase(); }
      return !m[3] || (m[3]==='=' ? actual===expected : actual.includes(expected));
    });
  }
  closest(sel) { return this.matches(sel) ? this : this.parentElement?.closest(sel) || null; }
  querySelectorAll(sel) { return this.children.flatMap(c => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
  querySelector(sel) {return this.querySelectorAll(sel)[0] || null;}
  contains(node) { for(let n=node;n;n=n.parentElement) if(n===this) return true; return false; }
  addEventListener(key,fn) { this.handlers[key]=fn; }
  click() { this.clicks++; }
}
const article = (...kids)=>make('article',{'data-testid':'tweet'},kids);
function slide(index, src, post='12', extra={}) {
  return make('a',{href:'/example/status/'+post+'/photo/'+index,...extra},[
    make('div',{'data-testid':'tweetPhoto'},[make('img',{src,alt:'image '+index})])
  ]);
}
const src = (id,name='small') => 'https://pbs.twimg.com/media/img'+id+'?format=png&name='+name;
const body = () => make('div',{'data-testid':'tweetText'});
const findGallery = a => a.children.find(n=>n.className==='xfr xfr-gallery');

test('carousel photos become a single natural-size inline stack in photo order, retaining native links',()=>{
  const first=slide(1,src(1,'thumb')), second=slide(2,src(2));
  const carousel=make('div',{'data-testid':'ScrollSnap-List'},[second,first]);
  const a=article(body(),make('div',{},[carousel]),make('button'));
  media.show(a,'12',origin);
  const inline=findGallery(a);
  assert.ok(inline);
  assert.deepEqual(inline.children.map(e=>e.children[0].src),[src(1,'large'),src(2)]);
  assert.deepEqual(inline.children.map(e=>e.children[0].alt),['image 1','image 2']);
  assert.equal(inline.children[0].children[0].loading,'lazy');
  assert.ok(carousel.parentElement.hasAttribute('data-xfr-native-photos'));
  let prevented=false;
  inline.children[0].handlers.click({button:0,stopPropagation(){},preventDefault(){prevented=true;}});
  assert.ok(prevented);
  assert.equal(first.clicks,1);
  media.show(a,'12',origin);
  assert.equal(findGallery(a),inline);
  media.prune(new Set());
  assert.equal(findGallery(a),undefined);
  assert.ok(!carousel.parentElement.hasAttribute('data-xfr-native-photos'));
});

test('single long photo keeps a non-cropped source; errors restore the original without remount loops',()=>{
  const native=make('div',{},[slide(1,src(1,'240x240'))]);
  const a=article(body(),native);
  media.show(a,'12',origin);
  const img=findGallery(a).children[0].children[0];
  assert.equal(img.src,src(1,'large'));
  img.handlers.error();
  assert.equal(findGallery(a),undefined);
  assert.ok(!native.hasAttribute('data-xfr-native-photos'));
  media.show(a,'12',origin);
  assert.equal(findGallery(a),undefined);
});

test('partial carousels, quoted/foreign media and gated media keep native rendering',()=>{
  const a=article(body(),make('div',{'data-testid':'ScrollSnap-List'},[slide(1,src(1))]));
  const b=article(body(),make('div',{'data-testid':'quoteTweet'},[slide(1,src(1))]));
  const c=article(body(),slide(1,src(1)),make('div',{'data-testid':'sensitiveMediaWarning'}));
  const d=article(body(),slide(1,'https://evil.example/media/a?name=thumb'));
  const e=article(body(),make('div',{'data-testid':'ScrollSnap-List'},[slide(1,src(1)),slide(2,src(2)),make('a',{href:'/example/status/12/photo/3'})]));
  const f=article(body(),make('div',{},[slide(1,src(1)),slide(2,src(2)),make('video')]));
  for(const item of [a,b,c,d,e,f]) {
    media.show(item,'12',origin);
    assert.equal(findGallery(item),undefined);
    assert.equal(item.querySelector('[data-xfr-native-photos]'),null);
  }
});

test('Show more activates only native inline controls, once for each post after recycling',()=>{
  const attrs={'data-testid':'tweet-text-show-more-link'};
  const unsafe=make('a',{...attrs,href:'/user/status/12'});
  const generic=make('button');
  const quoted=make('button',attrs);
  const ok=make('button',attrs);
  const a=article(unsafe,generic,make('div',{'data-testid':'quoteTweet'},[quoted]),ok);
  a.setAttribute('data-xfr-collapsed','');
  assert.equal(textExpand.expand(a,'12'),false);
  a.removeAttribute('data-xfr-collapsed');
  assert.equal(textExpand.expand(a,'12'),true);
  assert.equal(textExpand.expand(a,'12'),false);
  assert.equal(textExpand.expand(a,'13'),true);
  assert.equal(textExpand.expand(a,'12'),false);
  assert.equal(ok.clicks,2);
  assert.equal(unsafe.clicks,0);
  assert.equal(generic.clicks,0);
  assert.equal(quoted.clicks,0);
});


test('gallery is inserted after the text and outside a constrained, positioned media wrapper',()=>{
  const text=body();
  const native=slide(1,src(1));
  const internal=make('div',{},[native]);
  internal.geometry={display:'block',position:'absolute',overflowY:'hidden'};
  const skin=make('div',{},[internal,make('button')]);
  const action=make('button',{'data-testid':'reply'});
  const a=article(text,skin,action);
  media.show(a,'12',origin);
  const gallery=findGallery(a);
  assert.deepEqual(a.children,[text,gallery,skin,action]);
  assert.equal(internal.querySelector('img').getAttribute('src'),src(1));
  assert.ok(internal.hasAttribute('data-xfr-native-photos'));
  a.rect={width:600,height:400,top:0,bottom:400};
  text.rect={width:550,height:80,top:50,bottom:130};
  action.rect={width:20,height:20,top:370,bottom:390};
  gallery.rect={width:550,height:500,top:50,bottom:550};
  gallery.children[0].children[0].handlers.load();
  assert.deepEqual(a.children,[text,skin,action]);
  assert.ok(!internal.hasAttribute('data-xfr-native-photos'));
  media.show(a,'12',origin);
  assert.equal(findGallery(a),undefined);
});

test('native layout retained when no safe vertical slot follows the text',()=>{
  const native=slide(1,src(1));
  const column=make('div',{},[body(),native]);
  column.geometry={display:'flex',flexDirection:'row',position:'static',overflowY:'visible'};
  const a=article(column);
  media.show(a,'12',origin);
  assert.equal(a.querySelector('[data-xfr-native-photos]'),null);
  assert.deepEqual(column.children.map(node=>node.tag),['div','a']);
});
