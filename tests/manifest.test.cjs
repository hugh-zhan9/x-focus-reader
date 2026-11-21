'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname,'..','extension');
const manifest = JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
test('Manifest v3 limits injection to x.com and only requests local storage', () => {
  assert.equal(manifest.manifest_version,3);
  assert.deepEqual(manifest.permissions,['storage']);
  for(const script of manifest.content_scripts) {
    assert.deepEqual(script.matches,['https://x.com/*']);
    assert.equal(script.world,undefined);
    assert.equal(script.all_frames,undefined);
    for(const file of [...script.js,...script.css]) assert.ok(fs.statSync(path.join(dir,file)).isFile());
  }
  assert.equal(manifest.host_permissions,undefined);
  assert.equal(manifest.optional_permissions,undefined);
  assert.ok(fs.statSync(path.join(dir,manifest.background.service_worker)).isFile());
  assert.ok(fs.statSync(path.join(dir,manifest.options_ui.page)).isFile());
});
test('Chrome uses packaged PNG icons at the declared sizes', () => {
  assert.deepEqual(Object.keys(manifest.icons), ['16','32','48','128']);
  assert.deepEqual(manifest.action.default_icon, {'16': manifest.icons['16'], '32': manifest.icons['32']});
  for (const [size, file] of Object.entries(manifest.icons)) {
    const png = fs.readFileSync(path.join(dir, file));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
});
test('No pack-in telemetry, cookie API, or remote network requests', () => {
  for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.js'))) {
    const source=fs.readFileSync(path.join(dir,name),'utf8');
    assert.doesNotMatch(source,/\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon\s*\(|document\.cookie|chrome\.cookies|storage\.sync)/,name);
  }
});
