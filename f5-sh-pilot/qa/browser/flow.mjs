// 浏览器验收脚本：见 qa/browser/README.md。环境变量 A5_BASE、A5_RUNTIME_DIR、A5_QA_OUT、A5_PLAYWRIGHT。
import { mkdirSync as __mkdir } from 'node:fs';
const __out = process.env.A5_QA_OUT ?? '/tmp/a5-qa'; __mkdir(__out, { recursive: true });
const { chromium } = await import(process.env.A5_PLAYWRIGHT ?? 'playwright');
import { readFileSync, mkdirSync } from 'node:fs';
const base = (process.env.A5_BASE ?? 'http://127.0.0.1:5174');
const out = process.env.OUT ?? __out + '/shots'; mkdirSync(out, { recursive: true });
const pid = process.env.PID ?? '000';
const W = Number(process.env.W ?? 1536), H = Number(process.env.H ?? 864);
const full = process.env.FULL !== '0';
const adminApi = async (path, init = {}) => { const r = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json' } }); return r.json(); };
const created = await adminApi('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ participant_id: pid }) });
if (!created.participant_url) { console.log(created); process.exit(1); }
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.goto(base + created.participant_url);
const shot = async name => { await page.waitForTimeout(250); await page.screenshot({ path: `${out}/${name}.png` }); };
const phase = async () => (await (await fetch(`${base}/api/admin/sessions/${created.session_id}`, { headers: { } })).json()).view;
const waitEnabled = async sel => { await page.waitForSelector(`${sel}:not([disabled])`, { timeout: 10000 }); };
await waitEnabled('.cmd-actions .btn');
await shot('01-intro');
console.log('debug control visible:', await page.locator('.tray-btn').count());
await page.click('.cmd-actions .btn'); await waitEnabled('.cmd-actions .btn');
await shot('02-card');
let n = 0;
for (let guard = 0; guard < 60; guard++) {
  const view = await phase();
  if (view.phase === 'COMPLETED') { await page.waitForTimeout(400); await shot('99-completed'); break; }
  await waitEnabled('.cmd-actions .btn');
  if (view.phase === 'CARD') { if (n < 3) await shot(`card-${view.stage_number}`); await page.click('.cmd-actions .btn'); continue; }
  if (view.phase === 'BREAK') { await shot(`break-${view.stage_number}`); await page.click('#skip-break'); await page.waitForTimeout(300); continue; }
  if (view.phase === 'UNIT') {
    n++;
    const tag = view.title.slice(0, 6);
    if (view.reveal) { await page.click('.attachment'); await page.waitForSelector('.attachment.opened'); await page.waitForTimeout(300); }
    if (n === 1) {
      // 先试必答拦截
      await page.click('.cmd-actions .btn.accent'); await shot('unit-missing');
      await page.click('.btn.subtle'); await page.fill('.note-text', '草稿测试 1+1'); await shot('unit-notepad');
    }
    for (const f of view.fields) {
      const sel = `[data-field="${f.id}"]`;
      if (f.type === 'multi' || f.type === 'single') {
        if (f.type === 'single' && f.options.length > 5) await page.selectOption(`${sel} select`, f.options[view.fields.indexOf(f)].value);
        else await page.locator(`${sel} .choice`).nth(0).click();
      } else {
        const v = { integer: '0', money: '1.00', time: '６：２３', integer_or_na: '0' }[f.type];
        await page.fill(`${sel} input`, v);
      }
    }
    if (n <= 10 && (n % 2 === 1 || n === 2)) await shot(`unit-${String(n).padStart(2, '0')}`);
    await page.click('.cmd-actions .btn.accent');
    await page.waitForFunction(t => !document.querySelector('h1') || true, null);
    await page.waitForTimeout(400);
    continue;
  }
  if (view.phase === 'COMPREHENSION' || view.phase === 'RATINGS') {
    for (const f of view.fields) await page.locator(`[data-field="${f.id}"] .choice`).nth(f.type === 'single' && f.options.length === 7 ? 3 : 0).click();
    await shot(`${view.phase.toLowerCase()}-${view.stage_number}`);
    await page.click('.cmd-actions .btn.accent'); await page.waitForTimeout(400); continue;
  }
  console.log('unexpected', view.phase); break;
  if (!full) break;
}
const events = await (await fetch(`${base}/api/admin/sessions/${created.session_id}/events`, { headers: { } })).json();
const types = events.events.map(e => e.event_type);
console.log('final', (await phase()).phase, 'units', n);
console.log('events', JSON.stringify(types.filter(t => /reveal_displayed|u2_displayed|message|scratch|rejected|submit/.test(t)).reduce((a, t) => (a[t] = (a[t] ?? 0) + 1, a), {})));
console.log('console errors', errors);
await browser.close();
