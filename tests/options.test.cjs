'use strict';
const {test}=require('node:test');
const dir=require('node:path').join(__dirname,'..','extension');
const assert=require('node:assert/strict'), vm=require('node:vm'),fs=require('node:fs');
class El {
 constructor(id){this.id=id;this.value='';this.children=[];this.checked=false;this.dataset={};this.events={};this.button={};}
 addEventListener(type,cb){this.events[type]=cb} setAttribute(){} focus(){}
 append(...els){this.children.push(...els)} replaceChildren(){this.children=[]}
 querySelector(){return this.button} showModal(){this.open=true} close(){this.open=false;this.events.close?.()}
 fire(type){return this.events[type]({currentTarget:this,preventDefault(){}})}
}
const el={},get=id=>el[id]||(el[id]=new El(id));
const choices=(name,values)=>values.map(v=>Object.assign(new El(name+v),{value:v}));
const preset=choices('preset',['following','clean','original']), media=choices('media',['image','video','gif','text','link']);
const nodes={settings:{unknownField:'retained'},'reading:following':{id:'1'}};
let writes=0,listener;
const c=vm.createContext({document:{getElementById:get,createElement:t=>new El(t),querySelectorAll:s=>{
 if(s.includes('preset'))return preset.filter(e=>!s.includes(':checked')||e.checked);
 if(s.includes('media'))return media.filter(e=>!s.includes(':checked')||e.checked);
 return ['reading-form','rules-form','blacklist-form'].map(id=>get(id).button).concat(get('export'),get('import'));
}},chrome:{storage:{local:{async get(key){return {[key]:nodes[key]}},async set(data){const oldValue=nodes.settings;Object.assign(nodes,data);writes++;listener({settings:{oldValue,newValue:nodes.settings}},'local')}},onChanged:{addListener(l){listener=l}}}},Date});
for(const file of ['rules.js','reading.js','options.js'])vm.runInContext(fs.readFileSync(dir+'/'+file,'utf8'),c);
test('settings: expiry, shortcut validation, rule writes and confirmed isolated import',async()=>{
 await new Promise(setImmediate);
 assert.equal(get('key-next').value,'j');
 get('blocked-handle').value='@MixedCase';get('block-duration').value='day';
 await get('blacklist-form').fire('submit');
 assert.equal(nodes.settings.blockedAuthors[0].handle,'mixedcase');
 assert(nodes.settings.blockedAuthors[0].expiresAt>Date.now());
 get('key-next').value='k';
 await get('reading-form').fire('submit');
 assert.match(get('status').textContent,/同一个/);
 assert.equal(writes,1);
 get('key-next').value='';get('shortcuts-enabled').checked=false;
 await get('reading-form').fire('submit');
 assert.equal(nodes.settings.shortcuts.next,'');
 assert.equal(nodes.settings.shortcutsEnabled,false);
 get('keywords').value=' promo\nClean ';get('whitelisted').value='@Friend';get('filter-quoted').checked=true;
 await get('rules-form').fire('submit');
 assert.equal(nodes.settings.keywords.join(','),'promo,clean');assert.equal(nodes.settings.whitelistedAuthors[0],'friend');
 assert.equal(nodes.settings.blockedAuthors[0].handle,'mixedcase');
 const invalid={version:1,settings:{...nodes.settings,filterQuotedAuthors:'yes'}};
 let put=payload=>{get('import').files=[{size:JSON.stringify(payload).length,text:async()=>JSON.stringify(payload)}];return get('import').fire('change')};
 await put(invalid);assert.equal(get('import-dialog').open,undefined);assert.match(get('status').textContent,/无效/);
 await put({version:1,settings:{...nodes.settings,preset:'original',unknownField:'injected'}});
 assert.equal(nodes.settings.preset,'following');
 assert.equal(get('import-dialog').open,true);
 await get('confirm-import').fire('click');
 assert.equal(nodes.settings.preset,'original');
 assert.equal(nodes.settings.unknownField,'retained');
 assert.equal(nodes['reading:following'].id,'1');
 assert.equal(writes,4);
});
