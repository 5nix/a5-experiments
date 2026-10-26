import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { loadMaterial } from '../src/tasks.ts';
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { testConfig } from './fixtures.ts';
import type { GlassesAdapter, GlassesRequest } from '../src/contracts.ts';

const material = await loadMaterial();
const config = await testConfig();
const rest = material.content.in_unit_rest!;
const visible = { visibility_state: 'visible' };

function fixture(path = ':memory:', adapter: GlassesAdapter = new MockGlassesAdapter(), metadata: Record<string, unknown> = {}) {
  let now = Date.parse('2026-10-26T08:00:00Z');
  const clock = { wall: () => now, mono: () => now };
  const f = { store: new Store(path), engine: null! as Engine, id: '', advance: (ms: number) => { now += ms; },
    send(action: string, extra = {}) { return this.engine.command(this.id, { command_id: randomUUID(), page_token: this.engine.view(this.id).page_token, action, client: visible, ...extra }); },
    events(type: string) { return this.store.events(this.id).filter(e => e.event_type === type); },
    async reopen() { await this.engine.settle(); this.store.close(); this.store = new Store(path); this.engine = new Engine(this.store, adapter, material, config, clock); } };
  f.engine = new Engine(f.store, adapter, material, config, clock);
  f.id = f.engine.create('000', metadata).session_id;
  return f;
}
/** 跳到某组U2并报告可见，推进到窗口开放之后。 */
function openU2(f: ReturnType<typeof fixture>, stage: string, wait = rest.window_min_ms) {
  f.send('jump', { target: `${stage}_U2` }); f.send('displayed'); f.advance(wait);
}
function finishRest(f: ReturnType<typeof fixture>) {
  f.send('rest_click'); f.send('rest_displayed'); f.advance(rest.duration_ms); f.engine.tick(f.id);
  assert.equal(f.engine.view(f.id).rest!.state, 'returning');
  f.send('rest_return_displayed');
}

test('V2材料：七组、休息参数完整，组间休息取消，000覆盖全部七种条件', () => {
  assert.equal(material.content.stages.length, 7);
  assert.equal(rest.duration_ms, 30000); assert.equal(rest.t2_delay_ms, 5000);
  assert.equal(material.content.break_ms, undefined);
  const f = fixture();
  const conditions = f.engine.session(f.id).snapshot.participant.stages.map(s => s.condition).sort();
  assert.deepEqual(conditions, ['A-T0', 'A-T1', 'A-T2', 'N-T0', 'N-T1', 'N-T2', 'NONE']);
  assert.ok(!f.engine.debugTargets(f.engine.session(f.id)).some(t => t.phase === 'BREAK'));
  assert.ok(f.engine.debugTargets(f.engine.session(f.id)).some(t => t.id === 'TUTORIAL_REST'));
});

test('教程休息：必须先练习一次短休息才能继续，数据标记tutorial', async () => {
  const f = fixture(':memory:', new MockGlassesAdapter(), { tutorial_enabled: true });
  try {
    f.send('displayed'); f.send('continue');
    assert.equal(f.engine.view(f.id).phase, 'TUTORIAL_REST');
    assert.ok(f.engine.view(f.id).paragraphs.join('').includes(rest.instruction));
    f.send('displayed');
    assert.throws(() => f.send('continue'), (e: any) => e.status === 422 && /练习一次休息/.test(e.message));
    f.send('rest_click');
    assert.equal(f.engine.view(f.id).rest!.state, 'requested');
    f.send('rest_displayed'); f.advance(rest.tutorial_duration_ms); f.engine.tick(f.id);
    f.send('rest_return_displayed');
    f.send('continue');
    assert.equal(f.engine.view(f.id).phase, 'INTRO');
    assert.ok(f.events('rest_started').every(e => e.data_kind === 'tutorial'));
    assert.equal(f.events('rest_ended')[0].payload.actual_rest_ms, rest.tutorial_duration_ms);
  } finally { await f.engine.settle(); f.store.close(); }
});

