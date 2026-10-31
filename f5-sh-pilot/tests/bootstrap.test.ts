import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '@a5/desktop/config.ts';
import { MockGlassesAdapter } from '@a5/glasses/adapters/mock-glasses.ts';
import { preflight, readJson } from '@a5/desktop/preflight.ts';
import type { GlassesRequest, ParticipantConfig, Stimulus } from '@a5/desktop/contracts.ts';

const { stimuli } = await readJson<{ stimuli: Stimulus[] }>('content/stimuli.json');
const pilot = await readJson<ParticipantConfig>('config/participants.pilot.json');
const source = await readJson<ParticipantConfig>('config/participants.source.json');

test('检出后的源材料通过字节完整性及启动检查（含 Windows 换行规则）', async () => {
  const result = await preflight();
  assert.deepEqual(result.material_errors, []);
  assert.equal(result.startup_ok, true);
});

test('默认直接使用P01—P28预分配（V1—V7各4人、7组），不重新分组', () => {
  assert.deepEqual(validateConfig(pilot, stimuli), []);
  assert.deepEqual(pilot.participants.map(p => p.participant_id), Array.from({ length: 28 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(pilot.participants.map(p => p.version_label), Array.from({ length: 28 }, (_, i) => `V${Math.floor(i / 4) + 1}`));
  assert.ok(pilot.participants.every(p => p.stages.length === 7));
  assert.deepEqual(pilot.participants[0].stages.map(s => [s.stage_id, s.condition, s.message_id]), [
    ['SH01', 'N-T0', 'N01'], ['SH02', 'N-T1', 'N02'], ['SH03', 'A-T0', 'A03'], ['SH04', 'A-T1', 'A04'],
    ['SH05', 'N-T2', 'N05'], ['SH06', 'A-T2', 'A06'], ['SH07', 'NONE', null],
  ]);
  // 拉丁方：每名被试7种条件各一次，每组在7个版本中也覆盖7种条件。
  for (const p of pilot.participants) assert.equal(new Set(p.stages.map(s => s.condition)).size, 7);
  for (let stage = 0; stage < 7; stage++) assert.equal(new Set(pilot.participants.map(p => p.stages[stage].condition)).size, 7);
});

test('历史5组源表不再作为V2配置；28人表构造错误编号仍报告且不静默修改', () => {
  // participants.source.json 只保留为V1历史来源（5组），按V2校验会报告缺少SH06/SH07，而不是被静默补齐。
  const sourceBefore = JSON.stringify(source);
  assert.ok(source.participants.every(p => p.stages.length === 5));
  assert.ok(validateConfig(source, stimuli).some(e => e.includes('缺少 SH06')));
  assert.equal(JSON.stringify(source), sourceBefore);
  const before = JSON.stringify(pilot);
  for (const id of ['P17', 'P18', 'P19', 'P20']) assert.equal(pilot.participants.find(p => p.participant_id === id)?.stages[1].message_id, 'A02');
  const invalid = structuredClone(pilot); invalid.participants.find(p => p.participant_id === 'P17')!.stages[1].message_id = 'N02';
  assert.ok(validateConfig(invalid, stimuli).some(e => e.includes('P17') && e.includes('SH02') && e.includes('N02')));
  assert.equal(invalid.participants.find(p => p.participant_id === 'P17')!.stages[1].message_id, 'N02');
  assert.equal(JSON.stringify(pilot), before);
});

test('重复被试、重复/缺失任务、NONE绑定消息均拒绝', () => {
  const config = structuredClone(pilot);
  config.participants.push(structuredClone(config.participants[0]));
  config.participants[0].stages[1] = structuredClone(config.participants[0].stages[0]);
  config.participants[0].stages.find(stage => stage.condition === 'NONE')!.message_id = 'N03';
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
