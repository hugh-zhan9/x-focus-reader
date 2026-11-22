'use strict';
// Real MV3 regression against an offline synthetic X page, never a signed-in
// session. Run with Playwright's bundled Chromium in an isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const target = 1012;
const deferredImagePath = '/__xfr_fixture/deferred-image.svg';
const deferredImageHeight = 240;
const deferredImage = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${deferredImageHeight}"><rect width="100%" height="100%" fill="teal"/></svg>`;
const slot = i => `<div data-testid="cellInnerDiv" id="cell-${i}" style="height:260px">` +
  `<article data-testid="tweet" style="height:100%;box-sizing:border-box" id="post-${i}">` +
  `<a id="open-${i}" href="/example/status/${i}"><time>Open ${i}</time></a>` +
  `<div data-testid="tweetText">Synthetic post ${i}</div></article></div>`;
const timeline = `<div role="tab" aria-selected="true">For you</div>` +
  Array.from({length:24}, (_,i) => slot(1001+i)).join('');
const fixture = `<!doctype html><meta charset=utf-8>
<style>html{overflow-anchor:none}body{margin:0}#primary{width:600px}article{border-bottom:1px solid gray}</style>
<nav style="position:fixed;right:0;top:0"><a data-testid="AppTabBar_Home_Link" href="/home">Home</a></nav>
<main><div id="primary" data-testid="primaryColumn"></div></main>
<script>
const primary = document.getElementById('primary');
const target = ${target};
const timeline = ${JSON.stringify(timeline)};
const targetCell = 'cell-' + target;
const scenario = new URLSearchParams(location.search).get('case');
history.scrollRestoration = scenario === 'native-auto' ? 'auto' : 'manual';
function detail() {
  primary.innerHTML = '<button type="button" data-testid="app-bar-back">Back</button><article><p>Synthetic detail</p></article>';
  window.scrollTo(0,0);
}
function home(returning) {
  primary.innerHTML = timeline;
  if (!returning) return;
  if (scenario.startsWith('delayed-image')) {
    // No dimensions are reserved before the image loads: Chromium must use
    // its intrinsic dimensions and naturally shift the following rows.
    const image = document.createElement('img');
    image.id = 'fixture-delayed-image';
    image.alt = '';
    image.style.display = 'block';
    document.getElementById('cell-1008').after(image);
    image.src = ${JSON.stringify(deferredImagePath)};
  }
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
  if (['app-bar','home-link','native-auto'].includes(scenario)) {
    const row = document.getElementById(targetCell).firstElementChild;
    const link = row.querySelector('a');
    link.href = '/example/status/9999';
    setTimeout(() => { link.href = '/example/status/' + target; },130);
    setTimeout(() => {
      document.getElementById('cell-1008').style.height='540px';
      document.documentElement.dataset.fixtureReturnReady = 'yes';
    },315);
  }
  if (scenario === 'virtual-remount') {
    const cell = document.getElementById(targetCell);
    const post = cell.firstElementChild;
    const tab = primary.querySelector('[role="tab"]');
    // X can briefly reattach the previous window, then replace it and
    // remount the exact card with a different virtual coordinate.
    setTimeout(() => { post.remove(); tab.setAttribute('aria-selected','false'); },180);
    setTimeout(() => { tab.setAttribute('aria-selected','true'); window.scrollBy(0,1418); },430);
    setTimeout(() => {
      document.getElementById('cell-1008').style.height='540px';
      cell.append(post);
      document.documentElement.dataset.fixtureReturnReady = 'yes';
    },2100);
  }
  if (scenario.startsWith('late-discovery')) {
    const cell = document.getElementById(targetCell);
    const post = cell.firstElementChild;
    post.remove();
    // Recorded live shape: X makes several native scroll adjustments while
    // the original post is not mounted, then its row returns off-center.
    setTimeout(() => window.scrollTo(0,2100),300);
    setTimeout(() => window.scrollTo(0,1700),870);
    setTimeout(() => window.scrollTo(0,2250),1350);
    setTimeout(() => {
      cell.append(post);
      document.documentElement.dataset.fixtureReturnReady = 'yes';
    },3500);
  }
}
if (location.pathname.includes('/status/')) detail(); else home(false);
window.addEventListener('popstate',() => {if(location.pathname==='/home') home(true); else detail();});
document.addEventListener('click', e => {
  if(e.target.closest('[data-testid="app-bar-back"]')) return history.back();
  const link=e.target.closest('a');
  if(!link) return;
  e.preventDefault();
  if(link.dataset.testid === 'AppTabBar_Home_Link') {
    history.pushState({},'',link.getAttribute('href'));
    home(true);
    return;
  }
  history.pushState({},'',link.getAttribute('href'));
  detail();
});
</script>`;

