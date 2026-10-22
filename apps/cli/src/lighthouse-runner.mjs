import fs from 'node:fs';
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';
import { chromium } from 'playwright';

const [url, strategy, reportPath] = process.argv.slice(2);
if (!url || !['mobile', 'desktop'].includes(strategy) || !reportPath) {
  throw new Error('Usage: lighthouse-runner.mjs <url> <mobile|desktop> <report-path>');
}

const mobile = strategy === 'mobile';
const chrome = await launch({
  chromePath: chromium.executablePath(),
  chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const result = await lighthouse(url, {
    port: chrome.port,
    output: 'json',
    logLevel: 'error',
    onlyCategories: ['performance', 'accessibility'],
    formFactor: strategy,
    screenEmulation: mobile
      ? { mobile: true, width: 375, height: 812, deviceScaleFactor: 1, disabled: false }
      : { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
    throttlingMethod: 'simulate',
    blockedUrlPatterns: ['*pagead*', '*doubleclick*', '*adsbygoogle*', '*googletagmanager*', '*google-analytics*'],
  });
  if (!result) throw new Error('Lighthouse returned no result.');
  fs.writeFileSync(reportPath, JSON.stringify(result.lhr));
} finally {
  await chrome.kill();
}
