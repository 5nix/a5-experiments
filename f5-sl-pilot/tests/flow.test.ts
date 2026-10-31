import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { Store } from '@a5/desktop/store.ts';
import { Engine } from '@a5/desktop/engine.ts';
import { exportData } from '@a5/desktop/export.ts';
import { expectedAnswers, loadMaterial } from '@a5/desktop/tasks.ts';
import { MockGlassesAdapter } from '@a5/glasses/adapters/mock-glasses.ts';
import type { DisplayMode } from '@a5/desktop/contracts.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testConfig } from './fixtures.ts';

const material = await loadMaterial();
const config = await testConfig();
const rest = material.content.in_unit_rest!;
const visible = { visibility_state: 'visible' };
const unitOf = (id: string) => material.content.stages.flatMap(s => s.units).find(u => u.unit_id === id)!;
const right = (id: string) => ({ ...expectedAnswers(unitOf(id)) }) as Record<string, unknown>;
const fieldIds = (id: string) => unitOf(id).fields.map(f => f.id);
/** 前n个作答项填入正确答案，其余留空。 */
const first = (id: string, n: number) => Object.fromEntries(fieldIds(id).map((k, i) => [k, i < n ? String(right(id)[k]) : '']));

function fixture(mode: DisplayMode = 'legacy_8500', metadata: Record<string, unknown> = {}) {
  let now = Date.parse('2026-10-31T08:00:00Z');
  const clock = { wall: () => now, mono: () => now };
  const store = new Store(':memory:'), engine = new Engine(store, new MockGlassesAdapter(), material, config, clock);
  const id = engine.create('000', { display_mode: mode, ...metadata }).session_id;
  const f = {
    store, engine, id,
    send: (action: string, extra = {}) => engine.command(id, { command_id: randomUUID(), page_token: engine.view(id).page_token, action, client: visible, ...extra }),
    advance(ms: number) { now += ms; engine.tick(id); },
    events: (type: string) => store.events(id).filter(e => e.event_type === type),
    messages: () => store.interventions(id).filter(m => !m.data_kind || m.data_kind === 'formal'),
    async close() { await engine.settle(); store.close(); },
    /** 进入某组U1并报告可见。 */
    toU1(stage: string) { f.send('jump', { target: `${stage}_U1` }); f.send('displayed'); },
    async toU2(stage: string) { f.toU1(stage); f.send('submit', { answer: right(`${stage}_U1`) }); f.send('displayed'); await engine.settle(); },
  };
  return f;
}
const beforeTrigger = (f: ReturnType<typeof fixture>) => f.messages().length;

test('000调试身份覆盖七种条件：SL01 N-T0、SL02 N-T1、SL03 A-T0、SL04 A-T1、SL05 N-T2、SL06 A-T2、SL07 NONE', () => {
  const f = fixture();
  assert.deepEqual(f.engine.session(f.id).snapshot.participant.stages.map(s => `${s.stage_id}:${s.condition}:${s.message_id}`),
    ['SL01:N-T0:N01', 'SL02:N-T1:N02', 'SL03:A-T0:A03', 'SL04:A-T1:A04', 'SL05:N-T2:N05', 'SL06:A-T2:A06', 'SL07:NONE:null']);
});

test('T0：非空作答项第一次达到3个（失去焦点）后恰好2秒送达；清空或修改不重新计算', async () => {
  const f = fixture();
  try {
    f.toU1('SL01');
    assert.equal(f.engine.view(f.id).report_answer_blur, true);
    assert.equal(f.engine.view(f.id).reveal, null, 'U1没有附件，也没有E');
    f.send('answers_blur', { answer: first('SL01_U1', 2) });
    assert.equal(f.events('answers_threshold_reached').length, 0);
    f.advance(5000); assert.equal(f.messages().length, 0, '只有2个作答项，不触发');
    const answers = first('SL01_U1', 3);
    f.send('answers_blur', { answer: answers });
    const threshold = f.events('answers_threshold_reached')[0];
    assert.equal(threshold.payload.answered_fields, 3);
    assert.equal(threshold.payload.trigger, 'blur');
    assert.equal(f.engine.view(f.id).report_answer_blur, false, '之后不再要求上报');
    f.advance(1999); await f.engine.settle(); assert.equal(f.messages().length, 0, '1999毫秒还不送达');
    f.advance(1); await f.engine.settle();
    const [message] = f.messages();
    assert.equal(message.message_id, 'N01');
    assert.equal(message.event_elapsed_ms, threshold.elapsed_ms + 2000);
    assert.equal(f.events('t0_due')[0].payload.actual_delay_ms, 2000);
    assert.equal(f.events('message_scheduled')[0].payload.timing, 'T0');
    assert.ok(['accepted', 'send_requested'].includes(message.status));
    // 清空后再填，不重新计时、不重复发送
    f.send('answers_blur', { answer: first('SL01_U1', 0) }); f.send('answers_blur', { answer: first('SL01_U1', 4) });
    f.advance(10000); await f.engine.settle();
    assert.equal(f.messages().length, 1); assert.equal(f.events('answers_threshold_reached').length, 1);
    // 草稿随失去焦点保存
    assert.deepEqual(f.engine.view(f.id).answer, first('SL01_U1', 4));
  } finally { await f.close(); }
});

