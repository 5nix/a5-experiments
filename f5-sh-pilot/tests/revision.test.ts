import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { loadMaterial, minutes, normalize, score } from '../src/tasks.ts';
import { readJson } from '../src/preflight.ts';
import { validateConfig } from '../src/config.ts';
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { exportData } from '../src/export.ts';
import { createApp } from '../src/app.ts';
import type { ParticipantConfig } from '../src/contracts.ts';

const material = await loadMaterial();
const config = await readJson<ParticipantConfig>('config/participants.pilot.json');
const visible = { visibility_state: 'visible' };
function fixture() {
  let now = Date.parse('2026-10-19T08:00:00Z');
  const store = new Store(':memory:');
  const engine = new Engine(store, new MockGlassesAdapter(), material, config, { wall: () => now, mono: () => now });
  const debug = engine.create('000');
  const send = (action: string, extra = {}) => engine.command(debug.session_id, { command_id: randomUUID(), page_token: engine.view(debug.session_id).page_token, action, client: visible, ...extra });
  return { store, engine, debug, send, advance: (ms: number) => { now += ms; } };
}

test('18张表格来自内嵌Excel且不再含图片；M1—M6使用已批准修订和新版XLSX', () => {
  const tables = material.content.stages.flatMap(s => s.units.flatMap(u => [...(u.tables ?? []), ...(u.reveal?.tables ?? [])]));
  assert.equal(tables.length, 18); assert.equal(new Set(tables.map(t => t.id)).size, 18);
  for (const table of tables) { assert.match(table.source_ref!.embedded_file, /^word\/embeddings\/.+\.xlsx$/); assert.ok(table.rows.every(r => r.length === table.columns.length)); }
  assert.deepEqual(material.assets, {});
  assert.equal(tables.find(t => t.id === 'table-05')?.rows[0][1], '9:45');
  assert.equal(tables.find(t => t.id === 'table-13')?.rows[0][1], '12:40');
  assert.equal(tables.find(t => t.id === 'table-18')?.rows[3][4], '125元');
  assert.ok(material.content.stages[0].units[0].paragraphs.includes('请选出符合以上全部要求的方案，可多选。'));
  assert.ok(material.content.stages[0].units[1].paragraphs.some(p => p.includes('D方案的基本报价和筹备周期已更新')));
  assert.ok(material.content.stages[2].units[1].paragraphs.some(p => p.includes('最新状态更新为“已确认”')));
  const ai = material.stimuli.find(s => s.stage_id === 'SH02' && s.message_id === 'A02')!;
  assert.equal(ai.question, '眼镜建议前往哪里打印清单？'); assert.equal(ai.options.find(o => o.id === ai.correct_option)?.text, '三楼自助打印区');
  assert.equal(material.stimuli.find(s => s.stage_id === 'SH02' && s.message_id === 'N02')?.question, '在哪里领取清单的配套材料？');
  for (const stage of material.content.stages) for (const unit of stage.units) {
    assert.equal(unit.scratchpad?.label, '草稿本');
    assert.equal(unit.scratchpad?.placeholder, '您可以在这里输入任意内容...');
  }
});

test('时间接受一位小时、常见冒号、全角数字和空格，保留合法范围及统一评分', () => {
  for (const colon of [':', '：', '﹕', '︓', '∶', '꞉', 'ː']) {
    assert.equal(minutes(`6${colon}23`), 383);
    assert.equal(minutes(`6${colon}00`), 360);
    assert.equal(minutes(`6${colon}09`), 369);
  }
  assert.equal(minutes(' ０６ ： ０９ '), 369);
  assert.equal(minutes('23:59'), 1439);
  for (const invalid of ['24:00', '6:60', '6:9', '6::09', '6.09', '6:09:00', '-6:09', '']) assert.throws(() => minutes(invalid));
  const unit = material.content.stages[1].units[0];
  assert.equal(score(unit, normalize(unit.fields, { debug: '９：４５', training: '10∶45', acceptance: '11﹕15', on_time: '能' })), 1);
});

