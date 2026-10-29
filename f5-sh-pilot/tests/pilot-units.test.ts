import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { loadMaterial, minutes, normalize, score } from '../src/tasks.ts';
import type { TaskContent, Unit } from '../src/tasks.ts';
import { readJson, experimentRoot } from '../src/preflight.ts';
import { exportData } from '../src/export.ts';
import { testConfig } from './fixtures.ts';

const material = await loadMaterial(), config = await testConfig();
const baseline = await readJson<{
  content: TaskContent; replacement_unit_hashes: Record<string, string>; protected_json_hashes: Record<string, string>;
  prd_sha256: string; source_json_sha256: string; source_document_sha256: string;
}>('tests/fixtures/pilot-units-v12.json');
const revision = (await readJson<{ pilot_unit_revision: {
  revision_id: string; content_version: string; units: Unit[]; unchanged_unit_ids: string[];
  removed_fields_by_unit: Record<string, string[]>; source_json_sha256: string; source_document_sha256: string;
} }>('content/revisions.json')).pilot_unit_revision;
const byId = (content: TaskContent, id: string) => content.stages.flatMap(s => s.units).find(u => u.unit_id === id)!;
const units = revision.units.map(u => byId(material.content, u.unit_id));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exactAnswers: Record<string, Record<string, unknown>> = {
  SH02_U1: { training: '10:45', acceptance: '11:15', on_time: '能' },
  SH05_U1: { badge_gap: 4, guide_gap: 0, record_gap: 7 },
  SH05_U2: { plan: 'D', record_surplus: 3 },
  SH06_U1: { manual: 176, briefing: 180, total: 524, enough: '不够用' },
  SH07_U1: { group_b: 360, group_c: 300, groups: ['A', 'C'] },
  SH07_U2: { group_b: 340, group_c: 284, groups: ['A', 'B', 'C'] },
};
const answerFor = (unit: Unit) => unit.scoring.type === 'exact' ? structuredClone(exactAnswers[unit.unit_id])
  : { checkin: '林晨', guide: '陈珂', equipment: unit.unit_id.endsWith('U1') ? '赵禾' : '梁欣' };
function wrongAnswer(unit: Unit, fieldId = unit.fields[0].id) {
  const raw = answerFor(unit), field = unit.fields.find(f => f.id === fieldId)!;
  if (field.type === 'multi') raw[fieldId] = ['B'];
  else if (field.type === 'single') raw[fieldId] = field.options!.find(o => o.value !== raw[fieldId])!.value;
  else if (field.type === 'time') raw[fieldId] = '10:44';
  else raw[fieldId] = Number(raw[fieldId]) + 1;
  return raw;
}
function fixture(mat = material, path = ':memory:') {
  let now = Date.parse('2026-10-27T00:00:00Z');
  const store = new Store(path), clock = { wall: () => now, mono: () => now };
  const engine = new Engine(store, new MockGlassesAdapter(), mat, config, clock);
  const id = engine.create('000').session_id;
  const send = (action: string, extra = {}) => engine.command(id, { command_id: randomUUID(), page_token: engine.view(id).page_token, action, client: { visibility_state: 'visible' }, ...extra });
  return { store, engine, id, clock, send, advance: (ms: number) => { now += ms; },
    async close() { if (engine.session(id).state.status === 'active') engine.adminAction(id, 'stop', '隔离测试结束'); await engine.settle(); store.close(); } };
}

test('定稿完整替换8个Unit：独立交付数据哈希一致，7组14单元22表41字段，删除字段与旧expected不残留', () => {
  assert.equal(material.content.content_version, 'sh-v2-2026-10-27-v13');
  assert.equal(material.content.pilot_unit_revision_id, 'user-approved-pilot-unit-materials-2026-10-27-v1');
  assert.equal(revision.source_json_sha256, baseline.source_json_sha256);
  assert.equal(revision.source_document_sha256, baseline.source_document_sha256);
  assert.deepEqual(units.map(u => u.fields.length), [3, 3, 3, 3, 2, 4, 3, 3]);
  assert.equal(units.reduce((n, u) => n + u.fields.length, 0), 24);
  const all = material.content.stages.flatMap(s => s.units);
  assert.equal(material.content.stages.length, 7); assert.equal(all.length, 14);
  assert.equal(all.reduce((n, u) => n + u.fields.length, 0), 41);
  assert.equal(all.reduce((n, u) => n + (u.tables?.length ?? 0) + (u.reveal?.tables?.length ?? 0), 0), 22);
  for (const unit of units) {
    assert.equal(digest(unit), baseline.replacement_unit_hashes[unit.unit_id], unit.unit_id);
    assert.deepEqual(unit, revision.units.find(u => u.unit_id === unit.unit_id));
    assert.ok(unit.fields.every(f => f.required && !('default' in f) && !('value' in f)));
    assert.equal(!!unit.reveal, unit.unit_id.endsWith('U1'));
    for (const deleted of revision.removed_fields_by_unit[unit.unit_id]) {
      assert.ok(!unit.fields.some(f => f.id === deleted));
      if (unit.scoring.type === 'exact') assert.ok(!(deleted in unit.scoring.expected));
    }
    if (unit.scoring.type === 'exact') assert.deepEqual(Object.keys(unit.scoring.expected).sort(), unit.fields.map(f => f.id).sort());
  }
  const staffing = byId(material.content, 'SH04_U1');
  assert.ok(staffing.tables!.some(t => t.columns.includes('可以承担的岗位')));
  assert.deepEqual(staffing.reveal!.tables![0].columns, ['姓名', '到岗时间']);
  assert.equal(byId(material.content, 'SH05_U2').fields.find(f => f.id === 'record_surplus')!.type, 'integer');
  assert.match(byId(material.content, 'SH05_U1').fields.find(f => f.id === 'guide_gap')!.label, /（份）/);
});

