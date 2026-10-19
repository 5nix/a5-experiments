// 浏览器验收脚本：见 qa/browser/README.md。环境变量 A5_BASE、A5_RUNTIME_DIR、A5_QA_OUT、A5_PLAYWRIGHT。
import { mkdirSync as __mkdir } from 'node:fs';
const __out = process.env.A5_QA_OUT ?? '/tmp/a5-qa'; __mkdir(__out, { recursive: true });
const { chromium } = await import(process.env.A5_PLAYWRIGHT ?? 'playwright');
import { readFileSync } from 'node:fs';
const base = (process.env.A5_BASE ?? 'http://127.0.0.1:5174');
const A = async (path, init = {}) => (await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json' } })).json();
const c = await A('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ participant_id: '001' }) });
const browser = await chromium.launch({ channel: 'chrome' });
const errors = [];
for (const [w, hgt] of [[1280, 720], [1536, 864]]) {
  const page = await browser.newPage({ viewport: { width: w, height: hgt } }); page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base + c.participant_url);
  const ready = () => page.waitForSelector('.cmd-actions .btn:not([disabled])');
  await ready();
  if (w === 1280) { await page.click('.cmd-actions .btn'); await ready(); await page.click('.cmd-actions .btn'); await ready(); }
  await page.click('.attachment'); await page.waitForSelector('.attachment.opened'); await page.waitForTimeout(300);
  await page.click('.page-tools .btn.subtle'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${__out}/viewer-${w}.png` });
  if (w === 1280) {
    await page.click('#viewer .caption-btn.close'); await page.waitForTimeout(400);
    console.log('viewer closed:', await page.locator('#viewer.closed').count());
    await page.click('.attachment'); await page.waitForSelector('.attachment.opened'); await page.waitForTimeout(300);
    console.log('main close disabled:', await page.locator('#workbench .caption-btn.close').isDisabled());
  }
  if (w === 1536) console.log('restored after reload, viewer open:', await page.locator('#viewer:not(.closed)').count());
  await page.close();
}
const ev = (await A(`/api/admin/sessions/${c.session_id}/events`)).events.map(e => e.event_type + (e.payload?.open !== undefined ? `(${e.payload.open})` : ''));
console.log(ev.filter(t => /reveal|message_scheduled/.test(t)).join(' > '));
console.log('errors', errors);
await browser.close();
