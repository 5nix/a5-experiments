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
import { testConfig } from './fixtures.ts';
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { exportData } from '../src/export.ts';
import type { ParticipantConfig } from '../src/contracts.ts';

const material = await loadMaterial();
/** 旧快照兼容：V2之前的会话快照没有 in_unit_rest，仍走组间30秒休息。 */
const legacy = { ...material, content: { ...material.content, in_unit_rest: undefined, break_ms: 30000, break_start_on_display: true, allow_break_skip: true } };
const config = await testConfig();
const visible = { visibility_state: 'visible' };
const ratings = Object.fromEntries(material.content.ratings.map(r => [r.id, '4']));
function fixture(path = ':memory:', mat: typeof material = legacy) {
  let now = Date.parse('2026-10-25T08:00:00Z');
  const clock = { wall: () => now, mono: () => now };
  const f = { store: new Store(path), engine: null! as Engine, id: '', advance: (ms: number) => { now += ms; },
    send(action: string, extra = {}) { return this.engine.command(this.id, { command_id: randomUUID(), page_token: this.engine.view(this.id).page_token, action, client: visible, ...extra }); },
    async reopen() { await this.engine.settle(); this.store.close(); this.store = new Store(path); this.engine = new Engine(this.store, new MockGlassesAdapter(), mat, config, clock); } };
  f.engine = new Engine(f.store, new MockGlassesAdapter(), mat, config, clock);
  f.id = f.engine.create('000').session_id;
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

test('V2新快照没有组间休息：问卷提交后直接进入下一组说明卡，跳转列表无BREAK', async () => {
  const f = fixture(':memory:', material);
  try {
    assert.ok(material.content.in_unit_rest);
    assert.ok(!f.engine.view(f.id).debug_targets.some(t => t.id.endsWith('_BREAK')));
    assert.throws(() => f.send('jump', { target: 'SH01_BREAK' }), /调试跳转目标无效/);
    f.send('jump', { target: 'SH01_COMPREHENSION' }); f.send('displayed');
    f.send('submit', { answer: { message_notice: 'fully_read', answer: 'C' } });
    f.send('displayed'); f.send('submit', { answer: ratings });
    assert.equal(f.engine.view(f.id).phase, 'CARD');
    assert.equal(f.engine.view(f.id).stage_number, 2);
    assert.ok(!f.engine.summary(f.id).available_actions.includes('skip_break'));
    assert.throws(() => f.engine.adminAction(f.id, 'skip_break', '测试'), /不是可跳过的休息状态/);
    assert.equal(f.store.events(f.id).filter(e => e.event_type.startsWith('break_')).length, 0);
  } finally { await f.engine.settle(); f.store.close(); }
});

test('旧快照：问卷耗时及休息页显示前延迟均不计时；仅可见回执起算，重复回执不重置', async () => {
  const f = fixture();
  try {
    assert.equal(legacy.content.break_ms, 30000);
    assert.equal(legacy.content.break_start_on_display, true);
    f.send('jump', { target: 'SH01_COMPREHENSION' }); f.send('displayed'); f.advance(90000);
    f.send('submit', { answer: { message_notice: 'fully_read', answer: 'C' } });
    assert.equal(f.engine.view(f.id).phase, 'RATINGS');
    f.send('displayed'); f.advance(120000); f.send('submit', { answer: ratings });
    assert.equal(f.engine.view(f.id).phase, 'BREAK');
    assert.equal(f.engine.view(f.id).remaining_ms, 30000);
    assert.equal(f.engine.view(f.id).can_continue, false);
    f.advance(60000);
    assert.equal(f.engine.view(f.id).remaining_ms, 30000);
    assert.equal(f.engine.summary(f.id).remaining_ms, 30000);
    assert.equal(f.store.events(f.id).filter(e => e.event_type === 'break_started' || e.event_type === 'break_completed').length, 0);
    assert.throws(() => f.send('displayed', { client: { visibility_state: 'hidden' } }), /实际可见/);
    f.send('displayed');
    assert.equal(f.engine.view(f.id).remaining_ms, 30000);
    f.advance(10000); f.send('displayed');
    assert.equal(f.engine.view(f.id).remaining_ms, 20000);
    assert.equal(f.store.events(f.id).filter(e => e.event_type === 'break_displayed').length, 1);
    assert.equal(f.store.events(f.id).filter(e => e.event_type === 'break_started').length, 1);
    f.advance(19999); assert.equal(f.engine.view(f.id).can_continue, false);
    assert.throws(() => f.send('continue'), /尚未满30秒/);
    f.advance(1); assert.equal(f.engine.view(f.id).can_continue, true);
    assert.equal(f.store.events(f.id).filter(e => e.event_type === 'break_completed').length, 1);
    f.send('continue'); assert.equal(f.engine.view(f.id).phase, 'CARD');
    assert.equal(f.engine.view(f.id).stage_number, 2);
  } finally { await f.engine.settle(); f.store.close(); }
});

test('旧快照：延迟检测仍记录30秒到零时刻；继续前停留、重启及重复提交不丢失休息记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a5-breaks-'));
  const f = fixture(join(directory, 'test.sqlite'));
  try {
    f.send('jump', { target: 'SH01_BREAK' }); f.send('displayed');
    const displayed = f.store.events(f.id).find(e => e.event_type === 'break_displayed')!;
    f.advance(10000); await f.reopen();
    assert.equal(f.engine.view(f.id).remaining_ms, 20000);
    f.send('displayed'); assert.equal(f.engine.view(f.id).remaining_ms, 20000);
    f.advance(23000);
    assert.equal(f.engine.view(f.id).can_continue, true);
    const completed = f.store.events(f.id).find(e => e.event_type === 'break_completed')!;
    assert.equal(completed.payload.countdown_ended_elapsed_ms, displayed.elapsed_ms + 30000);
    assert.equal(completed.payload.countdown_ended_at, new Date(Date.parse(displayed.timestamp_iso) + 30000).toISOString());
    assert.equal(completed.elapsed_ms - displayed.elapsed_ms, 33000);
    f.advance(4000);
    const command = { command_id: randomUUID(), page_token: f.engine.view(f.id).page_token, action: 'continue', client: visible };
    f.engine.command(f.id, command); f.engine.command(f.id, command);
    await f.reopen();
    assert.equal(f.engine.view(f.id).phase, 'CARD');
    const events = f.store.events(f.id);
    assert.equal(events.filter(e => e.event_type === 'continue_clicked').length, 1);
    assert.equal(events.find(e => e.event_type === 'continue_clicked')!.payload.actual_rest_ms, 37000);
    const files = unzipSync((await exportData(f.engine, [f.id], directory)).bytes);
    const rows = csvRows(strFromU8(files['breaks.csv']));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].planned_rest_ms, '30000');
    assert.equal(rows[0].actual_rest_ms, '37000');
    assert.equal(rows[0].displayed_at, displayed.timestamp_iso);
    assert.equal(rows[0].countdown_ended_at, completed.payload.countdown_ended_at);
    assert.equal(Date.parse(rows[0].continue_clicked_at) - Date.parse(rows[0].displayed_at), 37000);
    assert.equal(rows[0].ended_by, 'continue');
    assert.equal(JSON.parse(strFromU8(files['manifest.json'])).row_counts.breaks, 1);
  } finally { await f.engine.settle(); f.store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('旧快照：人工暂停冻结倒计时，实际休息包含暂停与到零后等待；提前跳过保留真实时长', async () => {
  const f = fixture();
  try {
    f.send('jump', { target: 'SH01_BREAK' }); f.send('displayed'); f.advance(10000);
    f.engine.adminAction(f.id, 'pause', '测试暂停'); f.advance(20000);
    assert.equal(f.engine.summary(f.id).remaining_ms, 20000);
    assert.equal(f.store.events(f.id).filter(e => e.event_type === 'break_completed').length, 0);
    f.engine.adminAction(f.id, 'resume', '测试恢复'); f.send('displayed');
    f.advance(20000); assert.equal(f.engine.view(f.id).can_continue, true);
    f.advance(5000); f.send('continue');
    assert.equal(f.store.events(f.id).find(e => e.event_type === 'continue_clicked')!.payload.actual_rest_ms, 55000);
    f.send('jump', { target: 'SH02_BREAK' }); f.send('displayed'); f.advance(12000); f.send('skip_break');
    const skip = f.store.events(f.id).find(e => e.event_type === 'break_skipped')!;
    assert.equal(skip.payload.actual_rest_ms, 12000);
    assert.equal(skip.payload.remaining_ms, 18000);
    assert.equal(f.store.events(f.id).filter(e => e.stage_id === 'SH02' && e.event_type === 'break_completed').length, 0);
  } finally { await f.engine.settle(); f.store.close(); }
});
