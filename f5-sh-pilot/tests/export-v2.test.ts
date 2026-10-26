import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { loadMaterial } from '../src/tasks.ts';
import { readJson } from '../src/preflight.ts';
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { exportData } from '../src/export.ts';
import type { DisplayMode, GlassesAdapter, GlassesEvent, GlassesRequest, ParticipantConfig } from '../src/contracts.ts';

const material = await loadMaterial();
const config = await readJson<ParticipantConfig>('config/participants.pilot.json');
const rest = material.content.in_unit_rest!;
const visible = { visibility_state: 'visible' };
const ratings = Object.fromEntries(material.content.ratings.map(r => [r.id, '4']));
const expected = (unitId: string) => {
  const unit = material.content.stages.flatMap(s => s.units).find(u => u.unit_id === unitId)!;
  return unit.scoring.type === 'exact' ? unit.scoring.expected as Record<string, unknown> : {};
};

function fixture(adapter: GlassesAdapter = new MockGlassesAdapter(), mode: DisplayMode = 'legacy_8500') {
  const epoch = Date.parse('2026-10-26T08:00:00Z'); let now = epoch;
  const clock = { wall: () => now, mono: () => now };
  const store = new Store(':memory:');
  const engine = new Engine(store, adapter, material, config, clock);
  const id = engine.create('000', { display_mode: mode }).session_id;
  const send = (action: string, extra = {}) => engine.command(id, { command_id: randomUUID(), page_token: engine.view(id).page_token, action, client: visible, ...extra });
  const f = {
    store, engine, id, send, epoch, now: () => now,
    advance(ms: number) { now += ms; engine.tick(id); },
    /** 跳到本组U1，查看补充资料后提交，进入U2并报告可见。 */
    async toU2(stage: string) {
      send('jump', { target: `${stage}_U1` }); send('displayed'); send('reveal', { open: true }); send('reveal_displayed');
      send('submit', { answer: expected(`${stage}_U1`) }); send('displayed'); await engine.settle();
    },
    async takeRest() {
      send('rest_click'); send('rest_displayed');
      f.advance(rest.t2_delay_ms); await engine.settle();
      f.advance(rest.duration_ms - rest.t2_delay_ms); await engine.settle();
      send('rest_return_displayed');
    },
    events: (type: string) => store.events(id).filter(e => e.event_type === type),
    async close() { await engine.settle(); store.close(); },
  };
  return f;
}
function csvRows(text: string) {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  return rows.slice(1).map(values => Object.fromEntries(rows[0].map((key, i) => [key, values[i]])));
}
async function exported(f: ReturnType<typeof fixture>) {
  const directory = await mkdtemp(join(tmpdir(), 'a5-export-v2-'));
  try {
    const output = await exportData(f.engine, [f.id], directory);
    const files = unzipSync(output.bytes);
    const read = (name: string) => csvRows(strFromU8(files[name]));
    return { output, files, read, manifest: JSON.parse(strFromU8(files['manifest.json'])) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('V2导出：窗口前点击+提醒后休息+T2发送、未休息即提交的T2未触发、NONE组未休息', async () => {
  const f = fixture();
  try {
    // SH06 A-T2：窗口前点击 → 主试提醒 → 休息 → T2送达 → 回到U2后作答提交。
    await f.toU2('SH06');
    f.advance(10000); f.send('rest_click');
    assert.equal(f.events('rest_clicked')[0].payload.disposition, 'too_early');
    f.advance(rest.window_min_ms);
    f.engine.adminAction(f.id, 'remind_rest', '被试一直未休息');
    const reminderId = f.engine.session(f.id).state.rest_reminders!.SH06[0].id;
    f.advance(500); f.send('rest_reminder_displayed', { reminder_id: reminderId });
    f.advance(4000); f.send('draft', { answer: { manual: '144' } });
    f.advance(1000); await f.takeRest();
    f.send('rest_click'); // 已休息后的重复点击
    f.advance(2500); f.send('submit', { answer: expected('SH06_U2') });
    assert.equal(f.engine.view(f.id).phase, 'COMPREHENSION');
    f.send('displayed'); f.advance(3000);
    f.send('submit', { answer: { message_notice: 'fully_read', answer: 'A' } });
    f.send('displayed'); f.send('submit', { answer: ratings });

    // SH05 N-T2：未休息即提交 → T2未触发，跳过两页。
    await f.toU2('SH05'); f.advance(80000);
    f.send('submit', { answer: expected('SH05_U2') });
    assert.equal(f.engine.view(f.id).phase, 'CARD');
    assert.equal(f.events('t2_not_triggered').length, 1);

    // SH07 NONE：未休息即提交。
    await f.toU2('SH07'); f.advance(20000); f.send('submit', { answer: expected('SH07_U2') });

    const { output, files, read, manifest } = await exported(f);
    assert.equal(manifest.schema_version, '2.0');
    assert.ok(manifest.rest_semantics && manifest.derived_semantics);
    assert.equal(manifest.survey_fields.ratings_skip_reason.t2_not_triggered !== undefined, true);
    assert.equal(files['breaks.csv'], undefined, '新快照不输出breaks.csv');
    const stages = material.content.stages.length;
    assert.deepEqual({ rests: output.row_counts.rests, stage_summary: output.row_counts.stage_summary, rest_reminders: output.row_counts.rest_reminders, rest_clicks: output.row_counts.rest_clicks, breaks: output.row_counts.breaks },
      { rests: stages, stage_summary: stages, rest_reminders: 1, rest_clicks: 3, breaks: 0 });

    const rests = Object.fromEntries(read('rests.csv').map(r => [r.stage_id, r]));
    const started = f.events('rest_started')[0], ended = f.events('rest_ended')[0], u2 = f.events('u2_displayed')[0];
    const sh06 = rests.SH06;
    assert.equal(sh06.rest_status, 'rested');
    assert.equal(sh06.after_reminder, 'true');
    assert.equal(sh06.reminder_count, '1');
    assert.equal(sh06.click_count, '3'); assert.equal(sh06.early_click_count, '1'); assert.equal(sh06.repeat_click_count, '1');
    assert.equal(sh06.first_click_disposition, 'too_early');
    assert.equal(sh06.window_open_elapsed_ms, String(u2.elapsed_ms + rest.window_min_ms));
    assert.equal(sh06.rest_started_elapsed_ms, String(started.elapsed_ms));
    assert.equal(sh06.start_from_u2_ms, String(started.elapsed_ms - u2.elapsed_ms));
    assert.equal(sh06.start_from_window_open_ms, String(started.elapsed_ms - u2.elapsed_ms - rest.window_min_ms));
    assert.equal(sh06.answered_fields_at_start, '1'); assert.equal(sh06.total_fields, '4');
    assert.deepEqual(JSON.parse(sh06.answer_snapshot_at_start), { manual: '144' });
    assert.equal(sh06.planned_rest_ms, String(rest.duration_ms));
    assert.equal(sh06.actual_rest_ms, String(rest.duration_ms));
    assert.equal(sh06.paused_during_rest, 'false');
    assert.equal(sh06.rest_returned_elapsed_ms, String(ended.elapsed_ms));
    assert.equal(sh06.start_to_u2_submit_ms, String(rest.duration_ms + 2500));
    assert.equal(sh06.resume_answer_after_rest_ms, '2500');
    assert.equal(sh06.t2_status, 'sent');
    assert.equal(sh06.t2_planned_elapsed_ms, String(started.elapsed_ms + rest.t2_delay_ms));
    assert.equal(sh06.t2_actual_delay_ms, String(rest.t2_delay_ms));
    assert.equal(sh06.t2_request_id, f.store.interventions(f.id).find(m => m.stage_id === 'SH06')!.request_id);
    assert.equal(rests.SH05.rest_status, 'not_rested'); assert.equal(rests.SH05.t2_status, 'not_triggered');
    assert.equal(rests.SH05.rest_started_at, ''); assert.equal(rests.SH05.actual_rest_ms, '');
    assert.equal(rests.SH07.rest_status, 'not_rested'); assert.equal(rests.SH07.t2_status, 'not_applicable');
    assert.equal(rests.SH01.rest_status, 'not_reached');

    const clicks = read('rest_clicks.csv');
    assert.deepEqual(clicks.map(c => c.disposition), ['too_early', 'rest_requested', 'already_rested']);
    assert.ok(clicks.every(c => c.data_kind === 'formal' && c.stage_id === 'SH06' && c.client_visibility_state === 'visible'));
    assert.equal(clicks[0].window_open, 'false'); assert.equal(clicks[1].window_open, 'true'); assert.equal(clicks[1].reminder_count, '1');

    const [reminder] = read('rest_reminders.csv');
    assert.equal(reminder.reminder_id, reminderId); assert.equal(reminder.text, rest.reminder_text);
    assert.equal(reminder.unit_id, 'SH06_U2'); assert.equal(reminder.reason, '被试一直未休息');
    assert.equal(reminder.displayed_elapsed_ms, String(Number(reminder.sent_elapsed_ms) + 500));
    assert.equal(reminder.rest_started_after, 'true');
    assert.equal(reminder.sent_to_rest_start_ms, String(started.elapsed_ms - Number(reminder.sent_elapsed_ms)));

    const summary = Object.fromEntries(read('stage_summary.csv').map(r => [r.stage_id, r]));
    assert.equal(summary.SH06.timing, 'T2'); assert.equal(summary.SH06.message_status, 'accepted');
    assert.equal(summary.SH06.t2_not_triggered, 'false'); assert.equal(summary.SH06.send_failed, 'false');
    assert.equal(summary.SH06.message_notice, 'fully_read'); assert.equal(summary.SH06.ratings_status, 'submitted');
    assert.equal(summary.SH06.rest_after_reminder, 'true');
    assert.equal(summary.SH06.message_trigger_minus_rest_start_ms, String(rest.t2_delay_ms));
    assert.equal(summary.SH06.notice_click_after_drawn_ms, '', 'Mock没有drawn，留空');
    assert.equal(summary.SH06.message_drawn_to_comprehension_ms, '');
    assert.equal(summary.SH06.message_trigger_to_comprehension_ms, String(rest.duration_ms - rest.t2_delay_ms + 2500));
    assert.equal(summary.SH06.resume_answer_after_rest_ms, '2500');
    assert.equal(summary.SH06.u2_score, '1');
    assert.equal(summary.SH05.message_status, 't2_not_triggered'); assert.equal(summary.SH05.t2_not_triggered, 'true');
    assert.equal(summary.SH05.send_failed, 'false'); assert.equal(summary.SH05.message_request_id, '');
    assert.equal(summary.SH05.ratings_status, 'skipped'); assert.equal(summary.SH05.ratings_skip_reason, 't2_not_triggered');
    assert.equal(summary.SH05.comprehension_skip_reason, 't2_not_triggered');
    assert.equal(summary.SH07.message_status, 'none'); assert.equal(summary.SH07.ratings_skip_reason, 'no_message');
    assert.equal(summary.SH01.message_status, 'not_triggered');

    const surveys = read('surveys.csv');
    assert.deepEqual(surveys.map(s => s.stage_id), ['SH06'], 'T2未触发不生成虚假问卷行');
    const [session] = read('sessions.csv');
    assert.deepEqual([session.rests_taken, session.rests_after_reminder, session.reminders_sent, session.t2_not_triggered_count], ['1', '1', '1', '1']);
  } finally { await f.close(); }
});

test('V2导出：真机drawn派生注意时间与恢复作答；第5秒眼镜忙碌记为发送失败而非未触发；暂停计入实际休息', async () => {
  let busy = false, clock = 0;
  const requests: GlassesRequest[] = [];
  let engine: Engine;
  const emit = (kind: GlassesEvent['kind'], request: GlassesRequest, monotonic: number) => engine.receiveDeviceEvent({ event_id: randomUUID(), request_id: request.request_id, device_id: 'adb:fixture', kind, device_wall_ms: monotonic, device_monotonic_ms: monotonic, clock_id: 'same-device-clock', error: null });
  const adapter: GlassesAdapter = {
    getStatus: () => ({ source: 'device', connected: true, ready: true, busy, device_id: 'adb:fixture', device_info: { display_modes: 'legacy_8500,tone_8500,confirm_until_ack', fixed_duration_ms: '8500,11000', app_version: '1.1.5' } }),
    send: async request => { requests.push(request); return { request_id: request.request_id, device_id: request.device_id, source: 'device', status: 'accepted', t_send: new Date().toISOString(), t_ack: new Date().toISOString(), t_display: null, t_hide: null, display_time_source: 'unavailable', error: null }; },
    confirm: async request => { emit('confirmed', requests.find(r => r.request_id === request.request_id)!, clock + 1800); },
    cancel: async () => {},
  };
  const f = fixture(adapter, 'confirm_until_ack'); engine = f.engine;
  try {
    // SH05：休息中暂停4秒，T2送达后设备绘制、点击已阅读并确认、消失。
    await f.toU2('SH05'); f.advance(rest.window_min_ms + 1000);
    f.send('rest_click'); f.send('rest_displayed');
    f.advance(2000); f.engine.adminAction(f.id, 'pause', '测试'); f.advance(4000); f.engine.adminAction(f.id, 'resume', '测试');
    f.advance(rest.t2_delay_ms - 2000); await f.engine.settle();
    assert.equal(requests.length, 1);
    f.advance(300); emit('drawn', requests[0], 10000); clock = 10000;
    f.advance(1200);
    const click = await f.engine.readNoticeClick(f.id, { click_id: randomUUID(), page_token: f.engine.view(f.id).page_token, client: visible });
    assert.equal(click.click.disposition, 'confirmation_requested');
    f.advance(200); emit('hidden', requests[0], 12000);
    f.advance(rest.duration_ms); await f.engine.settle();
    f.send('rest_return_displayed');
    f.advance(1500); f.send('submit', { answer: expected('SH05_U2') });
    f.send('displayed'); f.advance(2000); f.send('submit', { answer: { message_notice: 'not_noticed', answer: 'A' } });

    // SH06：第5秒眼镜忙碌 → 发送失败，不补发。
    await f.toU2('SH06'); f.advance(rest.window_min_ms);
    f.send('rest_click'); f.send('rest_displayed'); busy = true;
    f.advance(rest.t2_delay_ms); await f.engine.settle();
    assert.equal(requests.length, 1);
    busy = false; f.advance(rest.duration_ms); f.send('rest_return_displayed');
    f.send('submit', { answer: expected('SH06_U2') });
    assert.equal(f.engine.view(f.id).phase, 'COMPREHENSION');

    const { read } = await exported(f);
    const rests = Object.fromEntries(read('rests.csv').map(r => [r.stage_id, r]));
    assert.equal(rests.SH05.paused_during_rest, 'true'); assert.equal(rests.SH05.paused_ms, '4000');
    assert.ok(Number(rests.SH05.actual_rest_ms) >= rest.duration_ms + 4000, '实际休息包含暂停');
    assert.equal(rests.SH05.t2_actual_delay_ms, String(rest.t2_delay_ms + 4000));
    assert.equal(rests.SH06.t2_status, 'failed'); assert.equal(rests.SH06.t2_failure_reason, 'device_not_ready_at_t2');
    const summary = Object.fromEntries(read('stage_summary.csv').map(r => [r.stage_id, r]));
    assert.equal(summary.SH05.notice_click_after_drawn_ms, '1200');
    assert.equal(summary.SH05.device_confirmation_delay_ms, '1800');
    assert.equal(summary.SH05.message_notice, 'not_noticed'); assert.equal(summary.SH05.ratings_skip_reason, 'not_noticed');
    const hidden = f.events('message_device_hidden')[0], answerAfter = f.store.events(f.id).find(e => e.event_type === 'answer_changed' && e.unit_id === 'SH05_U2' && e.elapsed_ms >= hidden.elapsed_ms)!;
    assert.equal(summary.SH05.resume_answer_after_message_ms, String(answerAfter.elapsed_ms - hidden.elapsed_ms));
    assert.equal(summary.SH05.resume_answer_after_rest_ms, '1500');
    const drawn = f.events('message_device_drawn')[0], comp = f.store.events(f.id).find(e => e.event_type === 'comprehension_displayed' && e.stage_id === 'SH05')!;
    assert.equal(summary.SH05.message_drawn_to_comprehension_ms, String(comp.elapsed_ms - drawn.elapsed_ms));
    assert.equal(summary.SH06.message_status, 'failed'); assert.equal(summary.SH06.send_failed, 'true'); assert.equal(summary.SH06.t2_not_triggered, 'false');
  } finally { await f.close(); }
});
