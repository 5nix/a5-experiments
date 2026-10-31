import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '@a5/desktop/store.ts';
import { Engine } from '@a5/desktop/engine.ts';
import { createApp } from '@a5/desktop/app.ts';
import { loadMaterial, normalize, score } from '@a5/desktop/tasks.ts';
import type { Unit } from '@a5/desktop/tasks.ts';
import type { ParticipantConfig } from '@a5/desktop/contracts.ts';
import { readJson } from '@a5/desktop/preflight.ts';
import { testConfig } from './fixtures.ts';
import { MockGlassesAdapter } from '@a5/glasses/adapters/mock-glasses.ts';
import { exportData } from '@a5/desktop/export.ts';

const material = await loadMaterial();
const config = await testConfig();
config.participants = config.participants.slice(0, 4); // 此流程用例保留原表的四人固定夹具。
const visible = { visibility_state: 'visible', monotonic_ms: 10, time_origin_ms: 1000, timestamp_iso: '2026-10-19T00:00:00.000Z' };
const correct = (unit: Unit) => unit.scoring.type === 'exact' ? structuredClone(unit.scoring.expected) : { checkin: '林晨', guide: '陈珂', equipment: unit.unit_id.endsWith('U1') ? '赵禾' : '梁欣' };
/** 旧快照兼容：V2之前的会话快照没有 in_unit_rest，仍走组间30秒休息。 */
const legacy = { ...material, content: { ...material.content, in_unit_rest: undefined, break_ms: 30000, break_start_on_display: true, allow_break_skip: true } };
function fixture(path = ':memory:', adapter = new MockGlassesAdapter(), mat: typeof material = material) {
  let now = Date.parse('2026-10-19T00:00:00.000Z');
  const store = new Store(path); const clock = { wall: () => now, mono: () => now };
  const engine = new Engine(store, adapter, mat, config, clock);
  const created = engine.create('001');
  const send = (action: string, extra = {}) => engine.command(created.session_id, { command_id: randomUUID(), page_token: engine.view(created.session_id).page_token, action, client: visible, ...extra });
  const display = () => send('displayed');
  return { store, engine, created, send, display, advance: (ms: number) => { now += ms; }, clock };
}

