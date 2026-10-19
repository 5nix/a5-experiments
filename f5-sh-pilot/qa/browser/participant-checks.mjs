// 浏览器验收脚本：见 qa/browser/README.md。环境变量 A5_BASE、A5_RUNTIME_DIR、A5_QA_OUT、A5_PLAYWRIGHT。
import { mkdirSync as __mkdir } from 'node:fs';
const __out = process.env.A5_QA_OUT ?? '/tmp/a5-qa'; __mkdir(__out, { recursive: true });
const { chromium } = await import(process.env.A5_PLAYWRIGHT ?? 'playwright');
import { readFileSync, mkdirSync } from 'node:fs';
const base = (process.env.A5_BASE ?? 'http://127.0.0.1:5174');
const out = __out + '/checks'; mkdirSync(out, { recursive: true });
const A = async (path, init = {}) => (await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json' } })).json();
const pid = process.env.PID ?? '001';
const created = await A('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ participant_id: pid }) });
if (!created.session_id) { console.log(created); process.exit(1); }
const sid = created.session_id;
const browser = await chromium.launch({ channel: 'chrome' });
const errors = [];
const open = async (w, h) => { const p = await browser.newPage({ viewport: { width: w, height: h } }); p.on('pageerror', e => errors.push(String(e))); p.on('console', m => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text())); await p.goto(base + created.participant_url); return p; };
const ready = p => p.waitForSelector('.cmd-actions .btn:not([disabled])');
let page = await open(1366, 768);
await ready(page);
console.log('debug tray (expect 0):', await page.locator('.tray-btn').count());
await page.click('.cmd-actions .btn'); await ready(page); await page.click('.cmd-actions .btn'); await ready(page);
// U1: notepad floating at 1366
await page.click('.page-tools .btn.subtle');
await page.fill('.note-text', '第一单元草稿\n4.6+0.18');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/1366-notepad.png` });
// answer partially then reload
await page.locator('[data-field="plans"] .choice').nth(1).click();
await page.waitForTimeout(300);
await page.reload(); await ready(page);
console.log('after reload: checked B =', await page.locator('[data-field="plans"] input[value="B"]').isChecked(), 'notepad text =', JSON.stringify(await page.inputValue('.note-text')));
// submit without reveal -> server 422
await page.click('.cmd-actions .btn.accent'); await page.waitForTimeout(500);
console.log('422 message:', await page.textContent('.cmd-error'));
await page.screenshot({ path: `${out}/1366-reveal-required.png` });
// exclusive
await page.locator('[data-field="plans"] .choice').nth(4).click();
console.log('exclusive: B unchecked =', !(await page.locator('[data-field="plans"] input[value="B"]').isChecked()));
await page.locator('[data-field="plans"] .choice').nth(0).click();
console.log('exclusive: NONE unchecked =', !(await page.locator('[data-field="plans"] input[value="NONE"]').isChecked()));
await page.click('.attachment'); await page.waitForSelector('.attachment.opened'); await page.waitForTimeout(400);
// fast type in notepad then submit immediately
await page.click('.page-tools .btn.subtle');
await page.fill('.note-text', '提交前最后输入');
await page.click('.cmd-actions .btn.accent');
await page.waitForFunction(() => document.querySelector('.eyebrow')?.textContent.includes('第2'));
await page.waitForTimeout(500);
const ev = (await A(`/api/admin/sessions/${sid}/events`)).events;
const lastScratch = ev.filter(e => e.event_type === 'scratchpad_changed').at(-1);
console.log('last scratch saved:', JSON.stringify(lastScratch?.payload?.text ?? lastScratch?.text ?? lastScratch));
const order = ev.map(e => e.event_type).filter(t => /reveal_displayed|u2_displayed|unit_displayed|message_scheduled|unit_submitted|submit/.test(t));
console.log('order:', order.join(' > '));
console.log('U2 notepad empty:', JSON.stringify(await page.inputValue('.note-text')));
// invalid time format on U2? U2 SH01 has money; use bad money
await page.fill('[data-field="A"] input', '1.234'); for (const f of ['B','C','D']) await page.fill(`[data-field="${f}"] input`, '0');
await page.locator('[data-field="plans"] .choice').nth(0).click();
await page.click('.cmd-actions .btn.accent'); await page.waitForTimeout(500);
console.log('money 422:', await page.textContent('.cmd-error'), '| A kept =', await page.inputValue('[data-field="A"] input'));
// pause
await A(`/api/admin/sessions/${sid}/control`, { method: 'POST', body: JSON.stringify({ action: 'pause', reason: '前端验收' }) });
await page.waitForSelector('.status-pause', { timeout: 5000 });
await page.screenshot({ path: `${out}/1366-paused.png` });
await A(`/api/admin/sessions/${sid}/control`, { method: 'POST', body: JSON.stringify({ action: 'resume', reason: '前端验收' }) });
await page.waitForSelector('#answer-form', { timeout: 5000 }); await page.waitForTimeout(500);
console.log('after resume A kept =', await page.inputValue('[data-field="A"] input'));
await page.close();
// other sizes for the same page
for (const [w, h] of [[1920, 1080], [1280, 720], [700, 900]]) {
  page = await open(w, h); await ready(page);
  await page.click('.page-tools .btn.subtle').catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${w}x${h}-u2-notepad.png` });
  const clipped = await page.evaluate(() => [...document.querySelectorAll('.table-scroll')].some(s => s.scrollWidth > s.clientWidth + 1));
  console.log(w, h, 'table horizontally scrollable (not clipped, may scroll):', clipped);
  await page.close();
}
console.log('errors', errors);
await browser.close();
