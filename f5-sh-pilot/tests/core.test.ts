import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { createApp } from '../src/app.ts';
import { loadMaterial, normalize, score } from '../src/tasks.ts';
import type { Unit } from '../src/tasks.ts';
import type { ParticipantConfig } from '../src/contracts.ts';
import { readJson } from '../src/preflight.ts';
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { exportData } from '../src/export.ts';

const material = await loadMaterial();
const config = await readJson<ParticipantConfig>('config/participants.pilot.json');
const visible = { visibility_state: 'visible', monotonic_ms: 10, time_origin_ms: 1000, timestamp_iso: '2026-10-19T00:00:00.000Z' };
const correct = (unit: Unit) => unit.scoring.type === 'exact' ? structuredClone(unit.scoring.expected) : { checkin: '许宁', guide: '林晨', equipment: unit.unit_id.endsWith('U1') ? '赵禾' : '梁欣' };
function fixture(path = ':memory:', adapter = new MockGlassesAdapter()) {
  let now = Date.parse('2026-10-19T00:00:00.000Z');
  const store = new Store(path); const clock = { wall: () => now, mono: () => now };
  const engine = new Engine(store, adapter, material, config, clock);
  const created = engine.create('001');
  const send = (action: string, extra = {}) => engine.command(created.session_id, { command_id: randomUUID(), page_token: engine.view(created.session_id).page_token, action, client: visible, ...extra });
  const display = () => send('displayed');
  return { store, engine, created, send, display, advance: (ms: number) => { now += ms; }, clock };
}

