import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../src/config.ts';
import { MockGlassesAdapter } from '../src/adapters/mock-glasses.ts';
import { preflight, readJson } from '../src/preflight.ts';
import type { GlassesRequest, ParticipantConfig, Stimulus } from '../src/contracts.ts';

const { stimuli } = await readJson<{ stimuli: Stimulus[] }>('content/stimuli.json');
const pilot = await readJson<ParticipantConfig>('config/participants.pilot.json');
const source = await readJson<ParticipantConfig>('config/participants.source.json');
const latinSquare = await readJson<ParticipantConfig>('config/participants.latin-square.P01-P20.json');

test('检出后的源材料通过字节完整性及启动检查（含 Windows 换行规则）', async () => {
  const result = await preflight();
  assert.deepEqual(result.material_errors, []);
  assert.equal(result.startup_ok, true);
});

test('执行原表001—004条件，不重新分组', () => {
  assert.deepEqual(validateConfig(pilot, stimuli), []);
  assert.deepEqual(pilot.participants.map(p => p.participant_id), ['001', '002', '003', '004']);
  assert.deepEqual(pilot.participants[0].stages.map(s => [s.condition, s.message_id]), [
    ['N-T0', 'N01'], ['N-T1', 'N02'], ['A-T0', 'A03'], ['A-T1', 'A04'], ['NONE', null],
  ]);
});

test('标准20人拉丁方模板可导入且各任务组条件均衡', () => {
  assert.deepEqual(validateConfig(latinSquare, stimuli), []);
  assert.deepEqual(latinSquare.participants.map(p => p.participant_id), Array.from({ length: 20 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`));
  const stages = ['SH01', 'SH02', 'SH03', 'SH04', 'SH05'];
  const conditions = ['N-T0', 'N-T1', 'A-T0', 'A-T1', 'NONE'];
  for (const participant of latinSquare.participants) {
    assert.equal(new Set(participant.stages.map(stage => stage.condition)).size, conditions.length);
  }
  for (const stageId of stages) for (const condition of conditions) {
    assert.equal(latinSquare.participants.filter(p => p.stages.some(stage => stage.stage_id === stageId && stage.condition === condition)).length, 4, `${stageId} / ${condition}`);
  }
  for (let version = 1; version <= 10; version++) {
    const label = `V${String(version).padStart(2, '0')}`;
    assert.equal(latinSquare.participants.filter(p => p.version_label === label).length, 2, label);
  }
});

test('新版源表V5修订有效；构造错误编号仍报告且不静默修改', () => {
  const before = JSON.stringify(source);
  assert.deepEqual(validateConfig(source, stimuli), []);
  for (const id of ['017', '018', '019', '020']) assert.equal(source.participants.find(p => p.participant_id === id)?.stages[1].message_id, 'N02');
  const invalid = structuredClone(source); invalid.participants.find(p => p.participant_id === '017')!.stages[1].message_id = 'N01';
  assert.ok(validateConfig(invalid, stimuli).some(e => e.includes('017') && e.includes('SH02') && e.includes('N01')));
  assert.equal(invalid.participants.find(p => p.participant_id === '017')!.stages[1].message_id, 'N01');
  assert.equal(JSON.stringify(source), before);
});

test('重复被试、重复/缺失任务、NONE绑定消息均拒绝', () => {
  const config = structuredClone(pilot);
  config.participants.push(structuredClone(config.participants[0]));
  config.participants[0].stages[1] = structuredClone(config.participants[0].stages[0]);
  config.participants[0].stages[4].message_id = 'N05';
  const errors = validateConfig(config, stimuli).join('\n');
  for (const keyword of ['编号重复', 'SH01 重复', '缺少 SH02', '必须为 null']) assert.ok(errors.includes(keyword));
});

test('畸形JSON、空被试和缺失理解题均报告错误', () => {
  for (const invalid of [null, {}, { ...pilot, participants: [] }, { ...pilot, participants: [null] }]) assert.ok(validateConfig(invalid, stimuli).length);
  assert.ok(validateConfig(pilot, []).length);
});

const request: GlassesRequest = { request_id: 'mock-1', session_id: 'debug-only', participant_id: '001', stage_id: 'SH01', message_id: 'N01', text: '测试内容', duration_ms: 8500 };

test('Mock异步返回且进程内重复请求幂等，不伪造实际显示时间', async () => {
  const adapter = new MockGlassesAdapter({ delay_ms: 5 });
  const first = adapter.send(request);
  assert.equal(adapter.send(request), first);
  const receipt = await first;
  assert.equal(receipt.source, 'mock');
  assert.equal(receipt.status, 'accepted');
  assert.ok(receipt.t_ack);
  assert.equal(receipt.t_display, null);
  assert.equal(receipt.t_hide, null);
  await assert.rejects(adapter.send({ ...request, text: '另一个内容' }));
});

test('Mock断连和未回执保留原因，不自动重发或伪造回执', async () => {
  for (const [options, status, error] of [
    [{ connected: false }, 'failed', 'mock_disconnected'],
    [{ acknowledge: false }, 'unacknowledged', 'mock_no_ack'],
  ] as const) {
    const receipt = await new MockGlassesAdapter(options).send(request);
    assert.equal(receipt.status, status);
    assert.equal(receipt.error, error);
    assert.equal(receipt.t_ack, null);
    assert.equal(receipt.t_display, null);
  }
});
