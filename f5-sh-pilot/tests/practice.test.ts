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
import { exportData } from '../src/export.ts';
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { testConfig } from './fixtures.ts';

const material = await loadMaterial();
const config = await testConfig();
const rest = material.content.in_unit_rest!;
const visible = { visibility_state: 'visible' };
const right = { reception: '24', exhibit: '40' }, right2 = { reception: '28', exhibit: '48' };

/** 000调试身份、带教程的新会话（有练习单元的快照）。 */
function fixture(path = ':memory:') {
  let now = Date.parse('2026-10-30T08:00:00Z');
  const clock = { wall: () => now, mono: () => now };
  const adapter = new MockGlassesAdapter();
  const f = { store: new Store(path), engine: null! as Engine, id: '', advance: (ms: number) => { now += ms; },
    send(action: string, extra = {}) { return this.engine.command(this.id, { command_id: randomUUID(), page_token: this.engine.view(this.id).page_token, action, client: visible, ...extra }); },
    events(type: string) { return this.store.events(this.id).filter(e => e.event_type === type); },
    async reopen() { await this.engine.settle(); this.store.close(); this.store = new Store(path); this.engine = new Engine(this.store, adapter, material, config, clock); },
    /** 工作台页 → 练习单元01 → 练习单元01完成（按要求打开附件） → 练习单元02页面已显示。 */
    toUnit2() {
      this.send('displayed'); this.send('continue'); this.send('displayed');
      this.send('reveal', { open: true }); this.send('reveal_displayed');
      this.send('submit', { answer: right }); this.send('displayed');
    } };
  f.engine = new Engine(f.store, adapter, material, config, clock);
  f.id = f.engine.create('000', { tutorial_enabled: true }).session_id;
  return f;
}
const restClickDisposition = (f: ReturnType<typeof fixture>) => f.events('rest_clicked').at(-1)!.payload.disposition;

test('新快照含两个练习单元，练习休息窗口5秒、时长10秒', () => {
  assert.equal(material.content.practice!.units.map(u => u.unit_id).join(), 'PRACTICE_U1,PRACTICE_U2');
  assert.equal(rest.practice_window_min_ms, 5000); assert.equal(rest.practice_duration_ms, 10000);
  assert.equal(rest.window_min_ms, 30000); assert.equal(rest.duration_ms, 30000);
  const [u1, u2] = material.content.practice!.units;
  assert.ok(u1.reveal && !u2.reveal);
  assert.ok(u1.paragraphs.some(p => p.includes(`《${u1.reveal!.button_label}》`)));
  assert.deepEqual([u1.scoring, u2.scoring].map(s => s.type === 'exact' ? s.expected : null), [{ reception: 24, exhibit: 40 }, { reception: 28, exhibit: 48 }]);
  assert.ok(u2.paragraphs.join('').includes(rest.instruction));
});

test('练习单元01：必须先打开文件卡片附件；答错也不拦截；不触发任何正式消息（000的SH01为N-T0）', async () => {
  const f = fixture();
  try {
    f.send('displayed');
    const intro = f.engine.view(f.id);
    assert.equal(intro.phase, 'TUTORIAL_INTRO'); assert.ok(intro.paragraphs.join('').includes('接下来有两个练习单元'));
    f.send('continue');
    assert.equal(f.engine.view(f.id).phase, 'TUTORIAL_UNIT1'); f.send('displayed');
    const view = f.engine.view(f.id);
    assert.equal(view.tutorial, true); assert.equal(view.title, '练习单元01：计算区域面积');
    assert.deepEqual(view.fields.map(x => x.id), ['reception', 'exhibit']);
    assert.equal(view.reveal!.button_label, '区域宽度.xlsx'); assert.equal(view.reveal!.open, false);
    assert.equal(view.rest, null); assert.equal(view.tables[0].caption, '区域的长度');
    assert.ok(view.scratchpad); assert.deepEqual(view.assets, []);
    f.send('scratchpad', { text: '6×4' });
    // 没打开附件不能提交；打开后补充资料表格才出现。
    assert.throws(() => f.send('submit', { answer: right }), /先查看补充资料/);
    assert.equal(f.events('submission_rejected').length, 1);
    f.send('reveal', { open: true });
    assert.equal(f.engine.view(f.id).reveal!.tables[0].caption, '区域的对应宽度');
    f.send('reveal_displayed');
    // 打开附件（正式任务里这会触发E与N01）在练习里不触发任何消息。
    await f.engine.settle();
    assert.deepEqual(f.store.interventions(f.id), []);
    assert.ok(f.events('reveal_displayed').every(e => e.payload.marker === undefined && e.data_kind === 'tutorial'));
    // 答错仍可提交并进入练习单元02，只记录对错。
    f.send('submit', { answer: { reception: '1', exhibit: '2' } });
    assert.equal(f.engine.view(f.id).phase, 'TUTORIAL_UNIT2');
    const submitted = f.events('tutorial_answer_submitted');
    assert.equal(submitted.length, 1); assert.equal(submitted[0].payload.score, 0); assert.equal(submitted[0].payload.unit_id, 'PRACTICE_U1');
  } finally { await f.engine.settle(); f.store.close(); }
});