test('U2休息：U1无按钮；窗口前点击只提示并记录；休息中拒绝作答；30秒后返回且答案保留；每组一次；NONE组也有休息', async () => {
  const f = fixture();
  try {
    f.send('jump', { target: 'SH07_U1' }); f.send('displayed');
    assert.equal(f.engine.view(f.id).rest, null);
    assert.throws(() => f.send('rest_click'), /没有休息功能/);
    openU2(f, 'SH07', 0);
    const idle = f.engine.view(f.id).rest!;
    assert.equal(idle.state, 'idle'); assert.equal(idle.button_label, rest.button_label);
    f.advance(rest.window_min_ms - 1);
    f.send('rest_click');
    let view = f.engine.view(f.id);
    assert.equal(view.rest!.state, 'idle');
    assert.equal(view.rest!.feedback!.text, rest.early_click_text);
    assert.equal(f.engine.summary(f.id).rest!.status, 'before_window');
    f.advance(1);
    assert.equal(f.engine.summary(f.id).rest!.status, 'available');
    const answer = { group_b: '340' };
    f.send('draft', { answer });
    f.send('rest_click');
    assert.equal(f.engine.view(f.id).rest!.state, 'requested');
    assert.throws(() => f.send('draft', { answer: { group_b: '1' } }), /正在休息/);
    assert.throws(() => f.send('scratchpad', { text: 'x' }), /正在休息/);
    f.advance(800); f.send('rest_displayed'); f.send('rest_displayed');
    view = f.engine.view(f.id);
    assert.equal(view.rest!.state, 'resting'); assert.equal(view.rest!.remaining_ms, rest.duration_ms);
    const started = f.events('rest_started');
    assert.equal(started.length, 1);
    assert.equal(started[0].payload.answered_fields, 1);
    assert.equal(started[0].payload.total_fields, view.fields.length);
    assert.deepEqual(started[0].payload.answer_snapshot, answer);
    assert.equal(started[0].payload.u2_elapsed_ms, rest.window_min_ms + 800);
    f.send('rest_click');
    assert.equal(f.events('rest_clicked').at(-1)!.payload.disposition, 'already_resting');
    f.advance(rest.duration_ms - 1); f.engine.tick(f.id);
    assert.equal(f.engine.view(f.id).rest!.state, 'resting');
    f.advance(1); f.engine.tick(f.id);
    assert.equal(f.engine.view(f.id).rest!.state, 'returning');
    f.advance(300); f.send('rest_return_displayed');
    view = f.engine.view(f.id);
    assert.equal(view.rest!.state, 'done');
    assert.deepEqual(view.answer, answer);
    assert.equal(f.events('rest_ended')[0].payload.actual_rest_ms, rest.duration_ms + 300);
    f.send('rest_click');
    assert.equal(f.engine.view(f.id).rest!.feedback!.text, rest.already_rested_text);
    assert.equal(f.events('rest_started').length, 1);
    assert.deepEqual(f.events('rest_clicked').map(e => e.payload.disposition), ['too_early', 'rest_requested', 'already_resting', 'already_rested']);
    assert.equal(f.store.interventions(f.id).length, 0, 'NONE组休息不触发任何消息');
  } finally { await f.engine.settle(); f.store.close(); }
});

test('T2：休息页可见后5秒送达；T0/T1组的休息不触发消息；无组间休息直接进入下一组', async () => {
  const f = fixture();
  try {
    openU2(f, 'SH05');
    f.send('rest_click');
    f.advance(2000);
    assert.equal(f.store.interventions(f.id).length, 0, '点击时不送达，以休息页实际可见为准');
    f.send('rest_displayed');
    assert.equal(f.engine.summary(f.id).rest!.t2, 'scheduled');
    assert.equal(f.engine.summary(f.id).message_status, 'awaiting_rest');
    f.advance(rest.t2_delay_ms - 1); f.engine.tick(f.id);
    assert.equal(f.store.interventions(f.id).length, 0);
    f.advance(1); f.engine.tick(f.id);
    const [message] = f.store.interventions(f.id);
    assert.equal(message.stage_id, 'SH05'); assert.equal(message.condition, 'N-T2'); assert.equal(message.message_id, 'N05');
    const due = f.events('rest_t2_due')[0];
    assert.equal(due.payload.actual_delay_ms, rest.t2_delay_ms);
    assert.equal(f.events('message_scheduled')[0].payload.timing, 'T2');
    assert.equal(f.events('message_scheduled')[0].payload.trigger_event_id, due.event_id);
    f.advance(rest.duration_ms); f.engine.tick(f.id); f.send('rest_return_displayed');
    await f.engine.settle();
    f.send('submit', { answer: structuredClone((material.content.stages[4].units[1].scoring as { expected: Record<string, unknown> }).expected) });
    assert.equal(f.engine.view(f.id).phase, 'COMPREHENSION');
    f.send('displayed'); f.send('submit', { answer: { message_notice: 'not_noticed', answer: 'C' } });
    const next = f.engine.view(f.id);
    assert.equal(next.phase, 'CARD'); assert.equal(next.stage_number, 6);
    assert.equal(f.store.interventions(f.id).length, 1);
    for (const stage of ['SH02', 'SH03']) {
      openU2(f, stage); await f.engine.settle();
      const before = f.store.interventions(f.id).length;
      finishRest(f);
      assert.equal(f.store.interventions(f.id).length, before, `${stage}的休息不送达消息`);
    }
    assert.equal(f.store.interventions(f.id).find(m => m.stage_id === 'SH02')?.condition, 'N-T1', 'T1仍在U2首次实际呈现时送达');
  } finally { await f.engine.settle(); f.store.close(); }
});

test('T2未休息即提交：不送达、不补发，记为未触发并跳过理解题与量表', async () => {
  const f = fixture();
  try {
    openU2(f, 'SH06');
    const expected = (material.content.stages[5].units[1].scoring as { expected: Record<string, unknown> }).expected;
    f.send('submit', { answer: structuredClone(expected) });
    assert.equal(f.store.interventions(f.id).length, 0);
    assert.equal(f.events('rest_not_taken').length, 1);
    assert.equal(f.events('t2_not_triggered').length, 1);
    assert.deepEqual(f.events('comprehension_skipped').map(e => e.payload.reason), ['t2_not_triggered']);
    assert.deepEqual(f.events('ratings_skipped').map(e => e.payload.reason), ['t2_not_triggered']);
    const view = f.engine.view(f.id);
    assert.equal(view.phase, 'CARD'); assert.equal(view.stage_number, 7);
  } finally { await f.engine.settle(); f.store.close(); }
});

