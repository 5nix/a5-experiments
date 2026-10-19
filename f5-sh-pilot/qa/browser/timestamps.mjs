// 时间戳验收：用真实浏览器操作，按已知等待时长核对服务端事件、客户端证据、休息倒计时、后台显示与导出。
// 浏览器验收脚本：见 qa/browser/README.md。环境变量 A5_BASE、A5_RUNTIME_DIR、A5_QA_OUT、A5_PLAYWRIGHT。
import { mkdirSync as __mkdir } from 'node:fs';
const __out = process.env.A5_QA_OUT ?? '/tmp/a5-qa'; __mkdir(__out, { recursive: true });
const { chromium } = await import(process.env.A5_PLAYWRIGHT ?? 'playwright');
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { unzipSync, strFromU8 } = require('fflate');
const base = (process.env.A5_BASE ?? 'http://127.0.0.1:5174');
const H = { 'Content-Type': 'application/json' };
const A = async (path, init = {}) => (await fetch(base + path, { ...init, headers: H })).json();
const results = []; const check = (name, ok, detail) => { results.push({ ok, name, detail }); };
const near = (value, target, tolerance) => Math.abs(value - target) <= tolerance;

const c = await A('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ participant_id: '001' }) });
const sid = c.session_id;
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
const page = await ctx.newPage();
const consoleErrors = []; page.on('pageerror', e => consoleErrors.push(String(e))); page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
const ready = () => page.waitForSelector('.cmd-actions .btn:not([disabled])');
const view = async () => (await A(`/api/admin/sessions/${sid}`)).view;
const marks = {};
await page.goto(base + c.participant_url); await ready();
await page.waitForTimeout(2000); marks.introClick = Date.now(); await page.click('.cmd-actions .btn'); await ready();
await page.waitForTimeout(1500); await page.click('.cmd-actions .btn'); await ready();
// U1：先等1秒再打开附件
await page.waitForTimeout(1000); marks.revealClick = Date.now(); await page.click('.attachment'); await page.waitForSelector('.attachment.opened'); await page.waitForTimeout(400);
await page.locator('[data-field="plans"] .choice').nth(0).click(); await page.waitForTimeout(300);
await page.click('.cmd-actions .btn.accent'); await page.waitForFunction(() => document.querySelector('.eyebrow')?.textContent.includes('第2'));
// 暂停3秒再恢复
await page.waitForTimeout(500);
marks.pause = Date.now(); await A(`/api/admin/sessions/${sid}/control`, { method: 'POST', body: JSON.stringify({ action: 'pause', reason: '时间戳验收' }) });
await page.waitForSelector('.status-pause'); await page.waitForTimeout(3000);
marks.resume = Date.now(); await A(`/api/admin/sessions/${sid}/control`, { method: 'POST', body: JSON.stringify({ action: 'resume', reason: '时间戳验收' }) });
await page.waitForSelector('#answer-form'); await ready();
for (const f of (await view()).fields) {
  if (f.type === 'multi') await page.locator(`[data-field="${f.id}"] .choice`).nth(0).click(); else await page.fill(`[data-field="${f.id}"] input`, '1.00');
}
await page.click('.cmd-actions .btn.accent'); await page.waitForTimeout(600);
for (let i = 0; i < 2; i++) { // 理解题、评价
  const v = await view(); await ready();
  for (const f of v.fields) await page.locator(`[data-field="${f.id}"] .choice`).nth(0).click();
  await page.click('.cmd-actions .btn.accent'); await page.waitForTimeout(600);
}
// 休息：等5秒后读取服务端剩余与页面倒计时
await page.waitForSelector('#countdown'); marks.breakSeen = Date.now(); await page.waitForTimeout(5000);
const breakView = await view(); const shown = await page.textContent('#countdown');
const [mm, ss] = shown.split(':').map(Number); const shownSeconds = mm * 60 + ss;
// 后台显示的开始时间
const admin = await ctx.newPage(); await admin.goto(`${base}/admin`); await admin.waitForTimeout(1500);
const adminText = await admin.textContent('body');
await page.click('#skip-break'); await page.waitForTimeout(600);
await browser.close();

const events = (await A(`/api/admin/sessions/${sid}/events`)).events;
const summary = (await A(`/api/admin/sessions/${sid}`)).summary;
const first = (type) => events.find(e => e.event_type === type);
const t = e => Date.parse(e.timestamp_iso);
// 1. 格式与单调
check('所有事件 timestamp_iso 为合法 UTC ISO（Z结尾）', events.every(e => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.timestamp_iso)), `${events.length} 条`);
check('事件时间按写入顺序不倒退', events.every((e, i) => !i || t(e) >= t(events[i - 1])), '');
check('elapsed_ms 按写入顺序不倒退', events.every((e, i) => !i || e.elapsed_ms >= events[i - 1].elapsed_ms), '');
const drift = Math.max(...events.map(e => Math.abs((t(e) - t(events[0])) - (e.elapsed_ms - events[0].elapsed_ms))));
check('elapsed_ms 与墙钟差值一致（含暂停期间）', drift <= 50, `最大偏差 ${drift} ms`);
check('started_at 与首个事件时间一致', near(Date.parse(summary.started_at), t(events[0]), 1000), `${summary.started_at} vs ${events[0].timestamp_iso}`);
// 2. 客户端证据
const withClient = events.filter(e => e.payload?.client?.timestamp_iso);
const lags = withClient.map(e => t(e) - Date.parse(e.payload.client.timestamp_iso));
check('客户端时间早于服务端接收，且延迟 <1s', lags.every(l => l >= -5 && l < 1000), `${withClient.length} 条，延迟 ${Math.min(...lags)}—${Math.max(...lags)} ms`);
const originErr = Math.max(...withClient.filter(e => e.payload.client.time_origin_ms).map(e => Math.abs(e.payload.client.time_origin_ms + e.payload.client.monotonic_ms - Date.parse(e.payload.client.timestamp_iso))));
check('客户端 time_origin + monotonic ≈ 客户端 ISO 时间', originErr <= 20, `最大偏差 ${originErr.toFixed(1)} ms`);
check('displayed 事件均为 visible', events.filter(e => /_displayed$/.test(e.event_type) && e.payload?.client).every(e => e.payload.client.visibility_state === 'visible'), '');
// 3. 已知时长
const intro = t(first('intro_continue')) - t(first('intro_displayed'));
check('导入页停留 ≈ 2.0s（脚本等待2000ms＋点击开销）', intro >= 1950 && intro <= 2800, `${intro} ms`);
const rc = first('reveal_clicked'), rd = first('reveal_displayed');
check('E：点击后才显示，且间隔很短', t(rd) >= t(rc) && t(rd) - t(rc) < 600, `点击→显示 ${t(rd) - t(rc)} ms`);
check('E 的客户端时间晚于浏览器点击时刻', Date.parse(rd.payload.client.timestamp_iso) >= marks.revealClick, '');
const u1 = events.filter(e => e.event_type === 'unit_displayed');
const u1ToReveal = t(rc) - t(u1[0]);
check('U1 显示到点击附件 ≈ 1.0s', u1ToReveal >= 950 && u1ToReveal <= 1800, `${u1ToReveal} ms`);
const sched = events.filter(e => e.event_type === 'message_scheduled');
check('消息排期紧随 E（T0）或 U2 显示（T1）', sched.every(s => { const prev = events[events.indexOf(s) - 1]; return ['reveal_displayed', 'u2_displayed'].includes(prev.event_type) && t(s) - t(prev) < 50; }), sched.map(s => `${s.stage_id ?? ''}←${events[events.indexOf(s) - 1].event_type}`).join(', '));
const pauseE = events.find(e => e.event_type === 'admin_intervention' && e.payload?.action === 'pause'), resumeE = events.find(e => e.event_type === 'admin_intervention' && e.payload?.action === 'resume');
if (pauseE && resumeE) { const d = t(resumeE) - t(pauseE), real = marks.resume - marks.pause; check('暂停/恢复事件时间与实际操作时刻一致（±100ms）', near(t(pauseE), marks.pause, 100) && near(t(resumeE), marks.resume, 100) && near(d, real, 100), `记录 ${d} ms，实际 ${real} ms（含被试页轮询发现暂停的等待）`); }
else check('找到暂停/恢复事件', false, events.map(e => e.event_type).filter(x => /paus|resum|admin/.test(x)).join(','));
// 4. 休息倒计时
const breakDisp = first('break_displayed');
const expectRemain = 180000 - (Date.now() - t(breakDisp)); // 粗略：以 break_displayed 为起点
check('休息服务端剩余 ≈ 180s − 已过时间', near(breakView.remaining_ms, 180000 - (marks.breakSeen + 5000 - t(breakDisp)), 1500), `remaining_ms=${breakView.remaining_ms}`);
check('页面倒计时与服务端剩余一致（±2s）', near(shownSeconds * 1000, breakView.remaining_ms, 2000), `页面 ${shown}，服务端 ${(breakView.remaining_ms / 1000).toFixed(1)}s`);
const skipped = first('break_skipped');
if (skipped) check('跳过休息记录的实际休息+剩余 = 180s', near((skipped.payload.actual_rest_ms ?? 0) + (skipped.payload.remaining_ms ?? 0), skipped.payload.planned_rest_ms ?? 180000, 50) && near(skipped.payload.actual_rest_ms, t(skipped) - t(first('break_displayed')), 300), JSON.stringify(skipped.payload).slice(0, 160));
// 5. 后台显示（Asia/Shanghai）
const local = new Date(summary.started_at); const hhmm = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(local);
const md = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).formatToParts(local); const m = md.find(p => p.type === 'month').value, d = md.find(p => p.type === 'day').value;
check('后台“开始时间”按北京时间显示', adminText.includes(`${m}/${d} ${hhmm}`) || adminText.includes(`${m.padStart(2, '0')}/${d.padStart(2, '0')} ${hhmm}`), `应含 ${m}/${d} ${hhmm}`);
// 6. 导出
const zipRes = await fetch(`${base}/api/admin/export?session_id=${sid}`, { headers: H }); const files = unzipSync(new Uint8Array(await zipRes.arrayBuffer()));
const parse = text => { const rows = []; let row = [], cell = '', q = false; for (let i = 0; i < text.length; i++) { const ch = text[i]; if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; } else if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += ch; } if (cell || row.length) { row.push(cell); rows.push(row); } return rows; };
const csv = name => { const [head, ...rows] = parse(strFromU8(files[Object.keys(files).find(k => k.endsWith(name))]).replace(/^\uFEFF/, '')); return rows.map(r => Object.fromEntries(head.map((c, i) => [c, r[i]]))); };
const sess = csv('sessions.csv')[0];
check('导出 sessions.started_at 与会话一致', sess.started_at === summary.started_at, sess.started_at);
check('导出 intro_duration_ms 与事件差一致', near(Number(sess.intro_duration_ms), first('intro_continue').elapsed_ms - first('intro_displayed').elapsed_ms, 2), `${sess.intro_duration_ms} ms`);
const trial = csv('trials.csv').find(r => r.unit_id === 'SH01_U1');
check('导出 trials E 时间与 reveal_displayed 一致', Number(trial.e_elapsed_ms) === rd.elapsed_ms, `${trial.e_elapsed_ms} vs ${rd.elapsed_ms}`);
const iv = csv('interventions.csv')[0];
if (iv) check('导出消息 t_send 合法且不早于触发事件', !iv.t_send || Date.parse(iv.t_send) >= t(sched[0]) - 5, `t_event=${iv.t_event} t_send=${iv.t_send} t_display=${iv.t_display || '(空，Mock不伪造)'}`);
check('浏览器无脚本错误', consoleErrors.filter(e => !/404|409|422/.test(e)).length === 0, consoleErrors.join(' | '));

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
console.log(`\n${results.filter(r => r.ok).length}/${results.length} 通过`);
