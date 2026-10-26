import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const config = await testConfig();
config.debug_participant = { participant_id: '000', debug: true, copied_from: '001', stages: material.content.stages.map((s, index) => ({ stage_id: s.stage_id, condition: 'N-T0', message_id: `N0${index + 1}` })) };
const ratingAnswer = { timing: '1', attention_distraction: '2', thought_disruption: '3', task_interference: '6', perceived_disturbance: '7' };
const visible = { visibility_state: 'visible' };
const send = (engine: Engine, id: string, action: string, extra = {}) => engine.command(id, {
  command_id: randomUUID(), page_token: engine.view(id).page_token, action, client: visible, ...extra,
});

test('七组任务按注意情况跳转：两题独立必答，内容题A/B/C及正误不影响跳转', async () => {
  for (const notice of ['not_noticed', 'partially_read', 'fully_read']) for (const answer of ['A', 'B', 'C']) {
    const store = new Store(':memory:');
    const engine = new Engine(store, new MockGlassesAdapter(), material, config);
    const id = engine.create('000').session_id;
    try {
      for (const stage of material.content.stages) {
        send(engine, id, 'jump', { target: `${stage.stage_id}_COMPREHENSION` });
        send(engine, id, 'displayed');
        const view = engine.view(id), stimulus = engine.stimulus(engine.session(id));
        assert.equal(view.title, '信息识读理解题');
        assert.deepEqual(view.fields.map(f => f.id), ['message_notice', 'answer']);
        assert.ok(view.fields.every(f => f.required));
        assert.deepEqual(view.answer, {});
        assert.equal(view.paragraphs.length, 1);
        assert.match(view.fields[1].label, /^第2题：/);
        assert.deepEqual(view.fields[1].options, stimulus.options.map(o => ({ value: o.id, label: `${o.id} ${o.text}` })));
        assert.equal(view.fields[1].options!.find(o => o.value === 'C')!.label, 'C 不记得或不确定');
        assert.ok(!JSON.stringify(view).includes('correct_option'));
        assert.throws(() => send(engine, id, 'submit', { answer: { answer } }), /完整填写/);
        assert.throws(() => send(engine, id, 'submit', { answer: { message_notice: notice } }), /完整填写/);
        assert.equal(engine.view(id).phase, 'COMPREHENSION');
        assert.equal(engine.view(id).answer.answer, undefined);
        send(engine, id, 'draft', { answer: { message_notice: notice, answer } });
        assert.equal(engine.view(id).phase, 'COMPREHENSION');
        assert.equal(engine.view(id).answer.answer, answer);
        assert.equal(store.events(id).filter(e => e.stage_id === stage.stage_id && e.event_type === 'ratings_skipped').length, 0);
        send(engine, id, 'submit', { answer: { message_notice: notice, answer } });
        const event = store.events(id).filter(e => e.event_type === 'comprehension_submitted').at(-1)!;
        assert.equal(event.payload.message_notice, notice);
        assert.equal(event.payload.answer, answer);
        assert.equal(event.payload.correct, answer === stimulus.correct_option);
        if (notice === 'not_noticed') {
          assert.equal(engine.view(id).phase, stage.stage_id === 'SH07' ? 'COMPLETED' : 'CARD');
          const events = store.events(id).filter(e => e.stage_id === stage.stage_id);
          const skipped = events.find(e => e.event_type === 'ratings_skipped')!;
          assert.equal(skipped.payload.reason, 'not_noticed');
          assert.equal(skipped.payload.message_id, stimulus.message_id);
          assert.ok(events.findIndex(e => e.event_type === 'comprehension_submitted') < events.indexOf(skipped));
          assert.equal(events.filter(e => e.event_type === 'ratings_displayed' || e.event_type === 'ratings_submitted').length, 0);
          assert.ok(!JSON.stringify(engine.view(id)).includes('correct_option'));
          continue;
        }
        const ratings = engine.view(id);
        assert.equal(ratings.phase, 'RATINGS');
        assert.equal(ratings.title, '信息体验评价量表');
        assert.deepEqual(ratings.answer, {});
        assert.deepEqual(ratings.fields.map(f => f.id), Object.keys(ratingAnswer));
        for (const [index, field] of ratings.fields.entries()) {
          assert.equal(field.required, true);
          assert.deepEqual(field.options!.map(o => o.value), ['1', '2', '3', '4', '5', '6', '7']);
          assert.ok(field.label.includes(index === 0 ? '1分（非常不合适） 7分（非常合适）' : '1分（完全不同意） 7分（完全同意）'));
        }
        send(engine, id, 'displayed');
        for (const field of ratings.fields) {
          const incomplete: Record<string, string> = { ...ratingAnswer };
          delete incomplete[field.id];
          assert.throws(() => send(engine, id, 'submit', { answer: incomplete }), /完整填写/);
        }
        assert.throws(() => send(engine, id, 'submit', { answer: { ...ratingAnswer, timing: '8' } }), /选项无效/);
        send(engine, id, 'submit', { answer: ratingAnswer });
        assert.equal(engine.view(id).phase, stage.stage_id === 'SH07' ? 'COMPLETED' : 'CARD');
        assert.deepEqual(store.events(id).filter(e => e.event_type === 'ratings_submitted').at(-1)!.payload.ratings,
          Object.fromEntries(Object.entries(ratingAnswer).map(([k, v]) => [k, Number(v)])));
      }
    } finally { await engine.settle(); store.close(); }
  }
});