test('主试提醒休息：仅U2未休息时可用，提醒语只上被试屏幕，之后的休息标为提醒后', async () => {
  const f = fixture();
  try {
    f.send('jump', { target: 'SH01_U1' }); f.send('displayed');
    assert.ok(!f.engine.summary(f.id).available_actions.includes('remind_rest'));
    assert.throws(() => f.engine.adminAction(f.id, 'remind_rest', ''), /第二单元/);
    openU2(f, 'SH01', 1000);
    assert.ok(f.engine.summary(f.id).available_actions.includes('remind_rest'));
    f.engine.adminAction(f.id, 'remind_rest', '被试长时间未休息');
    const reminder = f.engine.view(f.id).rest!.reminder!;
    assert.equal(reminder.text, rest.reminder_text); assert.equal(reminder.displayed, false);
    f.send('rest_reminder_displayed', { reminder_id: reminder.id });
    assert.equal(f.engine.view(f.id).rest!.reminder!.displayed, true);
    assert.equal(f.engine.summary(f.id).rest!.reminder_count, 1);
    f.advance(rest.window_min_ms);
    finishRest(f);
    assert.equal(f.events('rest_started')[0].payload.after_reminder, true);
    assert.equal(f.engine.summary(f.id).rest!.after_reminder, true);
    assert.ok(!f.engine.summary(f.id).available_actions.includes('remind_rest'));
    assert.throws(() => f.engine.adminAction(f.id, 'remind_rest', ''), /尚未休息/);
    assert.equal(f.events('rest_reminder_sent')[0].payload.reason, '被试长时间未休息');
    assert.ok(f.events('admin_intervention').some(e => e.payload.action === 'remind_rest'));
    assert.equal(f.store.interventions(f.id).length, 0, '提醒不发到眼镜');
  } finally { await f.engine.settle(); f.store.close(); }
});

test('人工暂停冻结休息倒计时与T2计划时刻；重启后休息状态一致且不重发', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a5-rest-'));
  const f = fixture(join(directory, 'rest.sqlite'));
  try {
    openU2(f, 'SH05');
    f.send('rest_click'); f.send('rest_displayed');
    f.advance(2000); f.engine.adminAction(f.id, 'pause', ''); f.advance(20000); f.engine.tick(f.id);
    assert.equal(f.store.interventions(f.id).length, 0);
    f.engine.adminAction(f.id, 'resume', '');
    assert.equal(f.engine.view(f.id).rest!.remaining_ms, rest.duration_ms - 2000);
    f.advance(rest.t2_delay_ms - 2000); f.engine.tick(f.id);
    assert.equal(f.store.interventions(f.id).length, 1);
    await f.reopen();
    assert.equal(f.engine.view(f.id).rest!.state, 'resting');
    assert.equal(f.store.interventions(f.id).length, 1);
    f.advance(rest.duration_ms); f.engine.tick(f.id); f.send('rest_return_displayed');
    const ended = f.events('rest_ended')[0];
    assert.equal(ended.payload.paused_during, true); assert.equal(ended.payload.paused_ms, 20000);
    assert.equal(f.events('message_scheduled').length, 1);
  } finally { await f.engine.settle(); f.store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('第5秒时眼镜未就绪：休息照常，记录失败原因且不补发', async () => {
  let ready = true;
  const adapter: GlassesAdapter = {
    getStatus: () => ({ source: 'device', connected: true, ready, busy: false, device_id: 'dev-1', device_info: { fixed_duration_ms: '11000', display_modes: 'legacy_8500,tone_8500,confirm_until_ack', app_version: '1.1.5' } }),
    send: async (request: GlassesRequest) => ({ request_id: request.request_id, source: 'device', status: 'accepted', t_send: new Date().toISOString(), t_ack: null, t_display: null, t_hide: null, display_time_source: 'unavailable', error: null, device_id: 'dev-1' }),
  };
  const f = fixture(':memory:', adapter);
  try {
    openU2(f, 'SH05');
    f.send('rest_click'); f.send('rest_displayed');
    ready = false;
    f.advance(rest.t2_delay_ms); f.engine.tick(f.id);
    const [message] = f.store.interventions(f.id);
    assert.equal(message.status, 'failed'); assert.equal(message.error, 'device_not_ready_at_t2');
    assert.equal(f.engine.summary(f.id).rest!.t2, 'failed');
    ready = true; f.advance(1000); f.engine.tick(f.id);
    assert.equal(f.store.interventions(f.id).length, 1);
    assert.equal(f.engine.view(f.id).rest!.state, 'resting');
    assert.equal(f.events('message_send_requested').length, 0);
  } finally { await f.engine.settle(); f.store.close(); }
});
