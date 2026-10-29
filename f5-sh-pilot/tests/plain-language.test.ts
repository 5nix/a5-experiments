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
  assert.equal(material.content.content_version, 'sh-v2-2026-10-29-v14');
  assert.equal(material.content.plain_language_revision_id, 'user-approved-plain-language-2026-10-29');
  assert.deepEqual(maskContent(material.content), maskContent(baseline.content));
  const units = material.content.stages.flatMap(s => s.units), old = baseline.content.stages.flatMap(s => s.units);
  assert.equal(units.length, 14);
  for (const [i, unit] of units.entries()) {
    assert.deepEqual(unit.fields.map(f => [f.id, f.type, f.options]), old[i].fields.map(f => [f.id, f.type, f.options]), unit.unit_id);
    assert.deepEqual(unit.scoring, old[i].scoring, unit.unit_id);
  }
});

test('v14眼镜消息：只改7条消息的文字，correct_option、选项编号和“不记得或不确定”不变，source_answer与正确选项一致', () => {
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
  const text = (id: string) => stimuli.stimuli.find(s => s.message_id === id)!;
  assert.equal(text('A04').options.find(o => o.id === 'A')!.text, '周五');
  assert.equal(text('N01').options.find(o => o.id === 'A')!.text, '14:00');
  assert.equal(text('N01').text, '线上方案评审会，调整为13:30开始。');
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