test('练习单元02：5秒内点休息只提示；10秒休息期间不能作答；必须休息一次才能提交；之后进入情景导入', async () => {
  const f = fixture();
  try {
    f.toUnit2();
    const idle = f.engine.view(f.id);
    assert.equal(idle.phase, 'TUTORIAL_UNIT2'); assert.equal(idle.title, '练习单元02：调整尺寸后重新计算');
    assert.equal(idle.rest!.state, 'idle'); assert.equal(idle.rest!.key, 'PRACTICE'); assert.equal(idle.rest!.duration_ms, 10000);
    assert.equal(idle.reveal, null);
    // 未休息不能提交（答案再对也不行）。
    f.send('draft', { answer: { reception: '28' } });
    assert.throws(() => f.send('submit', { answer: right2 }), (e: any) => e.status === 422 && /练习一次休息/.test(e.message));
    // 窗口前点击：只提示，不开始休息。
    f.advance(4999); f.send('rest_click');
    assert.equal(restClickDisposition(f), 'too_early');
    assert.equal(f.events('rest_clicked').at(-1)!.payload.window_min_ms, 5000);
    assert.equal(f.engine.view(f.id).rest!.state, 'idle'); assert.equal(f.engine.view(f.id).rest!.feedback!.text, rest.early_click_text);
    f.advance(1); f.send('rest_click');
    assert.equal(restClickDisposition(f), 'rest_requested');
    f.send('rest_displayed'); f.advance(3000); f.engine.tick(f.id);
    assert.equal(f.engine.view(f.id).rest!.state, 'resting'); assert.equal(f.engine.view(f.id).rest!.remaining_ms, 7000);
    assert.throws(() => f.send('draft', { answer: right2 }), /正在休息/);
    assert.throws(() => f.send('submit', { answer: right2 }), /正在休息/);
    f.advance(7000); f.engine.tick(f.id);
    assert.equal(f.engine.view(f.id).rest!.state, 'returning');
    f.send('rest_return_displayed');
    // 休息后：答案保留，可以继续作答并提交。
    assert.equal(f.engine.view(f.id).answer.reception, '28');
    f.send('submit', { answer: right2 });
    assert.equal(f.engine.view(f.id).phase, 'INTRO');
    assert.equal(f.events('rest_started')[0].payload.duration_ms, 10000);
    assert.equal(f.events('rest_ended')[0].payload.actual_rest_ms, 10000);
    assert.equal(f.events('tutorial_completed').length, 1);
    assert.deepEqual(f.store.interventions(f.id), []);
    // 练习期间的全部事件标为教程数据，并归到TUTORIAL，不挂到任何任务组。
    const practiceEvents = f.store.events(f.id).filter(e => e.unit_id?.startsWith('PRACTICE'));
    assert.ok(practiceEvents.length > 10);
    assert.ok(practiceEvents.every(e => e.data_kind === 'tutorial' && e.stage_id === 'TUTORIAL' && e.condition === 'TUTORIAL'));
    assert.equal(f.events('u2_displayed').length, 0); assert.equal(f.events('rest_not_taken').length, 0);
  } finally { await f.engine.settle(); f.store.close(); }
});