test('多个被试会话的进度、草稿、暂停和计时独立，同一编号不能重复开始', async () => {
  const f = fixture();
  try {
    const first = f.engine.create('001'); f.advance(3000); const second = f.engine.create('002');
    const send = (id: string, action: string, extra = {}) => f.engine.command(id, { command_id: randomUUID(), page_token: f.engine.view(id).page_token, action, client: visible, ...extra });
    for (const session of [first, second]) {
      send(session.session_id, 'displayed'); send(session.session_id, 'continue');
      send(session.session_id, 'displayed'); send(session.session_id, 'continue'); send(session.session_id, 'displayed');
    }
    send(first.session_id, 'scratchpad', { text: '001独立草稿' });
    send(second.session_id, 'scratchpad', { text: '002独立草稿' });
    send(first.session_id, 'reveal', { open: true }); send(first.session_id, 'reveal_displayed');
    send(first.session_id, 'submit', { answer: { plans: ['A', 'B'] } });
    assert.equal(f.engine.summary(first.session_id).unit, 2); assert.equal(f.engine.summary(second.session_id).unit, 1);
    assert.equal(f.engine.view(second.session_id).scratchpad?.text, '002独立草稿');
    assert.equal(f.store.interventions(first.session_id).length, 1); assert.equal(f.store.interventions(second.session_id).length, 0);
    f.engine.adminAction(first.session_id, 'pause', '仅暂停001');
    assert.equal(f.engine.view(first.session_id).phase, 'PAUSED'); assert.equal(f.engine.view(second.session_id).phase, 'UNIT');
    assert.equal(f.engine.summary(first.session_id).elapsed_ms - f.engine.summary(second.session_id).elapsed_ms, 3000);
    assert.throws(() => f.engine.create('001'), /已有未结束会话/);
    assert.throws(() => f.engine.authenticate(second.session_id, first.token), /凭据无效/);
    assert.ok(f.store.events(second.session_id).every(e => e.participant_id === '002'));
  } finally { await f.engine.settle(); f.store.close(); }
});

test('000复制当前001配置，可往返跳题；正式被试和伪造调试标志不能跳题', async () => {
  const f = fixture();
  try {
    const debug = f.engine.session(f.debug.session_id).snapshot.participant;
    assert.deepEqual(debug.stages, config.participants[0].stages); assert.equal(debug.copied_from, '001');
    assert.ok(f.engine.view(f.debug.session_id).is_debug);
    for (const stage of material.content.stages) for (const unit of stage.units) {
      const v = f.send('jump', { target: unit.unit_id }); assert.equal(v.title, unit.title); assert.equal(v.phase, 'UNIT');
    }
    f.send('jump', { target: 'COMPLETED' }); assert.equal(f.engine.view(f.debug.session_id).phase, 'COMPLETED');
    f.send('jump', { target: 'SH01_U1' }); assert.equal(f.engine.summary(f.debug.session_id).status, 'active');
    assert.throws(() => f.send('jump', { target: 'NOT_A_UNIT' }), /目标无效/);
    const normal = f.engine.create('001');
    assert.equal(normal.view.is_debug, false); assert.deepEqual(normal.view.debug_targets, []);
    assert.throws(() => f.engine.command(normal.session_id, { command_id: randomUUID(), page_token: normal.view.page_token, action: 'jump', target: 'SH05_U2' }), /只有调试/);
    assert.throws(() => f.engine.adminAction(normal.session_id, 'debug_jump', '尝试跳题', 'SH05_U2'), /只有调试/);
    assert.equal(f.engine.summary(normal.session_id).phase, 'INTRO');
    const reserved = structuredClone(config); reserved.participants[0].participant_id = '000';
    assert.ok(validateConfig(reserved, material.stimuli).some(e => e.includes('系统保留')));
    assert.ok(f.store.events(f.debug.session_id).every(e => e.is_debug === true));
  } finally { await f.engine.settle(); f.store.close(); }
});

