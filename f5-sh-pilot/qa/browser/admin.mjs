// 浏览器验收脚本：见 qa/browser/README.md。环境变量 A5_BASE、A5_RUNTIME_DIR、A5_QA_OUT、A5_PLAYWRIGHT。
import { mkdirSync as __mkdir } from 'node:fs';
const __out = process.env.A5_QA_OUT ?? '/tmp/a5-qa'; __mkdir(__out, { recursive: true });
const { chromium } = await import(process.env.A5_PLAYWRIGHT ?? 'playwright');
import { readFileSync, mkdirSync } from 'node:fs';
const base = (process.env.A5_BASE ?? 'http://127.0.0.1:5174');
const out = process.env.OUT ?? __out; mkdirSync(out, { recursive: true });
const results = []; const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const errors = [];
const browser = await chromium.launch({ channel: 'chrome' });

/* ---------- 被试 API 驱动 ---------- */
const client = () => ({ timestamp_iso: new Date().toISOString(), monotonic_ms: performance.now(), time_origin_ms: Date.now(), visibility_state: 'visible', user_agent: 'qa' });
function participant(url) {
  const p = new URLSearchParams(url.split('#')[1]); const id = p.get('session'), token = p.get('token');
  const call = async (body) => { const r = await fetch(`${base}/api/participant/sessions/${id}${body ? '/commands' : ''}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${r.status} ${j.error}`); return j; };
  const cmd = (view, action, extra = {}) => call({ command_id: crypto.randomUUID(), page_token: view.page_token, action, client: client(), ...extra });
  const answer = f => f.type === 'multi' ? [f.options.find(o => o.value !== f.exclusive_value).value] : f.type === 'single' ? f.options[0].value : f.type === 'time' ? '6:00' : f.type === 'money' ? '1.00' : '1';
  return {
    id, view: () => call(),
    async displayed(view) { return cmd(view, 'displayed'); },
    async draft(view, partial) { return cmd(view, 'draft', { answer: partial }); },
    async step(view) {
      if (['INTRO', 'CARD'].includes(view.phase)) return cmd(view, 'continue');
      if (view.phase === 'UNIT' && view.reveal && !view.reveal.observed) { await cmd(view, 'reveal', { open: true }); await cmd(view, 'reveal_displayed'); }
      const ans = Object.fromEntries(view.fields.map(f => [f.id, answer(f)]));
      return cmd(view, 'submit', { answer: ans });
    },
  };
}