test('完整七组闭环：14单元、6次消息（含2次T2）、6份问卷、无组间休息，T2组在U2休息后送达并导出', async () => {
  const f = fixture(); const directory = await mkdtemp(join(tmpdir(), 'a5-export-'));
  const rest = material.content.in_unit_rest!;
  const assignments = config.participants[0].stages;
  const messageStages = assignments.filter(a => a.condition !== 'NONE');
  try {
    assert.equal(material.content.stages.length, 7);
    f.display(); f.send('continue');
    for (let stage = 0; stage < 7; stage++) {
      const assignment = assignments[stage];
      assert.equal(f.engine.view(f.created.session_id).phase, 'CARD');
      f.display(); f.send('continue');
      for (let unit = 0; unit < 2; unit++) {
        const configured = material.content.stages[stage].units[unit];
        assert.equal(f.engine.view(f.created.session_id).phase, 'UNIT'); f.display();
        if (unit === 0) { f.send('reveal', { open: true }); f.send('reveal_displayed'); }
        if (unit === 1 && assignment.condition.endsWith('T2')) {
          // U2内休息：窗口开放后点击休息，休息页可见后第t2_delay_ms毫秒送达T2，倒计时结束回到任务再提交。
          f.advance(rest.window_min_ms + 1000); f.send('rest_click'); f.send('rest_displayed');
          assert.equal(f.store.interventions(f.created.session_id).filter(m => m.stage_id === assignment.stage_id).length, 0);
          f.advance(rest.t2_delay_ms); f.engine.tick(f.created.session_id);
          assert.equal(f.store.interventions(f.created.session_id).filter(m => m.stage_id === assignment.stage_id).length, 1);
          f.advance(rest.duration_ms - rest.t2_delay_ms); f.engine.tick(f.created.session_id);
          assert.equal(f.engine.view(f.created.session_id).rest?.state, 'returning');
          f.send('rest_return_displayed');
        }
        const view = f.send('submit', { answer: correct(configured) });
        assert.ok(!JSON.stringify(view).includes('correct_option')); assert.ok(!JSON.stringify(view).includes('scoring'));
        if (unit === 0) assert.equal(view.phase, 'UNIT');
      }
      if (assignment.condition !== 'NONE') {
        assert.equal(f.engine.view(f.created.session_id).phase, 'COMPREHENSION'); f.display();
        const stimulus = material.stimuli.find(s => s.message_id === assignment.message_id && s.stage_id === assignment.stage_id)!;
        f.send('submit', { answer: { message_notice: 'fully_read', answer: stimulus.correct_option } }); f.display();
        f.send('submit', { answer: { timing: '4', attention_distraction: '3', thought_disruption: '2', task_interference: '6', perceived_disturbance: '5' } });
      }
      // V2取消组间休息：问卷（或NONE组U2）提交后直接进入下一组说明卡。
      if (stage < 6) {
        assert.equal(f.engine.view(f.created.session_id).phase, 'CARD');
        assert.equal(f.engine.view(f.created.session_id).stage_number, stage + 2);
      }
    }
    assert.equal(f.engine.view(f.created.session_id).phase, 'COMPLETED');
    await f.engine.settle();
    const duration = f.engine.summary(f.created.session_id).elapsed_ms; f.advance(5000);
    f.engine.note(f.created.session_id, 'interview', '=原始访谈记录', null);
    assert.equal(f.engine.summary(f.created.session_id).elapsed_ms, duration);
    const events = f.store.events(f.created.session_id);
    assert.equal(events.filter(e => e.event_type === 'submission_recorded').length, 14);
    assert.equal(events.filter(e => e.event_type === 'unit_scored' && e.payload.score === 1).length, 14);
    assert.equal(events.filter(e => e.event_type === 'F_candidate').length, 1);
    assert.equal(events.filter(e => e.event_type.startsWith('break_')).length, 0);
    assert.equal(events.filter(e => e.event_type === 'rest_started').length, 2);
    assert.equal(events.filter(e => e.event_type === 'rest_ended').length, 2);
    assert.equal(events.filter(e => e.event_type === 'rest_t2_due').length, 2);
    assert.equal(events.filter(e => e.event_type === 't2_not_triggered').length, 0);
    assert.equal(events.filter(e => e.event_type === 'comprehension_submitted').length, messageStages.length);
    assert.equal(events.filter(e => e.event_type === 'ratings_submitted').length, messageStages.length);
    const messages = f.store.interventions(f.created.session_id);
    assert.equal(messageStages.length, 6);
    assert.deepEqual(messages.map(m => m.stage_id).sort(), messageStages.map(a => a.stage_id).sort());
    assert.ok(messages.every(m => m.duration_ms === 11000 && m.source === 'mock' && m.t_display === null && m.t_hide === null));
    assert.equal(events.filter(e => e.event_type === 'message_scheduled' && e.payload.timing === 'T2').length, 2);
    assert.ok(events.every((e, i) => i === 0 || e.elapsed_ms >= events[i - 1].elapsed_ms));
    const output = await exportData(f.engine, [f.created.session_id], directory);
    const counts = output.row_counts as Record<string, number>;
    assert.equal(counts.events, events.length);
    assert.equal(counts.trials, 14); assert.equal(counts.interventions, 6); assert.equal(counts.surveys, 6);
    assert.equal(counts.sessions, 1); assert.equal(counts.notes, 1);
    if (counts.rests !== undefined) assert.equal(counts.rests, 7);
    const files = unzipSync(output.bytes);
    for (const name of ['events.jsonl', 'trials.csv', 'interventions.csv', 'surveys.csv', 'sessions.csv', 'notes.csv', 'snapshots.json', 'manifest.json']) assert.ok(files[name]);
    assert.ok(strFromU8(files['notes.csv']).includes("'=原始访谈记录"));
    assert.ok(strFromU8(files['events.jsonl']).includes('=原始访谈记录'));
    assert.equal(JSON.parse(strFromU8(files['manifest.json'])).row_counts.trials, 14);
  } finally { await f.engine.settle(); f.store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('全部题型强制完整；0合法、时间与金额归一化、NONE互斥且采购仅选A至D', () => {
  for (const stage of material.content.stages) for (const unit of stage.units) {
    const answer = correct(unit);
    assert.equal(score(unit, normalize(unit.fields, answer)), 1);
    for (const field of unit.fields) { const incomplete = { ...answer }; delete incomplete[field.id]; assert.throws(() => normalize(unit.fields, incomplete)); }
  }
  const schedule = material.content.stages[1].units[0];
  assert.equal(score(schedule, normalize(schedule.fields, { training: '10:45', acceptance: '11:15', on_time: '能' })), 1);
  const first = material.content.stages[0].units[0];
  assert.throws(() => normalize(first.fields, { plans: ['A', 'NONE'] }));
  const stock = material.content.stages[4].units[0]; assert.equal(normalize(stock.fields, correct(stock)).guide_gap, 0);
  const order = material.content.stages[4].units[1];
  assert.deepEqual(order.fields.find(f => f.id === 'plan')!.options!.map(o => o.value), ['A', 'B', 'C', 'D']);
  assert.throws(() => normalize(order.fields, { plan: 'NONE', record_surplus: '不适用' }));
});

test('SH04允许多个合法排班，拒绝重人、缺席和迟到；不采用错误示例', () => {
  const unit = material.content.stages[3].units[1];
  assert.equal(score(unit, normalize(unit.fields, { checkin: '林晨', guide: '陈珂', equipment: '梁欣' })), 1);
  for (const answer of [{ checkin: '林晨', guide: '林晨', equipment: '梁欣' }, { checkin: '周悦', guide: '林晨', equipment: '梁欣' }, { checkin: '林晨', guide: '陈珂', equipment: '赵禾' }]) assert.equal(score(unit, normalize(unit.fields, answer)), 0);
});

test('实际可见才触发E与T1；重复展开/重复提交幂等，完整错误答案照常进入U2', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.send('continue'), /尚未报告实际可见/);
    assert.throws(() => f.send('displayed', { client: { visibility_state: 'hidden' } }), /实际可见/);
    f.display(); f.send('continue'); f.display(); f.send('continue'); f.display();
    f.send('reveal', { open: true }); assert.equal(f.store.interventions(f.created.session_id).length, 0);
    assert.throws(() => f.send('submit', { answer: { plans: ['A', 'B'] } }), /先查看补充资料/);
    f.send('reveal_displayed'); f.send('reveal', { open: false }); f.send('reveal', { open: true }); f.send('reveal_displayed');
    assert.equal(f.store.events(f.created.session_id).filter(e => e.event_type === 'reveal_displayed').length, 1);
    assert.equal(f.store.interventions(f.created.session_id).length, 1);
    assert.throws(() => f.send('submit', { answer: {} }), /完整填写/);
    const command = { command_id: randomUUID(), page_token: f.engine.view(f.created.session_id).page_token, action: 'submit', client: visible, answer: { plans: ['C'] } };
    const next = f.engine.command(f.created.session_id, command); assert.equal(next.phase, 'UNIT');
    assert.equal(f.engine.command(f.created.session_id, command).page_token, next.page_token);
    assert.throws(() => f.engine.command(f.created.session_id, { ...command, command_id: randomUUID() }), /页面已变化/);
    assert.equal(f.store.events(f.created.session_id).filter(e => e.event_type === 'submission_recorded').length, 1);
    assert.equal(f.store.events(f.created.session_id).find(e => e.event_type === 'unit_scored')?.payload.score, 0);
    f.display(); assert.equal(f.store.interventions(f.created.session_id).length, 1);
    const view = JSON.stringify(f.engine.view(f.created.session_id));
    assert.ok(!view.includes('N01')); assert.ok(!view.includes('condition')); assert.ok(!view.includes('线上方案评审会，调整为13:30开始。'));
  } finally { await f.engine.settle(); f.store.close(); }
});