test('其余6个Unit深比较不变；任务组元数据、流程参数、刺激、预分配与PRD保持基线', async () => {
  assert.equal(revision.unchanged_unit_ids.length, 6);
  for (const id of revision.unchanged_unit_ids) assert.deepEqual(byId(material.content, id), byId(baseline.content, id), id);
  const headers = (content: TaskContent) => content.stages.map(({ units: _units, ...header }) => header);
  assert.deepEqual(headers(material.content), headers(baseline.content));
  const { stages: _newStages, content_version: _newVersion, pilot_unit_revision_id: _newRevision, ...current } = material.content;
  const { stages: _oldStages, content_version: _oldVersion, ...old } = baseline.content;
  assert.deepEqual(current, old);
  assert.equal(material.content.in_unit_rest!.window_min_ms, 30000);
  assert.equal(material.content.in_unit_rest!.duration_ms, 30000);
  assert.equal(material.content.in_unit_rest!.t2_delay_ms, 5000);
  for (const [path, expected] of Object.entries(baseline.protected_json_hashes)) assert.equal(digest(await readJson(path)), expected, path);
  assert.equal(createHash('sha256').update(await readFile(join(experimentRoot, 'docs/PRD.md'))).digest('hex'), baseline.prd_sha256);
  const second = byId(material.content, 'SH02_U2');
  assert.equal(second.scoring.type, 'exact');
  if (second.scoring.type === 'exact') assert.deepEqual(second.scoring.expected, { training: '11:00', acceptance: '11:45', on_time: '不能' });
  const printing = byId(material.content, 'SH06_U2');
  if (printing.scoring.type === 'exact') assert.deepEqual(printing.scoring.expected, { manual: 144, briefing: 156, total: 468, enough: '够用' });
});

test('六个exact单元独立计算答案得1，逐字段有效错误得0；缺项拒绝且不再要求已删字段', () => {
  // 计算依据来自定稿而非生成后的expected。
  const training = Math.max(minutes('10:30') + 15, minutes('10:30'));
  const acceptance = Math.max(training + 30, minutes('11:00'));
  assert.equal(training, minutes('10:45')); assert.equal(acceptance, minutes('11:15'));
  assert.ok(acceptance + 30 <= minutes('12:00'));
  assert.equal(11 * 16, 176); assert.equal(15 * 12, 180); assert.equal(168 + 176 + 180, 524);
  assert.equal(10 * 30 + 60, 360); assert.equal(8 * 30 + 60, 300);
  assert.equal(360 - 10 * 2, 340); assert.equal(300 - 8 * 2, 284);
  assert.equal(24 + 6 - (28 - 2), 4); assert.equal(Math.max(0, 24 + 3 * 2 - (35 - 3)), 0);
  assert.equal(24 * 2 + 3 - (48 - 4), 7); assert.equal(10 - 7, 3);
  const offers = [
    { id: 'A', badges: 5, records: 10, delivery: 19 * 1440 + 18 * 60, cost: 140 },
    { id: 'B', badges: 4, records: 7, delivery: 20 * 1440 + 13 * 60, cost: 105 },
    { id: 'C', badges: 5, records: 4, delivery: 20 * 1440 + 10 * 60, cost: 90 },
    { id: 'D', badges: 5, records: 10, delivery: 20 * 1440 + 11 * 60 + 30, cost: 125 },
  ];
  assert.deepEqual(offers.filter(o => o.badges >= 4 && o.records >= 7 && o.cost <= 130 && o.delivery <= 20 * 1440 + 12 * 60).map(o => o.id), ['D']);
  for (const unit of units.filter(u => u.scoring.type === 'exact')) {
    const raw = answerFor(unit);
    assert.equal(score(unit, normalize(unit.fields, raw)), 1, unit.unit_id);
    for (const field of unit.fields) {
      const missing = { ...raw }; delete missing[field.id];
      assert.throws(() => normalize(unit.fields, missing), /完整填写/);
      assert.equal(score(unit, normalize(unit.fields, wrongAnswer(unit, field.id))), 0, `${unit.unit_id}.${field.id}`);
    }
    for (const deleted of revision.removed_fields_by_unit[unit.unit_id]) assert.throws(() => normalize(unit.fields, { ...raw, [deleted]: '0' }), /不属于本题/);
  }
  const schedule = byId(material.content, 'SH02_U1');
  assert.equal(score(schedule, normalize(schedule.fields, { training: ' １０：４５ ', acceptance: '11∶15', on_time: '能' })), 1);
  const purchase = byId(material.content, 'SH05_U2');
  for (const invalid of ['不适用', '-1', '3.5']) assert.throws(() => normalize(purchase.fields, { plan: 'D', record_surplus: invalid }));
  for (const id of ['SH07_U1', 'SH07_U2']) {
    const unit = byId(material.content, id), raw = answerFor(unit), groups = raw.groups as string[];
    assert.equal(score(unit, normalize(unit.fields, { ...raw, groups: [...groups].reverse() })), 1);
    assert.equal(score(unit, normalize(unit.fields, { ...raw, groups: groups.slice(1) })), 0);
    if (id === 'SH07_U1') assert.equal(score(unit, normalize(unit.fields, { ...raw, groups: ['A', 'B', 'C'] })), 0);
    assert.deepEqual(unit.fields.find(f => f.id === 'groups')!.options, ['A', 'B', 'C'].map(value => ({ value, label: `${value}组` })));
  }
});

