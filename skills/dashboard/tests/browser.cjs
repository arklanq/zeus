// Development verification only. Requires Playwright and a local Chrome installation.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const script = path.resolve(__dirname, '../scripts/dashboard.mjs');
const session = 'browser-test-' + Date.now();
function cli(command, extra = [], input) {
  return JSON.parse(execFileSync(process.execPath, [script, command, '--session', session, ...extra], {input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8'}));
}
(async () => {
  const started = cli('start', ['--title', 'Import preview', '--goal', 'Validate the live work dashboard.']);
  let browser;
  try {
    browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {channel: 'chrome'})});
    const context = await browser.newContext({viewport: {width: 1280, height: 850}});
    await context.addInitScript(() => localStorage.setItem('dashboard-preferences', JSON.stringify({theme:'light',accent:'#ff0000'})));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const tasks = Array.from({length: 18}, (_, i) => ({id: 't' + i, title: ['Build the parsing pipeline', 'Inspect the import preview', 'Confirm the release'][i] || 'Verification case ' + i, status: i === 0 ? 'done' : i === 1 ? 'doing' : i === 2 ? 'blocked' : 'todo', ...(i === 0 ? {evidence: 'DEMO: 12 passing parsing checks.'} : i === 2 ? {blocker: 'Explicit release approval.'} : {})}));
    cli('update', [], {now: 'Implementing the import preview.', next: 'Run preview checks.', tasks, milestones: [{id: 'm1', title: 'Verified import preview', taskIds: ['t0', 't1'], proposed: true}], decisions: [{id: 'd1', title: 'Release approval', blocking: true}], events: [{at: new Date().toISOString(), text: 'DEMO data for browser verification.'}]});
    await page.goto(started.url);
    await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Połączono na żywo');
    assert.equal(await page.locator('.remaining-label strong').innerText(), '1');
    assert.match(await page.locator('.remaining-label').innerText(), /propozycja/i);
    const stageStates = await page.evaluate(() => {
      const tasks = [{id:'done',title:'Done',status:'done'}, {id:'blocked',title:'Blocked',status:'blocked'}];
      const roadmap = window.DashboardComponents.roadmap({tasks, milestones:[
        {id:'m1',title:'Complete',taskIds:['done']},
        {id:'m2',title:'Waiting',taskIds:['blocked']},
        {id:'m3',title:'Unconfirmed',taskIds:[]}
      ]});
      return [...roadmap.querySelectorAll('.stage')].map(node => node.className);
    });
    assert.deepEqual(stageStates, ['stage stage-done', 'stage stage-blocked', 'stage stage-unknown']);
    assert.equal(await page.locator('.content-time').count(), 0);
    assert.equal(await page.locator('.lrow').count(), 18);
    assert.equal(await page.locator('.is-changed').count(), 0);
    await page.locator('.stage-node').first().click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ledger-stage-m1');
    await page.waitForTimeout(600);
    await page.evaluate(() => scrollTo(0, 430));
    const scrollBefore = await page.evaluate(() => scrollY);
    const tick = Date.now();
    cli('update', [], {tasks: [{id: 't1', status: 'done', evidence: 'DEMO: preview checks passed.'}]});
    await page.waitForFunction(() => document.querySelector('[data-key="task:t1"] .status').textContent === 'Gotowe');
    const latency = Date.now() - tick;
    assert(latency < 2000, 'Browser update exceeded two seconds: ' + latency);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ledger-stage-m1');
    assert.match(await page.locator('[data-key="task:t1"]').innerText(), /preview checks passed/);
    assert(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) < 5, 'Scroll changed during data update.');
    assert.match(await page.locator('.milestone-complete').innerText(), /ukończone/);
    assert.equal(await page.locator('#theme, #accent').count(), 0);
    await page.emulateMedia({colorScheme:'light'});
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#bcaaff');
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    const screenshotDir = process.env.SCREENSHOT_DIR;
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, {recursive: true});
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({path: path.join(screenshotDir, 'dashboard-desktop.png'), fullPage: false});
    }
    await page.setViewportSize({width: 375, height: 812});
    await page.emulateMedia({colorScheme:'dark'});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile overflow.');
    if (screenshotDir) await page.screenshot({path: path.join(screenshotDir, 'dashboard-mobile.png'), fullPage: false});
    const custom = path.join(started.session, 'custom.js');
    fs.writeFileSync(custom + '.tmp', 'window.dashboardRender=(s,r,h)=>{r.append(h.element("p","CUSTOM VIEW"));h.defaultRender(s,r);const d=h.element("details");d.dataset.key="custom-detail";d.append(h.element("summary","More"),h.element("p","Context"));r.append(d);};');
    fs.renameSync(custom + '.tmp', custom);
    await page.waitForFunction(() => document.querySelector('main').textContent.includes('CUSTOM VIEW'));
    await page.locator('[data-key="custom-detail"] summary').click();
    const hostile = '</script><img src=x onerror="window.injected=true">';
    cli('update', [], {title: hostile});
    await page.waitForFunction(value => document.querySelector('h1').textContent === value, hostile);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('[data-key="custom-detail"]').getAttribute('open'), '');
    const exportPath = path.join(started.session, 'snapshot.html');
    cli('export', ['--output', exportPath]);
    const offline = await context.newPage();
    const requests = [];
    offline.on('request', request => {if (!request.url().startsWith('file:')) requests.push(request.url());});
    await offline.goto('file://' + exportPath);
    await offline.evaluate(() => document.fonts.ready);
    assert(await offline.evaluate(() => document.fonts.check('15px Manrope')), 'Offline font did not load.');
    assert.match(await offline.locator('main').innerText(), /CUSTOM VIEW/);
    assert.equal(await offline.locator('h1').innerText(), hostile);
    assert.equal(await offline.locator('#connection').innerText(), 'Zapis offline');
    assert.deepEqual(requests, []);
    const denied = await fetch(started.url + 'preferences', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://example.com'}, body: JSON.stringify({theme: 'dark'})});
    assert.equal(denied.status, 403);
    assert.equal((await fetch(started.url + '../state.json')).status, 404);
    cli('stop');
    const resumed = cli('start');
    assert.equal(cli('status').state.title, hostile);
    await page.goto(resumed.url);
    await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Połączono na żywo');
    assert.match(await page.locator('main').innerText(), /CUSTOM VIEW/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed: true, updateLatencyMs: latency, checks: ['live update', 'scroll and stage focus preserved', 'milestone count', 'fixed palette ignores saved and system appearance', 'mobile overflow', 'custom layout reload', 'escaped content', 'offline export no network', 'origin rejection', 'path isolation', 'server restart']}));
  } finally {
    if (browser) await browser.close();
    cli('stop');
  }
})().catch(error => {console.error(error);process.exit(1);});