test('慢回执不阻塞U1提交，F与正误无关，问卷必答', async () => {
  const f = fixture(':memory:', new MockGlassesAdapter({ delay_ms: 30 }));
  try {
    f.display(); f.send('continue'); f.display(); f.send('continue'); f.display(); f.send('reveal', { open: true }); f.send('reveal_displayed');
    assert.equal(f.store.interventions(f.created.session_id)[0].status, 'send_requested');
    assert.equal(f.send('submit', { answer: { plans: ['A'] } }).phase, 'UNIT');
    f.display(); f.send('submit', { answer: correct(material.content.stages[0].units[1]) }); f.display();
    assert.throws(() => f.send('submit', { answer: {} }), /完整填写/);
    f.send('submit', { answer: { message_notice: 'partially_read', answer: 'C' } }); f.display();
    assert.throws(() => f.send('submit', { answer: { timing: '4' } }), /完整填写/);
    // 新会话将任务状态置入SH05，仅用于隔离F定义的测试，不是公开跳转接口。
    f.store.tx(() => { const s = f.engine.session(f.created.session_id); s.state.stage = 4; s.state.unit = 0; f.engine.transition(s, 'UNIT'); f.store.save(s); });
    f.display(); f.send('reveal', { open: true }); f.send('reveal_displayed');
    const wrong = { ...correct(material.content.stages[4].units[0]), badge_gap: 9 }; f.send('submit', { answer: wrong });
    const marker = f.store.events(f.created.session_id).find(e => e.event_type === 'F_candidate');
    assert.equal(marker?.payload.semantics, 'first_submission'); assert.equal(marker?.payload.score, 0);
  } finally { await f.engine.settle(); f.store.close(); }
});