test('完整五组闭环：10单元、4次消息、4份问卷、4次180秒休息、6类导出', async () => {
  const f = fixture(); const directory = await mkdtemp(join(tmpdir(), 'a5-export-'));
  try {
    f.display(); f.send('continue');
    for (let stage = 0; stage < 5; stage++) {
      assert.equal(f.engine.view(f.created.session_id).phase, 'CARD');
      f.display(); f.send('continue');
      for (let unit = 0; unit < 2; unit++) {
        const configured = material.content.stages[stage].units[unit];
        assert.equal(f.engine.view(f.created.session_id).phase, 'UNIT'); f.display();
        if (unit === 0) { f.send('reveal', { open: true }); f.send('reveal_displayed'); }
        const view = f.send('submit', { answer: correct(configured) });
        assert.ok(!JSON.stringify(view).includes('correct_option')); assert.ok(!JSON.stringify(view).includes('scoring'));
        if (unit === 0) assert.equal(view.phase, 'UNIT');
      }
      if (stage !== 4) {
        assert.equal(f.engine.view(f.created.session_id).phase, 'COMPREHENSION'); f.display();
        const stimulus = material.stimuli.find(s => s.message_id === config.participants[0].stages[stage].message_id && s.stage_id === config.participants[0].stages[stage].stage_id)!;
        f.send('submit', { answer: { answer: stimulus.correct_option } }); f.display();
        f.send('submit', { answer: { timing: '4', disruption: '3', effort: '2', helpfulness: '6' } });
        assert.equal(f.engine.view(f.created.session_id).phase, 'BREAK'); f.display();
        f.advance(179999); assert.throws(() => f.send('continue'), /休息尚未/);
        f.advance(1); assert.equal(f.engine.view(f.created.session_id).can_continue, true); f.send('continue');
      }
    }
    assert.equal(f.engine.view(f.created.session_id).phase, 'COMPLETED');
    await f.engine.settle();
    const duration = f.engine.summary(f.created.session_id).elapsed_ms; f.advance(5000);
    f.engine.note(f.created.session_id, 'interview', '=原始访谈记录', null);
    assert.equal(f.engine.summary(f.created.session_id).elapsed_ms, duration);
    const events = f.store.events(f.created.session_id);
    assert.equal(events.filter(e => e.event_type === 'submission_recorded').length, 10);
    assert.equal(events.filter(e => e.event_type === 'unit_scored' && e.payload.score === 1).length, 10);
    assert.equal(events.filter(e => e.event_type === 'F_candidate').length, 1);
    assert.equal(events.filter(e => e.event_type === 'break_started').length, 4);
    assert.equal(events.filter(e => e.event_type === 'comprehension_submitted').length, 4);
    assert.equal(f.store.interventions(f.created.session_id).length, 4);
    assert.ok(f.store.interventions(f.created.session_id).every(m => m.duration_ms === 8500 && m.source === 'mock' && m.t_display === null && m.t_hide === null));
    assert.ok(events.every((e, i) => i === 0 || e.elapsed_ms >= events[i - 1].elapsed_ms));
    const output = await exportData(f.engine, [f.created.session_id], directory);
    assert.deepEqual(output.row_counts, { events: events.length, trials: 10, interventions: 4, surveys: 4, sessions: 1, notes: 1 });
    const files = unzipSync(output.bytes);
    for (const name of ['events.jsonl', 'trials.csv', 'interventions.csv', 'surveys.csv', 'sessions.csv', 'notes.csv', 'snapshots.json', 'manifest.json']) assert.ok(files[name]);
    assert.ok(strFromU8(files['notes.csv']).includes("'=原始访谈记录"));
    assert.ok(strFromU8(files['events.jsonl']).includes('=原始访谈记录'));
    assert.equal(JSON.parse(strFromU8(files['manifest.json'])).row_counts.trials, 10);
  } finally { await f.engine.settle(); f.store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('全部题型强制完整；0合法、时间与金额归一化、NONE互斥及不适用格式', () => {
  for (const stage of material.content.stages) for (const unit of stage.units) {
    const answer = correct(unit);
    assert.equal(score(unit, normalize(unit.fields, answer)), 1);
    for (const field of unit.fields) { const incomplete = { ...answer }; delete incomplete[field.id]; assert.throws(() => normalize(unit.fields, incomplete)); }
  }
  const schedule = material.content.stages[1].units[0];
  assert.equal(score(schedule, normalize(schedule.fields, { debug: '09:45', training: '10:45', acceptance: '11:15', on_time: '能' })), 1);
  const first = material.content.stages[0].units[0];
  assert.throws(() => normalize(first.fields, { plans: ['A', 'NONE'] }));
  const stock = material.content.stages[4].units[0]; assert.equal(normalize(stock.fields, correct(stock)).guide_gap, 0);
  const order = material.content.stages[4].units[1];
  assert.equal(normalize(order.fields, { plan: 'NONE', badge_surplus: '不适用', record_surplus: '不适用' }).plan, 'NONE');
});

test('SH04允许多个合法排班，拒绝重人、缺席和迟到；不采用错误示例', () => {
  const unit = material.content.stages[3].units[1];
  for (const [checkin, guide] of [['林晨', '陈珂'], ['林晨', '唐可'], ['许宁', '林晨'], ['许宁', '陈珂'], ['许宁', '唐可']]) assert.equal(score(unit, normalize(unit.fields, { checkin, guide, equipment: '梁欣' })), 1);
  for (const answer of [{ checkin: '许宁', guide: '许宁', equipment: '梁欣' }, { checkin: '周悦', guide: '林晨', equipment: '梁欣' }, { checkin: '许宁', guide: '林晨', equipment: '赵禾' }]) assert.equal(score(unit, normalize(unit.fields, answer)), 0);
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
    f.send('submit', { answer: { answer: 'C' } }); f.display();
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
      assert.ok(engine.session(f.created.session_id).snapshot.content.stages[3].units[0].reveal?.tables?.[0].source_ref?.sha256);
    } finally { store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('暂停时拒绝作答，休息暂停不计时；停止会话留下人工干预', async () => {
  const f = fixture();
  try {
    f.display(); f.engine.adminAction(f.created.session_id, 'pause', '现场检查');
    assert.equal(f.engine.view(f.created.session_id).phase, 'PAUSED'); assert.throws(() => f.send('continue'), /已暂停/);
    f.engine.adminAction(f.created.session_id, 'resume', '继续');
    f.store.tx(() => { const s = f.engine.session(f.created.session_id); f.engine.transition(s, 'BREAK'); s.state.break_until_ms = f.engine.elapsed(s) + 180000; f.store.save(s); });
    f.advance(10000); f.engine.adminAction(f.created.session_id, 'pause', '暂停休息'); f.advance(20000); f.engine.adminAction(f.created.session_id, 'resume', '恢复休息');
    assert.equal(f.engine.view(f.created.session_id).remaining_ms, 170000);
    f.engine.adminAction(f.created.session_id, 'stop', '测试结束'); assert.equal(f.engine.view(f.created.session_id).phase, 'ABORTED');
    assert.ok(f.store.events(f.created.session_id).some(e => e.event_type === 'admin_intervention' && e.payload.action === 'stop'));
  } finally { await f.engine.settle(); f.store.close(); }
});

test('HTTP角色隔离、输入错误、图片权限、配置导入和恢复入口', async () => {
  const f = fixture(); const directory = await mkdtemp(join(tmpdir(), 'a5-http-'));
  const server = createApp(f.engine, 'test-admin', directory); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  const auth = { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' };
  const participantAuth = { Authorization: `Bearer ${f.created.token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/admin')).status, 200);
    assert.equal((await fetch(base + '/experiment')).status, 200);
    assert.equal((await fetch(base + '/api/admin/config')).status, 401);
    assert.equal((await fetch(base + '/api/admin/config', { headers: participantAuth })).status, 401);
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