test('理解及量表草稿重启后恢复，正式答案落盘并完整导出，历史量表字段不混用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a5-surveys-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  let engine = new Engine(store, new MockGlassesAdapter(), material, config);
  const id = engine.create('000').session_id;
  const reopen = async () => {
    await engine.settle(); store.close();
    store = new Store(path); engine = new Engine(store, new MockGlassesAdapter(), material, config);
  };
  try {
    send(engine, id, 'jump', { target: 'SH01_COMPREHENSION' }); send(engine, id, 'displayed');
    send(engine, id, 'draft', { answer: { message_notice: 'fully_read', answer: 'B' } });
    // 改选注意情况时保留原来的内容题答案，不能自动改成C。
    send(engine, id, 'draft', { answer: { message_notice: 'partially_read', answer: 'B' } });
    await reopen();
    assert.deepEqual(engine.view(id).answer, { message_notice: 'partially_read', answer: 'B' });
    send(engine, id, 'submit', { answer: engine.view(id).answer });
    send(engine, id, 'displayed'); send(engine, id, 'draft', { answer: ratingAnswer });
    await reopen();
    assert.deepEqual(engine.view(id).answer, ratingAnswer);
    send(engine, id, 'submit', { answer: engine.view(id).answer });
    await reopen();
    // V2取消组间休息：量表提交后直接进入下一组说明卡。
    assert.equal(engine.view(id).phase, 'CARD');
    assert.equal(engine.view(id).stage_number, 2);
    const files = unzipSync((await exportData(engine, [id], directory)).bytes);
    const rows = strFromU8(files['surveys.csv']).trim().split('\r\n').map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, '')));
    const row = Object.fromEntries(rows[0].map((key, index) => [key, rows[1][index]]));
    assert.equal(row.message_notice, 'partially_read');
    assert.equal(row.ratings_status, 'submitted');
    assert.equal(row.ratings_skip_reason, '');
    assert.equal(row.comprehension_answer, 'B');
    assert.equal(row.comprehension_correct, 'true');
    for (const [key, value] of Object.entries(ratingAnswer)) assert.equal(row[key], value);
    for (const key of ['disruption', 'effort', 'helpfulness']) assert.equal(row[key], '');
    const events = strFromU8(files['events.jsonl']).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.find(e => e.event_type === 'comprehension_submitted').payload.message_notice, 'partially_read');
    assert.equal(events.find(e => e.event_type === 'ratings_submitted').payload.ratings.perceived_disturbance, 7);
    const snapshot = JSON.parse(strFromU8(files['snapshots.json']))[0].snapshot;
    assert.equal(snapshot.content.survey_pages.comprehension.notice_field.id, 'message_notice');
    assert.equal(snapshot.content.ratings.length, 5);
  } finally { await engine.settle(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('未注意到提示时先保存理解题再跳过量表：落盘恢复、重复提交及导出均保留原因', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a5-survey-skip-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  let engine = new Engine(store, new MockGlassesAdapter(), material, config);
  const id = engine.create('000').session_id;
  try {
    send(engine, id, 'jump', { target: 'SH01_COMPREHENSION' }); send(engine, id, 'displayed');
    send(engine, id, 'draft', { answer: { message_notice: 'not_noticed' } });
    assert.equal(engine.view(id).phase, 'COMPREHENSION');
    assert.throws(() => send(engine, id, 'submit', { answer: { message_notice: 'not_noticed' } }), /完整填写/);
    const command = { command_id: randomUUID(), page_token: engine.view(id).page_token, action: 'submit', client: visible,
      answer: { message_notice: 'not_noticed', answer: 'C' } };
    // 保存失败时必须整体回滚，不能先跳转或留下半条正式记录。
    const save = store.save.bind(store);
    store.save = () => { throw new Error('test_save_failed'); };
    assert.throws(() => engine.command(id, command), /test_save_failed/);
    store.save = save;
    assert.equal(engine.view(id).phase, 'COMPREHENSION');
    assert.equal(store.events(id).filter(e => ['comprehension_submitted', 'ratings_skipped'].includes(e.event_type)).length, 0);
    assert.equal(engine.command(id, command).phase, 'CARD');
    assert.equal(engine.command(id, command).phase, 'CARD');
    await engine.settle(); store.close();
    store = new Store(path); engine = new Engine(store, new MockGlassesAdapter(), material, config);
    assert.equal(engine.view(id).phase, 'CARD');
    assert.equal(engine.view(id).stage_number, 2);
    const events = store.events(id);
    assert.equal(events.filter(e => e.event_type === 'comprehension_submitted').length, 1);
    assert.equal(events.filter(e => e.event_type === 'ratings_skipped').length, 1);
    assert.equal(events.filter(e => e.event_type === 'ratings_submitted').length, 0);
    const files = unzipSync((await exportData(engine, [id], directory)).bytes);
    const rows = strFromU8(files['surveys.csv']).trim().split('\r\n').map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, '')));
    const row = Object.fromEntries(rows[0].map((key, index) => [key, rows[1][index]]));
    assert.equal(row.message_notice, 'not_noticed');
    assert.equal(row.comprehension_answer, 'C');
    assert.equal(row.comprehension_correct, 'false');
    assert.equal(row.ratings_status, 'skipped');
    assert.equal(row.ratings_skip_reason, 'not_noticed');
    assert.ok(row.ratings_skipped_at);
    assert.equal(row.ratings_submitted, '');
    for (const key of Object.keys(ratingAnswer)) assert.equal(row[key], '');
    const savedEvents = strFromU8(files['events.jsonl']).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(savedEvents.find(e => e.event_type === 'ratings_skipped').payload.reason, 'not_noticed');
  } finally { await engine.settle(); store.close(); await rm(directory, { recursive: true, force: true }); }
  // 旧快照（无 in_unit_rest）：跳过量表后仍进入组间休息，可跳过休息进入下一组。
  const legacy = { ...material, content: { ...material.content, in_unit_rest: undefined, break_ms: 30000, break_start_on_display: true, allow_break_skip: true } };
  const oldStore = new Store(':memory:'), oldEngine = new Engine(oldStore, new MockGlassesAdapter(), legacy, config);
  const oldId = oldEngine.create('000').session_id;
  try {
    send(oldEngine, oldId, 'jump', { target: 'SH01_COMPREHENSION' }); send(oldEngine, oldId, 'displayed');
    assert.equal(send(oldEngine, oldId, 'submit', { answer: { message_notice: 'not_noticed', answer: 'C' } }).phase, 'BREAK');
    assert.equal(oldStore.events(oldId).filter(e => e.event_type === 'ratings_skipped' && e.payload.reason === 'not_noticed').length, 1);
    send(oldEngine, oldId, 'displayed'); send(oldEngine, oldId, 'skip_break');
    assert.equal(oldEngine.view(oldId).phase, 'CARD');
    assert.equal(oldEngine.view(oldId).stage_number, 2);
  } finally { await oldEngine.settle(); oldStore.close(); }
});

