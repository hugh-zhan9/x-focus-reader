'use strict';
// Real MV3 regression against an offline synthetic X page, never a signed-in
// session. Run with Playwright's bundled Chromium in an isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const target = 1012;
const slot = i => `<div data-testid="cellInnerDiv" id="cell-${i}" style="height:260px">` +
  `<article data-testid="tweet" style="height:100%;box-sizing:border-box" id="post-${i}">` +
  `<a id="open-${i}" href="/example/status/${i}"><time>Open ${i}</time></a>` +
  `<div data-testid="tweetText">Synthetic post ${i}</div></article></div>`;
const timeline = `<div role="tab" aria-selected="true">For you</div>` +
  Array.from({length:24}, (_,i) => slot(1001+i)).join('');
const fixture = `<!doctype html><meta charset=utf-8>
<style>html{overflow-anchor:none}body{margin:0}#primary{width:600px}article{border-bottom:1px solid gray}</style>
<main><div id="primary" data-testid="primaryColumn"></div></main>
<script>
const primary = document.getElementById('primary');
const target = ${target};
const timeline = ${JSON.stringify(timeline)};
const targetCell = 'cell-' + target;
const scenario = new URLSearchParams(location.search).get('case');
history.scrollRestoration = 'manual';
function detail() {
  primary.innerHTML = '<article><p>Synthetic detail</p></article>';
  window.scrollTo(0,0);
}
function home(returning) {
  primary.innerHTML = timeline;
  if (!returning) return;
  if (scenario === 'late-scroll') setTimeout(() => window.scrollTo(0,0),120);
  if (scenario === 'layout') setTimeout(() => {
    document.getElementById('cell-1008').style.height='540px';
  },120);
  if (scenario === 'delayed-target') {
    const cell = document.getElementById(targetCell);
    const post = cell.firstElementChild;
    post.remove();
    setTimeout(() => cell.append(post),200);
    setTimeout(() => {document.getElementById('cell-1008').style.height='540px';},370);
  }
}
if (location.pathname.includes('/status/')) detail(); else home(false);
window.addEventListener('popstate',() => {if(location.pathname==='/home') home(true); else detail();});
document.addEventListener('click', e => {
  const link=e.target.closest('a');
  if(!link) return;
  e.preventDefault();
  history.pushState({},'',link.getAttribute('href'));
  detail();
});
</script>`;

(async () => {
  const ext = path.resolve(__dirname,'../../extension');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'xfr-browser-test-'));
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      channel:'chromium', headless:true, viewport:{width:1100,height:800},
      ...(process.env.XFR_TEST_CHROMIUM ? {executablePath:process.env.XFR_TEST_CHROMIUM} : {}),
      args:[`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
    });
    await ctx.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === 'https://x.com' && route.request().isNavigationRequest()
        ? route.fulfill({contentType:'text/html',body:fixture})
        : route.abort();
    });
    const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker',{timeout:10000});
    assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().name),'X Focus Reader');
    for (const scenario of ['late-scroll','layout','delayed-target','manual']) {
      const page = await ctx.newPage();
      await page.goto(`https://x.com/home?case=${scenario}`);
      await page.waitForSelector('.xfr-control',{state:'attached'});
      await page.locator(`#post-${target}`).evaluate(el => el.scrollIntoView({block:'center'}));
      await page.locator(`#open-${target}`).click();
      await page.waitForURL(`https://x.com/example/status/${target}`);
      await page.locator('article').innerText();
      // Give the content script the same opportunity to observe the detail
      // as when a reader spends time there before going back.
      await page.waitForTimeout(120);
      await page.goBack();
      await page.waitForURL(`https://x.com/home?case=${scenario}`);
      if (scenario === 'manual') {
        await page.waitForFunction(() => window.scrollY > 1800);
        const before = await page.evaluate(() => window.scrollY);
        await page.mouse.move(200,320);
        await page.mouse.wheel(0,420);
        await page.waitForFunction(old => window.scrollY >= old+400,before);
        const userY = await page.evaluate(() => window.scrollY);
        await page.waitForTimeout(750);
        assert.ok(Math.abs((await page.evaluate(() => window.scrollY))-userY)<=3,'manual scroll must win');
      } else {
        await page.waitForTimeout(1050);
        const delta = await page.locator(`#post-${target}`).evaluate(el => {
          const r=el.getBoundingClientRect(); return Math.abs((r.top+r.bottom)/2-innerHeight/2);
        });
        assert.ok(delta<=4,`${scenario}: card center is ${delta}px off`);
      }
      console.log(`Back regression: ${scenario} passed`);
      await page.close();
    }
  } finally {
    if (ctx) await ctx.close();
    fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
