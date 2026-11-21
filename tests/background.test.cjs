'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');

test('tab session record is ordered across reload, isolated from other tabs and feeds, and removed on close', async () => {
  const data = {};
  let listener, remove;
  const action = {onClicked:{addListener(){}}};
  vm.runInNewContext(code, {URL,chrome:{
    action,
    runtime:{onMessage:{addListener(fn){listener=fn}}},
    tabs:{onRemoved:{addListener(fn){remove=fn}}},
    storage:{session:{
      async get(key){return {[key]:structuredClone(data[key])}},
      async set(values){Object.assign(data,structuredClone(values))},
      async remove(key){delete data[key]}
    }}
  }});
  const sender = (id,url='https://x.com/home',frameId=0) => ({tab:{id},url,frameId});
  function call(from,op,key='home:following',position) {
    return new Promise(resolve => {
      const open = listener({type:'xfr-tab-reading',op,key,position},from,resolve);
      if (!open) resolve(null);
    });
  }
  const position = (id,updatedAt) => ({id,offset:80,scrollY:1000,updatedAt,href:'not stored'});
  const write = call(sender(1),'save','home:following',position('123',20));
  const reload = call(sender(1),'read');
  assert.equal((await reload).position.id,'123'); // first write wasn't awaited by the publisher
  await write;
  assert.equal((await call(sender(2),'read')).position,null);
  assert.equal((await call(sender(1),'read','home:for-you')).position,null);
  await call(sender(2),'save','home:following',position('456',40));
  await call(sender(1),'save','home:following',position('321',10)); // late older IPC
  assert.equal((await call(sender(1),'read')).position.id,'123');
  assert.equal((await call(sender(2),'read')).position.id,'456');
  assert.equal((await call(sender(1),'read')).position.href,undefined);
  assert.equal(await call(sender(1,'https://x.com/author/status/123'),'read'),null);
  assert.equal(await call(sender(1,'https://example.org/home'),'read'),null);
  assert.equal(await call(sender(1,'https://x.com/home',3),'read'),null);
  remove(1);
  assert.equal((await call(sender(1),'read')).position,null);
  assert.equal((await call(sender(2),'read')).position.id,'456');
});