test('T0：填完第3个作答项前提交也只在达到阈值后触发；暂停会冻结T0的2秒计时', async () => {
  const f = fixture();
  try {
    f.toU1('SL01');
    f.send('answers_blur', { answer: first('SL01_U1', 3) });
    f.advance(1000);
    f.engine.adminAction(f.id, 'pause', '测试暂停');
    f.advance(5000);
    f.engine.adminAction(f.id, 'resume', '测试恢复');
    f.advance(999); await f.engine.settle(); assert.equal(f.messages().length, 0, '暂停时间不计入2秒');
    f.advance(1); await f.engine.settle(); assert.equal(f.messages().length, 1);
  } finally { await f.close(); }
});

test('非T0组只记录阈值事件，不送达消息；NONE组同样', async () => {
  const f = fixture();
  try {
    for (const stage of ['SL02', 'SL05', 'SL07']) {
      f.toU1(stage); f.send('answers_blur', { answer: first(`${stage}_U1`, 3) });
      assert.equal(f.events('answers_threshold_reached').at(-1)!.stage_id, stage);
      f.advance(5000); await f.engine.settle();
    }
    assert.equal(f.messages().length, 0);
    assert.equal(f.events('t0_due').length, 0);
  } finally { await f.close(); }
});

test('U1没有附件：不要求查看补充资料即可提交；提交后进入U2并记录逐项对错', async () => {
  const f = fixture();
  try {
    f.toU1('SL04');
    const wrong = right('SL04_U1'); wrong.i5 = 25; // 整理接待台：正确是21
    f.send('submit', { answer: wrong });
    assert.equal(f.engine.view(f.id).title, '第二单元：资料与设备准备记录');
    const scored = f.events('unit_scored')[0].payload;
    assert.equal(scored.score, 7); assert.equal(scored.max_score, 8);
    assert.deepEqual((scored.item_results as Record<string, boolean>).i5, false);
    assert.equal(Object.values(scored.item_results as Record<string, boolean>).filter(Boolean).length, 7);
    assert.equal(f.events('reveal_displayed').length, 0, '没有E标记');
  } finally { await f.close(); }
});

test('T1：U1提交后U2首次实际呈现时送达', async () => {
  const f = fixture();
  try {
    f.toU1('SL02'); f.send('submit', { answer: right('SL02_U1') });
    assert.equal(f.messages().length, 0, '提交时不送达');
    f.send('displayed'); await f.engine.settle();
    assert.equal(f.messages()[0].message_id, 'N02');
    assert.equal(f.events('message_scheduled')[0].payload.timing, 'T1');
  } finally { await f.close(); }
});

test('T2：U2呈现10秒内点击休息只提示；满10秒可休息，休息页可见后5秒送达，休息30秒', async () => {
  const f = fixture();
  try {
    await f.toU2('SL05');
    f.advance(9999);
    f.send('rest_click');
    assert.equal(f.engine.view(f.id).rest!.state, 'idle');
    assert.equal(f.engine.view(f.id).rest!.feedback!.text, '请先做一部分再休息');
    assert.equal(f.events('rest_clicked').at(-1)!.payload.disposition, 'too_early');
    f.advance(1);
    f.send('rest_click'); f.send('rest_displayed');
    assert.equal(f.engine.view(f.id).rest!.duration_ms, 30000);
    f.advance(4999); await f.engine.settle(); assert.equal(f.messages().length, 0);
    f.advance(1); await f.engine.settle();
    assert.equal(f.messages()[0].message_id, 'N05');
    assert.equal(f.events('message_scheduled')[0].payload.timing, 'T2');
    f.advance(25000); assert.equal(f.engine.view(f.id).rest!.state, 'returning');
    f.send('rest_return_displayed'); assert.equal(f.engine.view(f.id).rest!.state, 'done');
  } finally { await f.close(); }
});

test('T2组未休息即提交：不送达，记录t2_not_triggered，跳过理解题和评价', async () => {
  const f = fixture();
  try {
    await f.toU2('SL06');
    f.advance(60000);
    f.send('submit', { answer: right('SL06_U2') });
    assert.equal(f.messages().length, 0);
    assert.equal(f.events('t2_not_triggered').length, 1);
    assert.equal(f.engine.view(f.id).title, f.engine.session(f.id).snapshot.content.stages[6].title, '直接进入下一组说明卡');
  } finally { await f.close(); }
});