/* ---------- 桌面 ---------- */
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push('desktop: ' + m.text() + ' @ ' + (m.location()?.url ?? '')); });
page.on('pageerror', e => errors.push('desktop pageerror: ' + e));
const shot = async (name, opts = {}) => { await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); }); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/admin-v2-${name}.png`, ...opts }); };
const waitPoll = () => page.waitForTimeout(2900);

await page.goto(`${base}/admin`);
await page.waitForSelector('#participant option[value="001"]', { state: 'attached' });
ok('地址片段已清除', !page.url().includes('#') && !page.url().includes(key));
ok('后台直接进入且不保存管理员密钥', await page.evaluate(() => !sessionStorage.getItem('a5-admin-key')));
ok('页面文字不含凭据', !(await page.textContent('body')).includes(key));
await shot('desktop-empty');

await page.click('#nav-setup'); await page.click('#preflight'); await page.waitForSelector('.checklist');
await shot('desktop-setup', { fullPage: true });
await page.click('#nav-sessions');

// 创建 000
await page.selectOption('#participant', '000');
ok('000 选项显示为调试测试者', (await page.textContent('#participant option[value="000"]')).includes('调试测试者'));
await page.click('#start button[type=submit]');
await page.waitForFunction(() => document.querySelector('#selected-title').textContent.includes('调试'));
const link000 = await page.inputValue('#access-url');
const bodyText = await page.textContent('body');
ok('不显示复制来源', !/复制\s*001|copied/i.test(bodyText));
// 创建 001
await page.selectOption('#participant', '001');
await page.click('#start button[type=submit]');
await page.waitForFunction(() => document.querySelector('#selected-title').textContent.includes('001'));
const link001 = await page.inputValue('#access-url');
ok('两个入口不同', link000 && link001 && link000 !== link001);
await page.click('#copy-link');
const clip = await page.evaluate(() => navigator.clipboard.readText());
ok('复制链接为当前会话入口', clip === link001);
// 切换会话 → 入口同步切换
await page.click('.session-row:has-text("000")');
await page.waitForFunction(l => document.querySelector('#access-url').value === l, link000);
ok('切到 000 显示 000 入口', (await page.inputValue('#access-url')) === link000);
await page.click('.session-row:has-text("001")');
await page.waitForFunction(l => document.querySelector('#access-url').value === l, link001);
ok('切回 001 显示 001 入口', true);
ok('新窗口打开链接正确', (await page.getAttribute('#open-link', 'href')) === new URL(link001).pathname + new URL(link001).hash);

// 409
await page.selectOption('#participant', '001');
ok('预先提示已有进行中会话', await page.isVisible('#participant-hint'));
await page.click('#start button[type=submit]');
await page.waitForSelector('#error:not([hidden])');
const err409 = await page.textContent('#error-text');
ok('409 提示清楚', err409.includes('已有未结束的会话'), err409);
await page.click('.session-row:has-text("000")');
await page.waitForFunction(() => document.querySelector('#selected-title').textContent.includes('调试'));
await page.selectOption('#participant', '001');
await page.click('#start button[type=submit]');
await page.waitForSelector('#error-action:not([hidden])');
await shot('desktop-409');
await page.click('#error-action');
await page.waitForFunction(() => document.querySelector('#selected-title').textContent.includes('001'));
ok('409 “查看该会话”跳到 001', true);

// 被试推进 001：到第1单元并保存部分草稿
const p1 = participant(link001);
let v = await p1.view(); await p1.displayed(v); v = await p1.step(v); await p1.displayed(v); v = await p1.step(v); await p1.displayed(v);
await p1.draft(v, { [v.fields[0].id]: v.fields[0].type === 'multi' ? [v.fields[0].options[0].value] : '1' });
await waitPoll();
const facts = await page.textContent('#state-values');
ok('作答进度显示', /已填 1 \/ 共 \d+ 项/.test(facts), facts);
ok('非休息页不显示剩余休息', !facts.includes('剩余休息'));
ok('有资料页显示资料状态', facts.includes('补充资料'));
await shot('desktop-session-active');
// 焦点与输入不被轮询打断
await page.fill('#note-text', '轮询期间输入的访谈草稿');
await page.focus('#note-text');
await waitPoll();
ok('轮询后焦点保留', await page.evaluate(() => document.activeElement?.id === 'note-text'));
ok('轮询后输入保留', (await page.inputValue('#note-text')) === '轮询期间输入的访谈草稿');
// 行节点未重建
const rowHandle = await page.$('.session-row[aria-current="true"]');
await page.evaluate(n => { n.dataset.marker = 'x'; }, rowHandle);
await waitPoll();
ok('轮询未重建选中行', await page.evaluate(() => !!document.querySelector('.session-row[data-marker="x"]')));
await page.fill('#note-text', '');

// 推进到休息
for (let i = 0; i < 20 && v.phase !== 'BREAK'; i++) { v = await p1.step(v); await p1.displayed(v); }
ok('被试 API 推进到休息页', v.phase === 'BREAK', v.phase);
await waitPoll();
ok('休息中徽标', (await page.textContent('#selected-badges')).includes('休息中'));
ok('显示剩余休息', (await page.textContent('#state-values')).includes('剩余休息'));
ok('跳过休息按钮可见', await page.isVisible('#regular-actions [value=skip_break]'));
ok('消息显示模拟标注', (await page.textContent('#message-source')).includes('模拟（Mock）'));
await shot('desktop-break');
// 无原因不能操作
await page.click('#regular-actions [value=skip_break]');
await page.waitForSelector('#error:not([hidden])');
ok('无原因时拦截', (await page.textContent('#error-text')).includes('原因'));
await page.fill('#reason', '测试：跳过休息');
await page.click('#regular-actions [value=skip_break]');
await page.waitForFunction(() => !document.querySelector('#selected-badges').textContent.includes('休息中'));
ok('跳过休息后进入下一组', (await page.textContent('#state-values')).includes('SH02'));

// 暂停 / 恢复
await page.fill('#reason', '测试：被试请求暂停');
await page.click('#regular-actions [value=pause]');
await page.waitForFunction(() => document.querySelector('#selected-badges').textContent.includes('已暂停'));
ok('暂停后显示恢复按钮', await page.isVisible('#regular-actions [value=resume]'));
await shot('desktop-paused');
await page.fill('#reason', '测试：继续');
await page.click('#regular-actions [value=resume]');
await page.waitForFunction(() => !document.querySelector('#selected-badges').textContent.includes('已暂停'));
ok('恢复成功', true);

// 备注
await page.check('#note input[value=observation]');
await page.selectOption('#note-stage', 'SH01');
await page.fill('#note-text', '被试在资料页停留较久。\n第二行。');
await page.click('#note button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('#notes .note').length === 1);
ok('备注保存并显示', (await page.textContent('#notes')).includes('任务观察'));
await page.fill('#note-text', '访谈：消息出现时正在核对表格。');
await page.keyboard.press('Control+Enter');
await page.waitForFunction(() => document.querySelectorAll('#notes .note').length === 2);
ok('Ctrl+Enter 保存备注', true);

// 000 调试跳转
await page.click('.session-row:has-text("000")');
await page.waitForFunction(() => document.querySelector('#selected-title').textContent.includes('调试'));
await page.waitForSelector('#admin-debug:not([hidden])', { timeout: 5000 }).catch(() => {});
ok('调试跳转可见', await page.isVisible('#admin-debug'));
await page.selectOption('#admin-debug-target', 'SH02_BREAK');
await page.fill('#reason', '调试：跳到休息');
await page.click('#admin-debug [value=debug_jump]');
await page.waitForFunction(() => document.querySelector('#selected-badges').textContent.includes('休息中'));
ok('调试跳转到休息页', true);

// 结束并删除 001，再恢复
await page.click('.session-row:has-text("001")');
await page.waitForFunction(() => document.querySelector('#selected-title').textContent.includes('001'));
ok('进行中不可删除（按钮隐藏）', !(await page.isVisible('[data-confirm=delete]')));
await page.fill('#reason', '测试：提前结束');
await page.click('[data-confirm=stop]');
await page.waitForSelector('#confirm:not([hidden])');
await shot('desktop-confirm-stop');
await page.click('#confirm-yes');
await page.waitForFunction(() => document.querySelector('#selected-badges').textContent.includes('提前结束'));
ok('提前结束', true);
await page.fill('#reason', '测试：删除重复记录');
await page.click('[data-confirm=delete]');
await page.waitForSelector('#confirm:not([hidden])');
ok('删除确认说明可恢复', (await page.textContent('#confirm-text')).includes('恢复'));
await page.click('#confirm-yes');
await page.waitForFunction(() => document.querySelector('#deleted-count').textContent === '1');
ok('删除后不在列表', !(await page.$('.session-row:has-text("001")')));
await page.waitForTimeout(400);
await shot('desktop-deleted');
await page.click('.deleted-item button');
await page.waitForFunction(() => document.querySelector('#selected-title').textContent.includes('001'));
ok('恢复后保持提前结束', (await page.textContent('#selected-badges')).includes('提前结束'));
await shot('desktop-ended', { fullPage: true });

// 导出
const zipCheck = async (button) => {
  const [download, response] = await Promise.all([page.waitForEvent('download'), page.waitForResponse(r => r.url().includes('/api/admin/export')), page.click(button)]);
  const path = await download.path(); const bytes = readFileSync(path);
  return { type: response.headers()['content-type'], name: download.suggestedFilename(), pk: bytes.subarray(0, 2).toString() === 'PK', url: response.url() };
};
const one = await zipCheck('#export-one');
ok('导出当前会话为 zip 且带 session_id', one.type === 'application/zip' && one.pk && one.url.includes('session_id='), JSON.stringify(one));
const all = await zipCheck('#export-all');
ok('导出全部为 zip 且不带 session_id', all.type === 'application/zip' && all.pk && !all.url.includes('session_id'), JSON.stringify(all));
ok('导出全部范围说明含数量', (await page.textContent('#export-all-scope')).includes('2 个'));

// 新建 002 以展示多会话
await page.selectOption('#participant', '002').catch(() => {});
if (await page.inputValue('#participant') === '002') { await page.click('#start button[type=submit]'); await page.waitForFunction(() => document.querySelector('#selected-title').textContent.includes('002')); }
// 001 第二次会话
await page.selectOption('#participant', '001');
await page.click('#start button[type=submit]');
await page.waitForFunction(() => document.querySelector('#selected-meta').textContent.includes('第 2 次'));
ok('同号第二次会话标注', true);
await shot('desktop-overview');

/* ---------- 手机 ---------- */
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mp = await m.newPage();
mp.on('console', msg => { if (msg.type() === 'error') errors.push('mobile: ' + msg.text()); });
mp.on('pageerror', e => errors.push('mobile pageerror: ' + e));
const mshot = async (name, opts = {}) => { await mp.waitForTimeout(300); await mp.screenshot({ path: `${out}/admin-v2-${name}.png`, ...opts }); };
await mp.goto(`${base}/admin`);
await mp.waitForSelector('.session-row');
await mshot('mobile-list');
ok('手机：详情初始隐藏', !(await mp.isVisible('#selected')));
await mp.tap('.session-row:has-text("000")');
await mp.waitForSelector('#selected:not([hidden])');
ok('手机：列表隐藏', !(await mp.isVisible('#create-title')));
await mshot('mobile-detail');
await mshot('mobile-detail-full', { fullPage: true });
const small = await mp.$$eval('button:not([hidden]), select, input:not([type=radio]):not([type=file]), a.btn, .segmented span', els => els.filter(e => e.offsetParent && e.getBoundingClientRect().height > 0).filter(e => e.getBoundingClientRect().height < 43.5).map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().height)));
ok('手机：触控目标 ≥44px', small.length === 0, small.join(', '));
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
ok('手机：无横向溢出', !overflow);
await mp.tap('#back');
await mp.waitForSelector('#create-title', { state: 'visible' });
ok('手机：返回列表', true);
await mp.tap('#nav-setup');
await mp.waitForSelector('#setup:not([hidden])');
await mshot('mobile-setup', { fullPage: true });
await mp.tap('#nav-sessions');
await mp.waitForSelector('#create-title', { state: 'visible' });
await mp.selectOption('#participant', '000');
await mshot('mobile-create-hint');

console.log(results.join('\n'));
console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
