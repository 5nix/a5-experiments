import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedAnswers, loadMaterial, normalize, score, itemResults, minutes } from '@a5/desktop/tasks.ts';
import type { Unit } from '@a5/desktop/tasks.ts';
import { preflight } from '@a5/desktop/preflight.ts';
import { validateConfig } from '@a5/desktop/config.ts';
import { readJson } from '@a5/desktop/profile.ts';
import type { ParticipantConfig } from '@a5/desktop/contracts.ts';

const material = await loadMaterial();
const units = material.content.stages.flatMap(s => s.units);
const num = (text: string) => Number(text);
const clock = (text: string) => minutes(text);
const duration = (text: string) => { const m = /^(?:(\d+)小时)?(?:(\d+)分钟)?$/.exec(text)!; return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0); };

/** 不读 tasks.json 里的参考答案，直接按表格与题干公式重新计算，用于核对参考答案。 */
const solvers: Record<string, (row: string[]) => number | string> = {
  SL01: r => clock(r[2]) - clock(r[1]),
  SL02: r => num(r[1]) * num(r[2]),
  SL03: r => num(r[1]) + num(r[2]),
  SL04: r => num(r[1]) - num(r[2]),
  SL05: r => (clock(r[1]) + num(r[2]) === clock(r[3]) ? '正确' : '错误'),
  SL06: r => num(r[1]) / num(r[2]),
  SL07: r => duration(r[1]),
};

test('7组14单元，每单元8个必答作答项，表格不设题号列，作答项与表格行一一对应', () => {
  assert.equal(material.content.stages.length, 7);
  assert.deepEqual(material.content.stages.map(s => s.stage_id), ['SL01', 'SL02', 'SL03', 'SL04', 'SL05', 'SL06', 'SL07']);
  for (const unit of units) {
    const table = unit.tables![0];
    assert.equal(unit.tables!.length, 1, unit.unit_id);
    assert.ok(!table.columns.includes('题号'), unit.unit_id);
    assert.equal(table.rows.length, 8, unit.unit_id);
    assert.equal(unit.fields.length, 8, unit.unit_id);
    assert.ok(unit.fields.every(f => f.required));
    assert.equal(unit.reveal, undefined, `${unit.unit_id}没有补充资料附件`);
    assert.equal(unit.assets.length, 0);
    unit.fields.forEach((f, i) => assert.ok(f.label.startsWith(table.rows[i][0]), `${unit.unit_id}第${i + 1}项标签应以事项名称开头`));
  }
});

test('参考答案与按公式重新计算的结果逐项一致（含执行单更正的SL04整理接待台=21、SL07整理充电设备=80）', () => {
  for (const unit of units) {
    const solve = solvers[unit.unit_id.slice(0, 4)];
    assert.equal(unit.scoring.type, 'items');
    const expected = expectedAnswers(unit);
    unit.tables![0].rows.forEach((row, i) => assert.equal(expected[unit.fields[i].id], solve(row), `${unit.unit_id}第${i + 1}项（${row[0]}）`));
  }
  const find = (unitId: string, name: string) => { const u = units.find(x => x.unit_id === unitId)!; return expectedAnswers(u)[u.fields.find(f => f.label.startsWith(name))!.id]; };
  assert.equal(find('SL04_U1', '整理接待台'), 21);
  assert.equal(find('SL07_U2', '整理充电设备'), 80);
  assert.equal(find('SL03_U1', '签字笔'), 28);
});

test('标签：SL03已含单位；其余计算题为“事项（单位）”；SL05为单选正确/错误', () => {
  const label = (unitId: string, i: number) => units.find(u => u.unit_id === unitId)!.fields[i].label;
  assert.equal(label('SL01_U1', 0), '检查场地（分钟）');
  assert.equal(label('SL02_U1', 0), '体验流程说明（页）');
  assert.equal(label('SL03_U1', 0), '工作人员胸牌（个）');
  assert.equal(label('SL06_U1', 0), '体验流程说明（袋）');
  assert.equal(label('SL07_U2', 0), '安装体验设备（分钟）');
  for (const id of ['SL05_U1', 'SL05_U2']) {
    const unit = units.find(u => u.unit_id === id)!;
    assert.ok(unit.fields.every(f => f.type === 'single' && f.options!.map(o => o.value).join() === '正确,错误'));
    assert.equal(unit.fields[0].label, unit.tables![0].rows[0][0]);
  }
});

test('逐项判分：全对得8分，错一项只扣一项并记录每项对错；空值与非整数被拒绝', () => {
  for (const unit of units) {
    const right = normalize(unit.fields, expectedAnswers(unit));
    assert.equal(score(unit, right), 8, unit.unit_id);
    assert.ok(Object.values(itemResults(unit, right)!).every(Boolean));
  }
  const unit = units.find(u => u.unit_id === 'SL01_U1')!;
  const wrong = { ...expectedAnswers(unit), i3: 21 };
  const answer = normalize(unit.fields, wrong);
  assert.equal(score(unit, answer), 7);
  assert.deepEqual(Object.entries(itemResults(unit, answer)!).filter(([, ok]) => !ok).map(([k]) => k), ['i3']);
  assert.throws(() => normalize(unit.fields, { ...expectedAnswers(unit), i1: '' }), /请完整填写/);
  assert.throws(() => normalize(unit.fields, { ...expectedAnswers(unit), i1: '1.5' }), /非负整数/);
  assert.throws(() => normalize(unit.fields, { ...expectedAnswers(unit), i1: '-3' }), /非负整数/);
  const check = units.find(u => u.unit_id === 'SL05_U1')!;
  assert.throws(() => normalize(check.fields, { ...expectedAnswers(check), i1: '也许' }), /选项无效/);
});

