import { stageIds } from './contracts.ts';
import type { Stimulus } from './contracts.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const conditions = new Set(['N-T0', 'N-T1', 'A-T0', 'A-T1', 'NONE']);

/** 接收未知 JSON；仅报错，绝不重新分配或修正源数据。 */
export function validateConfig(input: unknown, stimuli: Stimulus[]): string[] {
  const errors: string[] = [];
  if (!object(input) || input.experiment_id !== 'f5-sh-pilot' || input.schema_version !== '1.0' || !Array.isArray(input.participants)) {
    return ['配置必须包含 experiment_id=f5-sh-pilot、schema_version=1.0 和 participants 数组。'];
  }
  if (input.participants.length === 0) errors.push('被试列表不能为空。');
  const seen = new Set<string>();
  for (const participant of input.participants) {
    if (!object(participant) || typeof participant.participant_id !== 'string' || !participant.participant_id.trim() || !Array.isArray(participant.stages)) {
      errors.push('每名被试必须有非空字符串 participant_id 和 stages 数组。');
      continue;
    }
    const id = participant.participant_id;
    if (id === '000') errors.push('000为系统保留调试编号，由001派生，不能作为正式被试导入。');
    if (seen.has(id)) errors.push(`被试 ${id} 编号重复。`);
    seen.add(id);
    const stages = new Set<string>();
    for (const stage of participant.stages) {
      if (!object(stage) || typeof stage.stage_id !== 'string' || !stageIds.includes(stage.stage_id as typeof stageIds[number])) {
        errors.push(`被试 ${id} 包含非法任务。`);
        continue;
      }
      const prefix = `被试 ${id} / ${stage.stage_id}`;
      if (stages.has(stage.stage_id)) errors.push(`${prefix} 重复。`);
      stages.add(stage.stage_id);
      if (typeof stage.condition !== 'string' || !conditions.has(stage.condition)) {
        errors.push(`${prefix} 条件非法。`);
        continue;
      }
      if (stage.condition === 'NONE') {
        if (stage.message_id !== null) errors.push(`${prefix} 为 NONE，message_id 必须为 null。`);
        continue;
      }
      const expected = `${stage.condition[0]}${stage.stage_id.slice(2)}`;
      if (stage.message_id !== expected) errors.push(`${prefix} 使用 ${String(stage.message_id)}，与任务或消息类别不匹配（应匹配 ${expected}，未自动修改）。`);
      const stimulus = stimuli.find(s => s.stage_id === stage.stage_id && s.message_id === stage.message_id);
      if (!stimulus || !stimulus.text || !stimulus.question || stimulus.options.length !== 3 || !stimulus.options.some(o => o.id === stimulus.correct_option)) {
        errors.push(`${prefix} 找不到完整的刺激文案、理解题或正确选项。`);
      }
    }
    for (const stageId of stageIds) {
      if (!stages.has(stageId)) errors.push(`被试 ${id} 缺少 ${stageId}。`);
    }
  }
  return errors;
}