(async () => {
  const ext = path.resolve(__dirname,'../../extension');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'xfr-browser-test-'));
  let ctx, imageArrived, releaseImage;
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      channel:'chromium', headless:true, viewport:{width:1100,height:800},
      ...(process.env.XFR_TEST_CHROMIUM ? {executablePath:process.env.XFR_TEST_CHROMIUM} : {}),
      args:[`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
    });
    await ctx.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://x.com' && url.pathname === deferredImagePath && route.request().resourceType() === 'image') {
        assert.ok(imageArrived && releaseImage, 'unexpected fixture image request');
        imageArrived.notify();
        await releaseImage.promise;
        return route.fulfill({contentType:'image/svg+xml',headers:{'cache-control':'no-store'},body:deferredImage});
      }
      return url.origin === 'https://x.com' && route.request().isNavigationRequest()
        ? route.fulfill({contentType:'text/html',body:fixture})
        : route.abort();
    });
    const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker',{timeout:10000});
    assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().name),'X Focus Reader');
    const scenarios = ['late-scroll','layout','delayed-target','manual','app-bar','home-link','native-auto','virtual-remount',
      'late-discovery','late-discovery-manual','delayed-image','delayed-image-manual'];
    for (const scenario of process.argv.length > 2 ? process.argv.slice(2) : scenarios) {
      assert.ok(scenarios.includes(scenario), `unknown scenario: ${scenario}`);
      const realImage = scenario.startsWith('delayed-image');
      if (realImage) {
        const waitGate = () => {
          let notify;
          const promise = new Promise(resolve => { notify = resolve; });
          return {promise,notify};
        };
        imageArrived = waitGate();
        releaseImage = waitGate();
      }
      const page = await ctx.newPage();
      await page.goto(`https://x.com/home?case=${scenario}`);
      await page.waitForSelector('.xfr-control',{state:'attached'});
      await page.locator(`#post-${target}`).evaluate((el, native) => {
        if (native) window.scrollBy(0, el.getBoundingClientRect().top - 140);
        else el.scrollIntoView({block:'center'});
      },scenario === 'native-auto');
      await page.locator(`#open-${target}`).click();
      await page.waitForURL(`https://x.com/example/status/${target}`);
      await page.locator('article').innerText();
      // Give the content script the same opportunity to observe the detail
      // as when a reader spends time there before going back.
      if (scenario !== 'app-bar') await page.waitForTimeout(120);
      if (['app-bar','virtual-remount'].includes(scenario) || scenario.startsWith('late-discovery'))
        await page.getByTestId('app-bar-back').click();
      else if (scenario === 'home-link') await page.getByTestId('AppTabBar_Home_Link').click();
      else await page.goBack();
      await page.waitForURL(scenario === 'home-link' ? 'https://x.com/home' : `https://x.com/home?case=${scenario}`);
      if (scenario === 'native-auto') assert.equal(await page.evaluate(() => history.scrollRestoration), 'auto');
      let retainedY;
      if (scenario === 'late-discovery-manual') {
        await page.waitForFunction(() => window.scrollY === 2250);
        await page.mouse.move(200,320);
        await page.mouse.wheel(0,170);
        await page.waitForFunction(() => window.scrollY >= 2410);
        retainedY = await page.evaluate(() => window.scrollY);
      }
      if (['app-bar','home-link','native-auto','virtual-remount'].includes(scenario)) {
        await page.waitForSelector('html[data-fixture-return-ready="yes"]',{state:'attached'});
      }
      if (scenario.startsWith('late-discovery')) {
        await page.waitForSelector('html[data-fixture-return-ready="yes"]',{state:'attached'});
      }
      if (realImage) {
        // An observed request is held by Playwright until both an initial
        // alignment and, for the manual case, trusted wheel input are proven.
        const measure = () => page.locator(`#post-${target}`).evaluate(el => {
          const r=el.getBoundingClientRect();
          const image=document.getElementById('fixture-delayed-image');
          return { y:scrollY, top:r.top, centerError:(r.top+r.bottom)/2-innerHeight/2,
            imageHeight:image.getBoundingClientRect().height, naturalHeight:image.naturalHeight };
        });
        await page.waitForSelector('#fixture-delayed-image',{state:'attached'});
        await page.waitForFunction(id => {
          const el=document.getElementById(id), r=el?.getBoundingClientRect();
          return r && Math.abs((r.top+r.bottom)/2-innerHeight/2)<=4;
        }, `post-${target}`, {timeout:5000});
        const noImage = await measure();
        assert.equal(noImage.naturalHeight,0,'image must not be loaded at initial alignment');
        assert.equal(noImage.imageHeight,0,'image must not initially occupy vertical space');
        if (scenario === 'delayed-image-manual') {
          await page.mouse.move(200,320);
          await page.mouse.wheel(0,175);
          await page.waitForFunction(y=>scrollY>=y+160,noImage.y,{timeout:5000});
        }
        const before = await measure();
        let requestTimeout;
        try {
          await Promise.race([imageArrived.promise, new Promise((_, reject) => {
            requestTimeout = setTimeout(() => reject(new Error('fixture image request did not arrive')), 5000);
          })]);
        } finally { clearTimeout(requestTimeout); }
        releaseImage.notify();
        await page.waitForFunction(h=>document.getElementById('fixture-delayed-image')?.naturalHeight===h,deferredImageHeight,{timeout:5000});
        await page.waitForTimeout(650);
        const after = await measure();
        assert.equal(after.imageHeight,deferredImageHeight,'intrinsic image height must change flow');
        if (scenario === 'delayed-image-manual') {
          assert.ok(Math.abs(after.y-before.y)<=3,'image must not override the user’s wheel scroll');
          assert.ok(Math.abs((after.top-before.top)-deferredImageHeight)<=4,'uncorrected post must move with the loaded image');
          assert.ok(Math.abs(after.centerError)>20,'manual scenario must not accidentally end at center');
        } else {
          assert.ok(Math.abs(after.centerError)<=4,`image moved the exact post ${after.centerError}px off center`);
          assert.ok(Math.abs((after.y-before.y)-deferredImageHeight)<=4,'scroll must compensate for the intrinsic layout shift');
        }
        console.log(`Image geometry: ${scenario}: ${JSON.stringify({before,after})}`);
        imageArrived = releaseImage = null;
      } else if (scenario === 'late-discovery-manual') {
        await page.waitForTimeout(650);
        assert.ok(Math.abs((await page.evaluate(() => window.scrollY))-retainedY)<=3,
          'late discovery must not override manual scrolling');
      } else if (scenario === 'manual') {
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
    releaseImage?.notify();
    if (ctx) await ctx.close();
    fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