test('跳过休息由被试或管理员记录，不伪造180秒完成；状态框操作随暂停恢复变化', async () => {
  const f = fixture();
  try {
    f.send('jump', { target: 'SH01_BREAK' }); f.send('displayed'); f.advance(12000);
    assert.equal(f.engine.view(f.debug.session_id).can_skip_break, true);
    assert.ok(f.engine.summary(f.debug.session_id).available_actions.includes('skip_break'));
    const skip = { command_id: randomUUID(), page_token: f.engine.view(f.debug.session_id).page_token, action: 'skip_break', client: visible };
    assert.equal(f.engine.command(f.debug.session_id, skip).phase, 'CARD');
    f.engine.command(f.debug.session_id, skip);
    assert.equal(f.store.events(f.debug.session_id).filter(e => e.event_type === 'break_skipped').length, 1);
    const event = f.store.events(f.debug.session_id).find(e => e.event_type === 'break_skipped')!;
    assert.equal(event.payload.actual_rest_ms, 12000); assert.equal(event.payload.remaining_ms, 168000);
    assert.equal(f.store.events(f.debug.session_id).filter(e => e.event_type === 'break_completed').length, 0);
    f.engine.adminAction(f.debug.session_id, 'debug_jump', '测试休息', 'SH02_BREAK');
    f.engine.adminAction(f.debug.session_id, 'pause', '核对设备');
    const paused = f.engine.summary(f.debug.session_id); assert.ok(paused.available_actions.includes('resume')); assert.ok(!paused.available_actions.includes('pause')); assert.ok(!paused.available_actions.includes('skip_break'));
    f.engine.adminAction(f.debug.session_id, 'resume', '继续预演'); f.engine.adminAction(f.debug.session_id, 'skip_break', '现场结束休息');
    assert.equal(f.engine.summary(f.debug.session_id).stage_id, 'SH03');
    assert.equal(f.store.events(f.debug.session_id).filter(e => e.event_type === 'break_skipped').at(-1)?.payload.actor, 'admin');
    // 正式被试也可跳过休息，仍不开放跳题。
    const formal = f.engine.create('001');
    f.store.tx(() => { const s = f.engine.session(formal.session_id); s.state.phase = 'BREAK'; s.state.break_until_ms = f.engine.elapsed(s) + 180000; f.store.save(s); });
    f.engine.adminAction(formal.session_id, 'skip_break', '正式流程允许跳过休息');
    assert.equal(f.engine.summary(formal.session_id).phase, 'CARD');
  } finally { await f.engine.settle(); f.store.close(); }
});

test('计算草稿按单元保存，不是正式答案，不执行计算；调试与草稿、休息数据进入导出', async () => {
  const f = fixture(); const directory = await mkdtemp(join(tmpdir(), 'a5-revision-export-'));
  try {
    f.send('jump', { target: 'SH01_U2' }); f.send('displayed');
    const raw = '=4.60+0.18+0.26\n<script>仅是草稿文字</script>';
    f.send('scratchpad', { text: raw });
    assert.equal(f.engine.view(f.debug.session_id).scratchpad?.text, raw);
    assert.throws(() => f.send('submit', { answer: {} }), /完整填写/);
    f.send('jump', { target: 'SH02_U1' }); f.send('displayed'); f.send('scratchpad', { text: '9:45 + 45分钟' });
    f.send('jump', { target: 'SH01_U2' }); assert.equal(f.engine.view(f.debug.session_id).scratchpad?.text, raw);
    const summary = f.engine.summary(f.debug.session_id); assert.equal(summary.answered_fields, 0); assert.equal(summary.total_fields, 5);
    const result = await exportData(f.engine, [f.debug.session_id], directory), files = unzipSync(result.bytes);
    const csv = strFromU8(files['trials.csv']); assert.ok(csv.includes('scratchpad_text')); assert.ok(csv.includes("'=4.60")); assert.ok(csv.includes('is_debug'));
    assert.ok(strFromU8(files['events.jsonl']).includes('scratchpad_changed'));
    assert.deepEqual(JSON.parse(strFromU8(files['manifest.json'])).debug_session_ids, [f.debug.session_id]);
  } finally { await f.engine.settle(); f.store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP提供调试被试、状态操作和文本表格；后台跳题仍有独立权限校验', async () => {
  const f = fixture(); const directory = await mkdtemp(join(tmpdir(), 'a5-revision-http-'));
  const server = createApp(f.engine, 'admin-key', directory); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: 'Bearer admin-key', 'Content-Type': 'application/json' };
  try {
    const cfg = await (await fetch(base + '/api/admin/config', { headers })).json() as { debug_participant: { participant_id: string } }; assert.equal(cfg.debug_participant.participant_id, '000');
    const normal = f.engine.create('001');
    const denied = await fetch(base + `/api/admin/sessions/${normal.session_id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'debug_jump', reason: '检验权限', target: 'SH05_U2' }) }); assert.equal(denied.status, 403);
    const detail = await (await fetch(base + `/api/admin/sessions/${f.debug.session_id}`, { headers })).json() as { summary: ReturnType<Engine['summary']> }; assert.ok(detail.summary.available_actions.includes('debug_jump'));
    const jump = await fetch(base + `/api/admin/sessions/${f.debug.session_id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'debug_jump', reason: '调试表格', target: 'SH05_U2' }) }); assert.equal(jump.status, 200);
    const view = await (await fetch(base + `/api/participant/sessions/${f.debug.session_id}`, { headers: { Authorization: `Bearer ${f.debug.token}` } })).json() as ReturnType<Engine['view']>;
    assert.equal(view.tables.length, 2); assert.equal(view.tables[1].rows[3][4], '125元'); assert.deepEqual(view.assets, []);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.engine.settle(); f.store.close(); await rm(directory, { recursive: true, force: true }); }
});
