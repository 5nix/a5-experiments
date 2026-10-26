import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { experimentRoot, readJson } from './preflight.ts';
import type { Participant, Stimulus, StageId } from './contracts.ts';

export interface Field {
  id: string; label: string; type: 'integer' | 'money' | 'time' | 'multi' | 'single' | 'integer_or_na'; required: boolean;
  options?: { value: string; label: string }[]; exclusive_value?: string;
}
export interface Asset { id: string; label: string; source_ref: string }
export interface DataTable {
  id: string; caption: string; columns: string[]; rows: string[][];
  source_ref?: { file: string; embedded_file: string; sheet: string; range: string; sha256: string };
}
export interface Unit {
  unit_id: string; title: string; paragraphs: string[]; assets: Asset[]; fields: Field[];
  tables?: DataTable[];
  scratchpad?: { label: string; placeholder: string; max_length: number };
  reveal?: { button_label: string; paragraphs: string[]; assets?: Asset[]; tables?: DataTable[] };
  scoring: { type: 'exact'; expected: Record<string, unknown> } | { type: 'staffing'; positions: Record<string, { qualification: string; start: string }>; personnel: { name: string; qualifications: string[]; arrival: string; absent: boolean }[] };
}
export interface TaskContent {
  schema_version: string; content_version: string;
  intro: { title: string; paragraphs: string[] };
  stages: { stage_id: StageId; title: string; card: string; scene_time?: { date: string; time: string }; units: Unit[] }[];
  survey_revision_id?: string;
  survey_pages?: {
    comprehension: { title: string; paragraphs: string[]; notice_field: Field; uncertain_option_text: string };
    ratings: { title: string; paragraphs: string[]; skip_if_not_noticed?: boolean };
  };
  ratings: { id: string; label: string; min: number; max: number; min_label?: string; max_label?: string }[];
  interview_prompts: string[]; message_duration_ms: number; completion_text: string;
  /** 旧快照的组间休息；V2起取消，由 in_unit_rest 替代。 */
  break_ms?: number; break_start_on_display?: boolean; allow_break_skip?: boolean;
  in_unit_rest?: InUnitRest;
}
/** V2：每组第二单元内由被试自主发起一次休息；T2在休息页实际可见后延迟送达。 */
export interface InUnitRest {
  duration_ms: number; window_min_ms: number; window_min_ms_by_stage?: Record<string, number>; t2_delay_ms: number;
  button_label: string; early_click_text: string; already_rested_text: string;
  rest_title: string; rest_paragraphs: string[]; show_countdown: boolean;
  reminder_text: string; reminder_display_ms: number; tutorial_duration_ms: number; instruction: string;
}
export interface Snapshot {
  display_mode?: import('./contracts.ts').DisplayMode;
  content: TaskContent; stimuli: Stimulus[]; stimulus_version: string; participant: Participant;
  assets: Record<string, { base64: string; sha256: string }>; config_hash: string; content_hash: string;
}
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function loadMaterial() {
  const content = await readJson<TaskContent>('content/tasks.json');
  const material = await readJson<{ content_version: string; stimuli: Stimulus[] }>('content/stimuli.json');
  if (content.stages.length !== 7 || content.stages.some(s => s.units.length !== 2)) throw new Error('任务配置必须包含七组、每组两个单元。');
  const assets: Snapshot['assets'] = {};
  for (const stage of content.stages) for (const unit of stage.units) {
    for (const asset of [...(unit.assets ?? []), ...(unit.reveal?.assets ?? [])]) {
      if (!/^image\d+\.png$/.test(asset.id)) throw new Error('表格原图标识非法。');
      const bytes = await readFile(join(experimentRoot, 'content/source/assets', asset.id));
      assets[asset.id] = { base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  }
  // 原始刺激重新提取后也应用当前问卷措辞，随新会话快照固定；不改动历史快照。
  const uncertain = content.survey_pages?.comprehension.uncertain_option_text;
  const stimuli = material.stimuli.map(s => ({ ...s, options: s.options.map(o => o.id === 'C' && uncertain ? { ...o, text: uncertain } : o) }));
  return { content, stimuli, stimulus_version: material.content_version, assets };
}

export class InputError extends Error {
  status = 422;
}
export const minutes = (text: string) => {
  const canonical = text.normalize('NFKC').trim().replace(/[：﹕︓∶꞉ː]/gu, ':');
  const match = /^(\d{1,2})\s*:\s*(\d{2})$/.exec(canonical);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new InputError('时间请填写为时:分，例如6:23、6：00或06:09。');
  return Number(match[1]) * 60 + Number(match[2]);
};

export function normalize(fields: Field[], raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) if (!fields.some(f => f.id === key)) throw new InputError('答案包含不属于本题的字段。');
  for (const f of fields) {
    const value = raw[f.id];
    if (f.type === 'multi') {
      if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== 'string') || new Set(value).size !== value.length) throw new InputError(`请完整填写：${f.label}。`);
      if (value.some(v => !f.options?.some(o => o.value === v)) || (value.includes(f.exclusive_value) && value.length !== 1)) throw new InputError(`${f.label}的选项无效或相互冲突。`);
      normalized[f.id] = [...value].sort();
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw new InputError(`请完整填写：${f.label}。`);
    const text = String(value).trim();
    if (!text) throw new InputError(`请完整填写：${f.label}。`);
    if (f.type === 'single') {
      if (!f.options?.some(o => o.value === text)) throw new InputError(`${f.label}的选项无效。`);
      normalized[f.id] = text;
    } else if (f.type === 'time') normalized[f.id] = minutes(text);
    else if (f.type === 'money') {
      if (!/^\d+(\.\d{1,2})?$/.test(text) || text.length > 12) throw new InputError(`${f.label}请填写非负金额，最多两位小数。`);
      const [whole, fraction = ''] = text.split('.');
      normalized[f.id] = `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
    } else if (f.type === 'integer_or_na' && raw.plan === 'NONE') {
      if (text !== '不适用') throw new InputError('选择没有合格方案时，剩余量请填写“不适用”。');
      normalized[f.id] = text;
    } else {
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new InputError(`${f.label}请填写非负整数。`);
      normalized[f.id] = Number(text);
    }
  }
  return normalized;
}

export function score(unit: Unit, answer: Record<string, unknown>): number {
  if (unit.scoring.type === 'exact') {
    const expected = normalize(unit.fields, unit.scoring.expected);
    return unit.fields.every(f => JSON.stringify(answer[f.id]) === JSON.stringify(expected[f.id])) ? 1 : 0;
  }
  const assigned = Object.values(answer);
  if (new Set(assigned).size !== assigned.length) return 0;
  for (const [field, position] of Object.entries(unit.scoring.positions)) {
    const person = unit.scoring.personnel.find(p => p.name === answer[field]);
    if (!person || person.absent || !person.qualifications.includes(position.qualification) || minutes(person.arrival) > minutes(position.start)) return 0;
  }
  return 1;
}