test('落盘恢复：草稿、文本表格快照、时间衔接、发送不重放；原始事件禁止修改', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-db-')); const dbPath = join(dir, 'test.sqlite');
  const f = fixture(dbPath);
  try {
    f.display(); f.send('continue'); f.display(); f.send('continue'); f.display();
    f.send('draft', { answer: { plans: ['A'] } }); f.send('reveal', { open: true }); f.send('reveal_displayed'); await f.engine.settle();
    const oldCount = f.store.events(f.created.session_id).length;
    f.store.tx(() => { const message = f.store.interventions(f.created.session_id)[0]; message.status = 'send_requested'; f.store.intervention(message); });
    assert.throws(() => f.store.db.prepare('UPDATE events SET data=?').run('{}'), /append-only/);
    f.store.close(); f.advance(5000);
    const store = new Store(dbPath), adapter = new MockGlassesAdapter(); let calls = 0;
    adapter.send = async () => { calls++; throw new Error('不应重发'); };
    const engine = new Engine(store, adapter, material, config, f.clock);
    try {
      assert.deepEqual(engine.view(f.created.session_id).answer, { plans: ['A'] });
      assert.equal(engine.view(f.created.session_id).reveal?.observed, true);
      assert.equal(store.events(f.created.session_id).length, oldCount + 2);
      assert.ok(store.events(f.created.session_id).at(-1)!.elapsed_ms >= 5000);
      assert.equal(store.interventions(f.created.session_id)[0].status, 'unknown'); assert.equal(calls, 0);
      const changed = structuredClone(material); changed.content.intro.title = '新版本';
      assert.notEqual(engine.session(f.created.session_id).snapshot.content.intro.title, changed.content.intro.title);
      assert.deepEqual(engine.session(f.created.session_id).snapshot.content.stages[3].units[0].reveal?.tables, material.content.stages[3].units[0].reveal?.tables);
    } finally { store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('暂停时拒绝作答，旧快照组间休息暂停不计时；停止会话留下人工干预', async () => {
  const f = fixture(':memory:', new MockGlassesAdapter(), legacy);
  try {
    f.display(); f.engine.adminAction(f.created.session_id, 'pause', '现场检查');
    assert.equal(f.engine.view(f.created.session_id).phase, 'PAUSED'); assert.throws(() => f.send('continue'), /已暂停/);
    f.engine.adminAction(f.created.session_id, 'resume', '继续');
    f.store.tx(() => { const s = f.engine.session(f.created.session_id); f.engine.transition(s, 'BREAK'); s.state.break_until_ms = null; f.store.save(s); });
    f.display();
    f.advance(10000); f.engine.adminAction(f.created.session_id, 'pause', '暂停休息'); f.advance(20000); f.engine.adminAction(f.created.session_id, 'resume', '恢复休息');
    assert.equal(f.engine.view(f.created.session_id).remaining_ms, 20000);
    f.engine.adminAction(f.created.session_id, 'stop', '测试结束'); assert.equal(f.engine.view(f.created.session_id).phase, 'ABORTED');
    assert.ok(f.store.events(f.created.session_id).some(e => e.event_type === 'admin_intervention' && e.payload.action === 'stop'));
  } finally { await f.engine.settle(); f.store.close(); }
});

test('后台直接进入、被试会话绑定、输入错误、图片权限、配置导入和恢复入口', async () => {
  const f = fixture(); const directory = await mkdtemp(join(tmpdir(), 'a5-http-'));
  const server = createApp(f.engine, directory); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  const auth = { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' };
  const participantAuth = { Authorization: `Bearer ${f.created.token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/admin')).status, 200);
    assert.equal((await fetch(base + '/experiment')).status, 200);
    assert.equal((await fetch(base + '/api/admin/config')).status, 200);
    assert.equal((await fetch(base + '/api/admin/config', { headers: participantAuth })).status, 200);
    const path = `/api/participant/sessions/${f.created.session_id}`;
    assert.equal((await fetch(base + path)).status, 401);
    const response = await fetch(base + path, { headers: participantAuth }); assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(await response.json()).includes('correct_option'));
    assert.equal((await fetch(base + path + '/assets/image13.png', { headers: participantAuth })).status, 403);
    assert.equal((await fetch(base + path + '/commands', { method: 'POST', headers: participantAuth, body: '{' })).status, 400);
    assert.equal((await fetch(base + '/api/admin/config', { method: 'POST', headers: auth, body: JSON.stringify({}) })).status, 422);
    assert.deepEqual(f.engine.config().participants.map(p => p.participant_id), ['001', '002', '003', '004']);
    const recovery = await fetch(base + `/api/admin/sessions/${f.created.session_id}/access`, { method: 'POST', headers: auth, body: '{}' }); assert.equal(recovery.status, 200);
    assert.equal((await fetch(base + path, { headers: participantAuth })).status, 401);
    assert.equal((await fetch(base + '/api/admin/export', { headers: auth })).headers.get('content-type'), 'application/zip');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.engine.settle(); f.store.close(); await rm(directory, { recursive: true, force: true }); }
});
