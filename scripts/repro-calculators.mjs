import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const cases = [
  { slug: 'compound-interest', fields: [['#compound-interest-principal', '12345.67'], ['#compound-interest-rate', '6.25'], ['#compound-interest-years', '3.5']], select: ['#compound-interest-frequency', '12'], button: /계산하기/ },
  { slug: 'simple-interest', fields: [['#simple-interest-principal', '12345.67'], ['#simple-interest-rate', '6.25'], ['#simple-interest-years', '3.5']], button: /계산하기/ },
  { slug: 'percentage', fields: [['#percentage-a', '271'], ['#percentage-b', '17']], button: /계산하기/ },
];
const root = path.resolve('reports', new Date().toISOString().slice(0, 10), `calculator-repro-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const test of cases) for (let repetition = 1; repetition <= 2; repetition++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || url.pathname.startsWith('/api/')) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const pageErrors = [], consoleErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    const tracePath = path.join(root, `${test.slug}-${repetition}.zip`);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const url = `https://www.woori.today/ko/calculators/${test.slug}`;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('body').waitFor({ state: 'visible' });
    const before = await page.locator('body').innerText();
    for (const [selector, value] of test.fields) {
      const field = page.locator(selector);
      await field.focus();
      await field.fill(value);
      await field.blur();
    }
    if (test.select) await page.locator(test.select[0]).selectOption(test.select[1]);
    const inputState = await page.locator('input,select').evaluateAll(elements => elements.map(element => ({ id: element.id, value: element.value, type: element.type, disabled: element.disabled })));
    await page.getByRole('button', { name: test.button }).click();
    await page.waitForTimeout(1200);
    const after = await page.locator('body').innerText().catch(() => 'body unavailable');
    const safe = test.slug + '-' + repetition;
    const screenshot = path.join(root, `${safe}.png`);
    const dom = path.join(root, `${safe}.html`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    fs.writeFileSync(dom, await page.locator('body').evaluate(el => el.outerHTML).catch(() => ''), 'utf8');
    await context.tracing.stop({ path: tracePath });
    results.push({ url, repetition, httpStatus: response?.status() ?? null, inputOrder: test.fields.map(([selector, value]) => ({ selector, value, eventMethod: 'focus -> Playwright fill (input/change) -> blur' })), inputState, calculateEnabled: await page.getByRole('button', { name: test.button }).isEnabled().catch(() => false), pageErrors, consoleErrors, errorBoundaryVisible: /This page couldn't load/i.test(after), bodyBefore: before.slice(-1200), bodyAfter: after.slice(-1600), screenshot, dom, trace: tracePath });
    await context.close();
  }
} finally { await browser.close(); }
fs.writeFileSync(path.join(root, 'reproduction.json'), JSON.stringify({ createdAt: new Date().toISOString(), note: 'Read-only GET navigation; POST/PUT/PATCH/DELETE and /api/ blocked; two repetitions per route.', results }, null, 2));
console.log(JSON.stringify({ root, runs: results.length, routes: [...new Set(results.map(item => item.url))], pageErrors: results.map(item => item.pageErrors) }, null, 2));