test('NONE组可休息一次但不触发消息；七组走完直接完成', async () => {
  const f = fixture();
  try {
    await f.toU2('SL07'); f.advance(10000);
    f.send('rest_click'); f.send('rest_displayed'); f.advance(30000); f.send('rest_return_displayed');
    f.send('submit', { answer: right('SL07_U2') });
    assert.equal(f.messages().length, 0);
    assert.equal(f.engine.session(f.id).state.status, 'completed');
  } finally { await f.close(); }
});

test('练习：单元1→单元2（须在5秒窗口后休息一次、休息5秒才能提交）→情景导入；数据标记tutorial', async () => {
  const f = fixture('legacy_8500', { tutorial_enabled: true });
  try {
    assert.equal(f.engine.view(f.id).phase, 'TUTORIAL_INTRO');
    f.send('displayed'); f.send('continue'); f.send('displayed');
    assert.equal(f.engine.view(f.id).title, '练习单元1：东侧书架');
    assert.equal(f.engine.view(f.id).reveal, null);
    f.send('submit', { answer: { A: '6', B: '12', C: '8', D: '10' } });
    f.send('displayed');
    const view = f.engine.view(f.id);
    assert.equal(view.title, '练习单元2：西侧书架'); assert.equal(view.rest!.duration_ms, 5000);
    f.send('draft', { answer: { F: '6', G: '8', H: '', I: '' } });
    assert.throws(() => f.send('submit', { answer: { F: '6', G: '8', H: '15', I: '12' } }), /练习一次休息/);
    f.advance(4999); f.send('rest_click');
    assert.equal(f.engine.view(f.id).rest!.state, 'idle', '练习窗口5秒内只提示');
    f.advance(1); f.send('rest_click'); f.send('rest_displayed');
    assert.throws(() => f.send('draft', { answer: { F: '6', G: '8', H: '15', I: '12' } }), /正在休息/);
    f.advance(5000); f.send('rest_return_displayed');
    f.send('submit', { answer: { F: '6', G: '8', H: '15', I: '12' } });
    assert.equal(f.engine.view(f.id).phase, 'INTRO', '没有持续确认模式时直接进入情景导入');
    assert.ok(f.store.events(f.id).filter(e => e.event_type === 'tutorial_answer_submitted').every(e => e.data_kind === 'tutorial'));
    assert.equal(f.messages().length, 0);
    assert.equal(f.events('answers_threshold_reached').length, 0, '练习不触发T0');
  } finally { await f.close(); }
});

test('练习之后：含持续确认模式时先练习消息和理解题，再进入情景导入', async () => {
  const f = fixture('confirm_until_ack', { tutorial_enabled: true });
  try {
    f.send('displayed'); f.send('continue'); f.send('displayed');
    f.send('submit', { answer: { A: '6', B: '12', C: '8', D: '10' } }); f.send('displayed');
    f.advance(5000); f.send('rest_click'); f.send('rest_displayed'); f.advance(5000); f.send('rest_return_displayed');
    f.send('submit', { answer: { F: '6', G: '8', H: '15', I: '12' } });
    assert.equal(f.engine.view(f.id).phase, 'TUTORIAL_NOTICE');
    assert.deepEqual(f.engine.debugTargets(f.engine.session(f.id)).slice(0, 5).map(t => t.id), ['TUTORIAL_INTRO', 'TUTORIAL_UNIT1', 'TUTORIAL_UNIT2', 'TUTORIAL_NOTICE', 'TUTORIAL_CHECK']);
  } finally { await f.close(); }
});

test('导出：trials.csv含逐项对错与答对数，事件含阈值与T0；没有E与F', async () => {
  const f = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'a5-sl-export-'));
  try {
    f.toU1('SL01');
    const wrong = right('SL01_U1'); wrong.i1 = 99;
    f.send('answers_blur', { answer: { ...wrong } }); f.advance(2000); await f.engine.settle();
    f.send('submit', { answer: wrong });
    const files = unzipSync((await exportData(f.engine, [f.id], directory)).bytes);
    const trials = strFromU8(files['trials.csv']);
    const header = trials.split('\r\n')[0];
    assert.ok(header.includes('"max_score"') && header.includes('"item_results"'));
    assert.ok(trials.includes('i1') && trials.includes('false'));
    const events = strFromU8(files['events.jsonl']);
    for (const type of ['answers_threshold_reached', 't0_due', 'unit_scored']) assert.ok(events.includes(`"${type}"`), type);
    assert.ok(!events.includes('"reveal_displayed"') && !events.includes('"F_candidate"'));
  } finally { await rm(directory, { recursive: true, force: true }); await f.close(); }
});