test('排班枚举全部64/125种安排：U1恰4种、U2恰1种；候选不预过滤，重复/迟到/缺席均得0', () => {
  const expected: Record<string, string[]> = {
    SH04_U1: ['林晨/陈珂/周悦', '林晨/陈珂/赵禾', '周悦/林晨/赵禾', '周悦/陈珂/赵禾'],
    SH04_U2: ['林晨/陈珂/梁欣'],
  };
  for (const id of Object.keys(expected)) {
    const unit = byId(material.content, id), names = unit.fields[0].options!.map(o => o.value);
    assert.equal(unit.scoring.type, 'staffing');
    for (const field of unit.fields) assert.deepEqual(field.options!.map(o => o.value), names);
    const accepted: string[] = []; let checked = 0;
    for (const checkin of names) for (const guide of names) for (const equipment of names) {
      const key = `${checkin}/${guide}/${equipment}`;
      const result = score(unit, normalize(unit.fields, { checkin, guide, equipment }));
      assert.equal(result, expected[id].includes(key) ? 1 : 0, `${id}:${key}`);
      if (result) accepted.push(key); checked++;
    }
    assert.equal(checked, id === 'SH04_U1' ? 64 : 125);
    assert.deepEqual(accepted.sort(), [...expected[id]].sort());
  }
});

test('8个单元公开view空白无评分；U1仍需实际打开附件，完整错误可提交，U2不继承U1答案', async () => {
  for (const unit of units) {
    const f = fixture();
    try {
      f.send('jump', { target: unit.unit_id }); f.send('displayed');
      const view = f.engine.view(f.id);
      assert.deepEqual(view.answer, {}); assert.deepEqual(view.fields, unit.fields);
      assert.equal(f.engine.summary(f.id).total_fields, unit.fields.length);
      assert.doesNotMatch(JSON.stringify(view), /"(?:scoring|expected|correct_option)"/);
      const raw = unit.scoring.type === 'exact' ? wrongAnswer(unit) : { checkin: '林晨', guide: '林晨', equipment: '赵禾' };
      if (unit.reveal) {
        assert.throws(() => f.send('submit', { answer: raw }), /查看补充资料/);
        f.send('reveal', { open: true });
        assert.throws(() => f.send('submit', { answer: raw }), /查看补充资料/);
        f.send('reveal_displayed');
      }
      const next = f.send('submit', { answer: raw });
      const scored = f.store.events(f.id).find(e => e.event_type === 'unit_scored' && e.unit_id === unit.unit_id)!;
      assert.equal(scored.payload.score, 0);
      if (unit.unit_id.endsWith('U1')) { assert.equal(next.phase, 'UNIT'); assert.deepEqual(next.answer, {}); }
    } finally { await f.close(); }
  }
});