test('无消息条件七组均跳过两页并记录原因，不伪造问卷回答或评分', async () => {
  const noneConfig = structuredClone(config);
  noneConfig.debug_participant!.stages = material.content.stages.map(s => ({ stage_id: s.stage_id, condition: 'NONE', message_id: null }));
  const store = new Store(':memory:');
  const engine = new Engine(store, new MockGlassesAdapter(), material, noneConfig);
  const id = engine.create('000').session_id;
  const directory = await mkdtemp(join(tmpdir(), 'a5-none-surveys-'));
  try {
    for (const stage of material.content.stages) {
      send(engine, id, 'jump', { target: `${stage.stage_id}_U1` }); send(engine, id, 'displayed');
      send(engine, id, 'reveal', { open: true }); send(engine, id, 'reveal_displayed');
      for (const unit of stage.units) {
        const answer = unit.scoring.type === 'exact' ? structuredClone(unit.scoring.expected) :
          { checkin: '许宁', guide: '林晨', equipment: unit.unit_id.endsWith('U1') ? '赵禾' : '梁欣' };
        send(engine, id, 'submit', { answer });
        if (unit.unit_id.endsWith('U1')) send(engine, id, 'displayed');
      }
      assert.equal(engine.view(id).phase, stage.stage_id === 'SH07' ? 'COMPLETED' : 'CARD');
      const events = store.events(id).filter(e => e.stage_id === stage.stage_id);
      assert.equal(events.filter(e => e.event_type === 'comprehension_skipped' && e.payload.reason === 'no_message').length, 1);
      assert.equal(events.filter(e => e.event_type === 'ratings_skipped' && e.payload.reason === 'no_message').length, 1);
      assert.equal(events.filter(e => ['comprehension_displayed', 'comprehension_submitted', 'ratings_displayed', 'ratings_submitted'].includes(e.event_type)).length, 0);
    }
    assert.equal(store.interventions(id).length, 0);
    const output = await exportData(engine, [id], directory);
    assert.equal(output.row_counts.surveys, 0);
    const files = unzipSync(output.bytes);
    assert.ok(strFromU8(files['events.jsonl']).includes('"reason":"no_message"'));
  } finally { await engine.settle(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('未启用跳转的v7问卷快照维持原流程', async () => {
  const previous = structuredClone(material);
  delete previous.content.survey_pages!.ratings.skip_if_not_noticed;
  const store = new Store(':memory:');
  const engine = new Engine(store, new MockGlassesAdapter(), previous, config);
  const id = engine.create('000').session_id;
  try {
    send(engine, id, 'jump', { target: 'SH01_COMPREHENSION' }); send(engine, id, 'displayed');
    send(engine, id, 'submit', { answer: { message_notice: 'not_noticed', answer: 'C' } });
    assert.equal(engine.view(id).phase, 'RATINGS');
    assert.equal(store.events(id).filter(e => e.event_type === 'ratings_skipped').length, 0);
  } finally { await engine.settle(); store.close(); }
});

test('旧快照保留单道理解题和旧量表，新增导出字段为空', async () => {
  const legacy = structuredClone(material);
  delete legacy.content.survey_pages;
  delete legacy.content.survey_revision_id;
  legacy.content.ratings = ['timing', 'disruption', 'effort', 'helpfulness'].map(id => ({ id, label: id, min: 1, max: 7 }));
  const store = new Store(':memory:');
  const engine = new Engine(store, new MockGlassesAdapter(), legacy, config);
  const directory = await mkdtemp(join(tmpdir(), 'a5-legacy-surveys-'));
  const id = engine.create('000').session_id;
  try {
    send(engine, id, 'jump', { target: 'SH01_COMPREHENSION' }); send(engine, id, 'displayed');
    assert.deepEqual(engine.view(id).fields.map(f => f.id), ['answer']);
    send(engine, id, 'submit', { answer: { answer: 'C' } }); send(engine, id, 'displayed');
    const ratings = { timing: '4', disruption: '3', effort: '2', helpfulness: '6' };
    send(engine, id, 'submit', { answer: ratings });
    const files = unzipSync((await exportData(engine, [id], directory)).bytes);
    const rows = strFromU8(files['surveys.csv']).trim().split('\r\n').map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, '')));
    const row = Object.fromEntries(rows[0].map((key, index) => [key, rows[1][index]]));
    assert.equal(row.message_notice, '');
    for (const key of ['attention_distraction', 'thought_disruption', 'task_interference', 'perceived_disturbance']) assert.equal(row[key], '');
    for (const [key, value] of Object.entries(ratings)) assert.equal(row[key], value);
  } finally { await engine.settle(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