test('练习单元02：直接提交时若休息已倒计时结束但尚未报告返回，也算完成练习休息', async () => {
  const f = fixture();
  try {
    f.toUnit2(); f.advance(5000);
    f.send('rest_click'); f.send('rest_displayed'); f.advance(10000); f.engine.tick(f.id);
    assert.equal(f.engine.view(f.id).rest!.state, 'returning');
    f.send('submit', { answer: right2 });
    assert.equal(f.engine.view(f.id).phase, 'INTRO');
    assert.equal(f.events('rest_ended')[0].payload.paused_during, false);
  } finally { await f.engine.settle(); f.store.close(); }
});

test('练习休息中重启服务：休息状态与倒计时保持，恢复后可完成', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a5-practice-'));
  const f = fixture(join(directory, 'p.sqlite'));
  try {
    f.toUnit2(); f.advance(5000); f.send('rest_click'); f.send('rest_displayed'); f.advance(4000);
    await f.reopen();
    const mid = f.engine.view(f.id);
    assert.equal(mid.phase, 'TUTORIAL_UNIT2'); assert.equal(mid.rest!.state, 'resting'); assert.equal(mid.rest!.remaining_ms, 6000);
    f.advance(6000); f.engine.tick(f.id);
    assert.equal(f.engine.view(f.id).rest!.state, 'returning');
    f.send('rest_return_displayed'); f.send('submit', { answer: right2 });
    assert.equal(f.engine.view(f.id).phase, 'INTRO');
  } finally { await f.engine.settle(); f.store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('000与主试跳转列表：教程为工作台页和两个练习单元；练习单元不提供提醒休息', async () => {
  const f = fixture();
  try {
    const targets = f.engine.view(f.id).debug_targets;
    assert.deepEqual(targets.slice(0, 3).map(t => t.id), ['TUTORIAL_INTRO', 'TUTORIAL_UNIT1', 'TUTORIAL_UNIT2']);
    assert.ok(!targets.some(t => ['TUTORIAL_REST', 'TUTORIAL_NOTICE', 'TUTORIAL_CHECK'].includes(t.id)));
    f.send('jump', { target: 'TUTORIAL_UNIT2' }); f.send('displayed');
    assert.equal(f.engine.view(f.id).phase, 'TUTORIAL_UNIT2'); assert.equal(f.engine.view(f.id).rest!.key, 'PRACTICE');
    assert.ok(!f.engine.summary(f.id).available_actions.includes('remind_rest'));
    assert.throws(() => f.engine.adminAction(f.id, 'remind_rest', '测试'), /只有被试处于第二单元/);
    f.engine.adminAction(f.id, 'debug_jump', '', 'TUTORIAL_UNIT1'); assert.equal(f.engine.view(f.id).phase, 'TUTORIAL_UNIT1');
  } finally { await f.engine.settle(); f.store.close(); }
});

test('导出：练习数据只进教程数据（tutorial.csv、rest_clicks标tutorial），不进trials.csv和rests.csv', async () => {
  const out = await mkdtemp(join(tmpdir(), 'a5-practice-export-'));
  const f = fixture();
  try {
    f.toUnit2(); f.advance(5000); f.send('rest_click'); f.send('rest_displayed'); f.advance(10000); f.engine.tick(f.id);
    f.send('rest_return_displayed'); f.send('submit', { answer: right2 });
    const files = unzipSync((await exportData(f.engine, [f.id], out)).bytes), text = (name: string) => strFromU8(files[name]);
    for (const needle of ['tutorial_answer_submitted', 'tutorial_unit_displayed', 'rest_started', 'PRACTICE_U2']) assert.ok(text('tutorial.csv').includes(needle), needle);
    for (const name of ['trials.csv', 'rests.csv', 'stage_summary.csv']) assert.ok(!text(name).includes('PRACTICE'), name);
    const clicks = text('rest_clicks.csv').split('\n').filter(l => l.includes('PRACTICE'));
    assert.equal(clicks.length, 1); assert.ok(clicks[0].includes('tutorial'));
  } finally { await f.engine.settle(); f.store.close(); await rm(out, { recursive: true, force: true }); }
});