test('休息进度从新快照字段读取：SH05_U2只有2项，已答1项和原始答案进入rest_started', async () => {
  const f = fixture();
  try {
    f.send('jump', { target: 'SH05_U2' }); f.send('displayed');
    f.send('draft', { answer: { plan: 'D' } }); f.advance(30000);
    assert.equal(f.engine.summary(f.id).answered_fields, 1);
    assert.equal(f.engine.summary(f.id).total_fields, 2);
    f.send('rest_click'); f.send('rest_displayed');
    const started = f.store.events(f.id).find(e => e.event_type === 'rest_started')!;
    assert.equal(started.payload.answered_fields, 1); assert.equal(started.payload.total_fields, 2);
    assert.deepEqual(started.payload.answer_snapshot, { plan: 'D' });
  } finally { await f.close(); }
});

test('v12历史快照与旧字段评分、答案、分配和导出在加载v13后保持原状，新会话使用v13', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a5-unit-history-'));
  const oldMaterial = { ...material, content: structuredClone(baseline.content) };
  const f = fixture(oldMaterial, join(directory, 'history.sqlite'));
  let reopened: Store | undefined, oldClosed = false;
  try {
    f.send('jump', { target: 'SH05_U1' }); f.send('displayed');
    f.send('reveal', { open: true }); f.send('reveal_displayed');
    const oldUnit = byId(baseline.content, 'SH05_U1');
    assert.equal(oldUnit.fields.length, 6); assert.equal(oldUnit.scoring.type, 'exact');
    if (oldUnit.scoring.type !== 'exact') throw new Error('旧材料评分类型不符');
    f.send('submit', { answer: oldUnit.scoring.expected }); f.send('displayed');
    f.send('draft', { answer: { plan: 'D', badge_surplus: '1', record_surplus: '3' } });
    f.engine.adminAction(f.id, 'stop', '历史会话隔离夹具'); await f.engine.settle();
    const snapshot = structuredClone(f.engine.session(f.id).snapshot), drafts = structuredClone(f.engine.session(f.id).state.drafts);
    const events = f.store.events(f.id);
    const before = unzipSync((await exportData(f.engine, [f.id], join(directory, 'before'))).bytes);
    f.store.close(); oldClosed = true;
    reopened = new Store(join(directory, 'history.sqlite'));
    const engine = new Engine(reopened, new MockGlassesAdapter(), material, config, f.clock);
    assert.deepEqual(engine.session(f.id).snapshot, snapshot);
    assert.deepEqual(engine.session(f.id).state.drafts, drafts); assert.deepEqual(reopened.events(f.id), events);
    assert.equal(engine.session(f.id).snapshot.content.content_version, 'sh-v2-2026-10-26-v12');
    const after = unzipSync((await exportData(engine, [f.id], join(directory, 'after'))).bytes);
    for (const name of ['trials.csv', 'snapshots.json', 'events.jsonl', 'surveys.csv', 'interventions.csv']) assert.equal(strFromU8(after[name]), strFromU8(before[name]), name);
    const trial = reopened.events(f.id).find(e => e.event_type === 'submission_recorded')!;
    assert.deepEqual(trial.payload.raw_answer, oldUnit.scoring.expected);
    assert.deepEqual(trial.payload.normalized_answer, normalize(oldUnit.fields, oldUnit.scoring.expected));
    const created = engine.create('001');
    assert.equal(engine.session(created.session_id).snapshot.content.content_version, 'sh-v2-2026-10-27-v13');
    assert.equal(byId(engine.session(created.session_id).snapshot.content, 'SH05_U1').fields.length, 3);
    assert.deepEqual(engine.session(f.id).snapshot.participant, snapshot.participant);
    await engine.settle();
  } finally { if (!oldClosed) await f.close(); reopened?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('新会话8个Unit的trials.csv按快照导出raw_answer、normalized_answer和score，没有旧字段', async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'a5-unit-trials-'));
  try {
    for (const unit of units) {
      f.send('jump', { target: unit.unit_id }); f.send('displayed');
      if (unit.reveal) { f.send('reveal', { open: true }); f.send('reveal_displayed'); }
      f.send('submit', { answer: answerFor(unit) });
    }
    await f.engine.settle();
    const files = unzipSync((await exportData(f.engine, [f.id], directory)).bytes);
    const source = strFromU8(files['trials.csv']).replace(/^\uFEFF/, '');
    const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (char === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
      else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
      else if (char === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += char;
    }
    const records = rows.slice(1).map(values => Object.fromEntries(rows[0].map((key, i) => [key, values[i]])));
    for (const unit of units) {
      const record = records.find(r => r.unit_id === unit.unit_id)!;
      assert.equal(record.content_version, 'sh-v2-2026-10-27-v13');
      assert.deepEqual(JSON.parse(record.raw_answer), answerFor(unit));
      assert.deepEqual(JSON.parse(record.normalized_answer), normalize(unit.fields, answerFor(unit)));
      assert.equal(record.score, '1');
      assert.deepEqual(Object.keys(JSON.parse(record.normalized_answer)).sort(), unit.fields.map(field => field.id).sort());
    }
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});
