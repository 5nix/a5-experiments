import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMaterial } from '../src/tasks.ts';
import type { TaskContent } from '../src/tasks.ts';
import { readJson } from '../src/preflight.ts';
import { maskContent, maskStimuli } from './text-mask.ts';
import type { StimulusRow } from './text-mask.ts';

const material = await loadMaterial();
const baseline = await readJson<{ content: TaskContent; stimuli: { content_version: string; stimuli: StimulusRow[] } }>('tests/fixtures/plain-language-v13.json');
const stimuli = await readJson<{ content_version: string; stimuli: StimulusRow[] }>('content/stimuli.json');

test('v14大白话修订：除修订清单列出的文字位置外，tasks.json与v13逐项相同', () => {
  assert.equal(baseline.content.content_version, 'sh-v2-2026-10-27-v13');
  assert.equal(material.content.content_version, 'sh-v2-2026-10-30-v15');
  assert.equal(material.content.plain_language_revision_id, 'user-approved-plain-language-2026-10-29');
  assert.deepEqual(maskContent(material.content), maskContent(baseline.content));
  const units = material.content.stages.flatMap(s => s.units), old = baseline.content.stages.flatMap(s => s.units);
  assert.equal(units.length, 14);
  for (const [i, unit] of units.entries()) {
    assert.deepEqual(unit.fields.map(f => [f.id, f.type, f.options]), old[i].fields.map(f => [f.id, f.type, f.options]), unit.unit_id);
    assert.deepEqual(unit.scoring, old[i].scoring, unit.unit_id);
  }
});

test('v14眼镜消息：14条消息终稿，只改文字，correct_option、选项编号和“不记得或不确定”不变，source_answer与正确选项一致', () => {
  assert.equal(baseline.stimuli.content_version, 'sh-v2-presentation-2026-10-26-v5');
  assert.equal(stimuli.content_version, 'sh-v2-presentation-2026-10-29-v6');
  assert.equal(material.stimulus_version, stimuli.content_version);
  assert.deepEqual(maskStimuli(stimuli), maskStimuli(baseline.stimuli));
  assert.deepEqual(stimuli.stimuli.map(s => s.correct_option), baseline.stimuli.stimuli.map(s => s.correct_option));
  for (const s of stimuli.stimuli) {
    assert.deepEqual(s.options.map(o => o.id), ['A', 'B', 'C'], s.message_id);
    assert.equal(s.options[2].text, '不记得或不确定', s.message_id);
    assert.equal(s.source_answer, `${s.correct_option} ${s.options.find(o => o.id === s.correct_option)!.text}`, s.message_id);
  }
  // 执行单第四节的14条消息终稿：编号、正文、理解题、A项、B项、正确选项。
  const final: [string, string, string, string, string, string][] = [
    ['N01', '线上方案评审会，调整为13:30开始。', '线上方案评审调整到几点开始？', '13:00', '13:30', 'B'],
    ['A01', '四个方案的筛选结果，可以帮你做成对比表。', '眼镜提出可以帮你做什么？', '做成方案对比表', '写好评审发言稿', 'A'],
    ['N02', '请前往二楼服务台领取工作清单的配套材料。', '在哪里领取清单的配套材料？', '二楼服务台', '一楼服务台', 'A'],
    ['A02', '清单可以帮你发到三楼的自助打印机。', '眼镜提出可以帮你做什么？', '改成电子版提交', '发到自助打印机', 'B'],
    ['N03', '项目沟通会，调整到B201会议室举行。', '项目沟通会调整到哪个会议室？', 'B201会议室', 'A302会议室', 'A'],
    ['A03', '会议资料可以帮你设置会前定时发送。', '眼镜提出可以帮你做什么？', '到时提醒发送', '设定定时发送', 'B'],
    ['N04', '今天的展板确认时间推迟到16:30。', '展板确认的时间推迟到几点？', '17:20', '16:30', 'B'],
    ['A04', '物料报销的发票，可以帮你汇总成报销单。', '眼镜提出可以帮你做什么？', '汇总成报销单', '发给财务审核', 'A'],
    ['N05', '工作人员入口调整到创新中心东门。', '工作人员入口调整为创新中心哪个门？', '南门', '东门', 'B'],
    ['A05', '明天的接驳车，可以帮你提前预约好座位。', '眼镜提出可以帮你做什么？', '预约接驳车座位', '设置出发前提醒', 'A'],
    ['N06', '明日的体验流程介绍要提前到10:30开始。', '明日的体验流程介绍调整到几点开始？', '10:30', '10:00', 'A'],
    ['A06', '明天要介绍体验流程，可以帮你整理讲解提纲。', '眼镜提出可以帮你做什么？', '做演示幻灯片', '整理讲解提纲', 'B'],
    ['N07', '明日活动的签到地点要改到一楼的大厅服务台。', '明日活动的签到地点调整到哪里？', '体验厅侧门', '一楼大厅服务台', 'B'],
    ['A07', '各组的到场通知，可以帮你按分组发出去。', '眼镜提出可以帮你做什么？', '按分组发通知', '起草通知内容', 'A'],
  ];
  assert.deepEqual(stimuli.stimuli.map(s => [s.message_id, s.text, s.question, s.options[0].text, s.options[1].text, s.correct_option]), final);
});

test('v14被试页文案：理解题第1题与说明按执行单三段，眼镜文案统一为“消息”', () => {
  const comprehension = material.content.survey_pages!.comprehension;
  assert.deepEqual(comprehension.paragraphs, ['请根据刚才这组任务中的实际情况作答。', '第1题问你是否注意到眼镜上的消息，第2题问消息的内容。', '不记得或不确定消息内容时，选“不记得或不确定”。']);
  assert.equal(comprehension.notice_field.label, '第1题：刚才这组任务中（包括休息时），你注意到眼镜上的消息了吗？');
  assert.deepEqual(comprehension.notice_field.options!.map(o => o.value), ['not_noticed', 'partially_read', 'fully_read']);
  assert.deepEqual(comprehension.notice_field.options!.map(o => o.label), ['没有注意到任何消息', '注意到了消息，但没有完整读到消息内容', '完整读到了消息内容']);
  assert.equal(material.content.completion_text, '7个任务已经全部完成。请等待实验员进行访谈。');
  assert.equal(material.content.intro.paragraphs.length, 2);
});