test('14条消息：N/A各7条，C项为“不记得或不确定”，正确选项与执行单一致', () => {
  const stimuli = material.stimuli;
  assert.equal(stimuli.length, 14);
  const key = Object.fromEntries(stimuli.map(s => [s.message_id, s.correct_option]));
  assert.deepEqual(key, { N01: 'A', A01: 'A', N02: 'B', A02: 'B', N03: 'A', A03: 'A', N04: 'B', A04: 'B', N05: 'A', A05: 'A', N06: 'B', A06: 'B', N07: 'A', A07: 'B' });
  for (const s of stimuli) {
    assert.equal(s.stage_id, `SL${s.message_id.slice(1)}`);
    assert.equal(s.options.find(o => o.id === 'C')!.text, '不记得或不确定');
    assert.equal(s.duration_ms, 11000);
  }
  assert.equal(stimuli.find(s => s.message_id === 'N02')!.text, '领取胸牌的地点改到一楼前台，时间不变。');
  assert.equal(stimuli.find(s => s.message_id === 'A07')!.options[1].text, '规划路线');
});

test('流程参数：T0为填满3个作答项后2秒；U2休息30秒、窗口下限10秒、T2在休息页可见后5秒；练习休息窗口5秒、休息5秒', () => {
  const c = material.content;
  assert.deepEqual(c.t0_trigger, { type: 'answers_filled', min_answers: 3, delay_ms: 2000 });
  assert.equal(c.in_unit_rest!.duration_ms, 30000);
  assert.equal(c.in_unit_rest!.window_min_ms, 10000);
  assert.deepEqual(c.in_unit_rest!.window_min_ms_by_stage, {});
  assert.equal(c.in_unit_rest!.t2_delay_ms, 5000);
  assert.equal(c.in_unit_rest!.practice_window_min_ms, 5000);
  assert.equal(c.in_unit_rest!.practice_duration_ms, 5000);
  assert.equal(c.tutorial_notice_after_practice, true);
  assert.equal(c.break_ms, undefined);
});

test('情景导入、说明卡、情景时间与结束语', () => {
  const c = material.content;
  assert.equal(c.intro.paragraphs[0], '你是新品体验活动的筹备人员。活动在2026年11月20日（周五）14:00—17:00举行，地点是创新中心一层体验厅。');
  assert.equal(c.completion_text, '7个任务已经全部完成。请等待实验员进行访谈。');
  assert.deepEqual(c.stages.map(s => `${s.scene_time!.date} ${s.scene_time!.time}`), ['11月18日 周三 10:00', '11月18日 周三 15:00', '11月19日 周四 10:00', '11月19日 周四 14:00', '11月19日 周四 15:30', '11月20日 周五 10:30', '11月20日 周五 12:00']);
  assert.equal(c.stages[0].title, 'SL01任务：计算工作用时');
  for (const stage of c.stages) assert.ok(!/\d{1,2}:\d{2}/.test(stage.card) || stage.stage_id !== 'SL01', '情景时间不写进说明卡正文');
  assert.equal(c.stages[1].card, '你正在计算活动资料要印多少页。另外，今天16:00要到二楼前台领取工作人员胸牌。明天去活动现场彩排时，需要带上电脑。');
});

test('练习单元：东侧、西侧书架，答案正确，没有附件', () => {
  const [u1, u2] = material.content.practice!.units;
  assert.equal(u1.title, '练习单元1：东侧书架'); assert.equal(u2.title, '练习单元2：西侧书架');
  assert.deepEqual(expectedAnswers(u1), { A: 6, B: 12, C: 8, D: 10 });
  assert.deepEqual(expectedAnswers(u2), { F: 6, G: 8, H: 15, I: 12 });
  for (const u of [u1, u2] as Unit[]) { assert.equal(u.reveal, undefined); u.tables![0].rows.forEach((r, i) => assert.equal(expectedAnswers(u)[u.fields[i].id], num(r[1]) * num(r[2]))); }
  assert.equal(u2.paragraphs[2], '2. 点击右上角“休息”按钮休息一次。练习中的休息只有5秒。');
});

test('预分配沿用SH的P01—P28：SL0x对应SH0x的条件与消息编号，校验通过', async () => {
  const pilot = await readJson<ParticipantConfig>('config/participants.pilot.json');
  assert.equal(pilot.experiment_id, 'f5-sl-pilot');
  assert.deepEqual(validateConfig(pilot, material.stimuli), []);
  assert.equal(pilot.participants.length, 28);
  assert.deepEqual(pilot.participants.map(p => p.participant_id), Array.from({ length: 28 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`));
  const sh = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../f5-sh-pilot/config/participants.pilot.json', import.meta.url), 'utf8')) as ParticipantConfig;
  const normalize = (c: ParticipantConfig) => JSON.stringify(c.participants.map(p => ({ id: p.participant_id, v: p.version_label, s: p.stages.map(s => [s.stage_id.slice(2), s.condition, s.message_id, s.display_mode]) })));
  assert.equal(normalize(pilot), normalize(sh));
  const bad = structuredClone(pilot); bad.participants[0].stages[0].stage_id = 'SH01';
  assert.ok(validateConfig(bad, material.stimuli).length > 0, 'SH编号不能进入SL配置');
});

test('启动自检通过，实验标识为f5-sl-pilot', async () => {
  const checked = await preflight();
  assert.equal(checked.experiment_id, 'f5-sl-pilot');
  assert.deepEqual(checked.pilot_errors, []);
  assert.deepEqual(checked.material_errors, []);
  assert.equal(checked.startup_ok, true);
});
