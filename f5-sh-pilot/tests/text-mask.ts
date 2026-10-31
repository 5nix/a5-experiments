import { readJson } from '@a5/desktop/preflight.ts';
import type { TaskContent, Unit } from '@a5/desktop/tasks.ts';
import type { Stimulus } from '@a5/desktop/contracts.ts';

/** stimuli.json 里的来源记录 source_answer 不属于运行时类型。 */
export type StimulusRow = Stimulus & { source_answer: string };

interface UnitPatch {
  title?: string; paragraphs?: string[]; reveal_paragraphs?: string[]; field_labels?: Record<string, string>;
  tables?: Record<string, { caption?: string; columns?: string[]; cells?: [number, number, string, string][] }>;
}
const plain = (await readJson<{ plain_language_revision: {
  units: Record<string, UnitPatch>;
  stimuli: Record<string, { text?: string; question?: string; options?: Record<string, string> }>;
  survey_comprehension: { notice_options: Record<string, string> };
} }>('content/revisions.json')).plain_language_revision;

/** 抹掉修订清单明确允许改动的纯文字位置；其余字段（答案、字段ID、选项取值、评分、表格数值）必须与基线逐项相同。 */
export function maskUnit(unit: Unit): Unit {
  const value = structuredClone(unit), patch = plain.units[unit.unit_id] ?? {};
  if (patch.title !== undefined) value.title = '';
  if (patch.paragraphs) value.paragraphs = [];
  if (patch.reveal_paragraphs) value.reveal!.paragraphs = [];
  for (const id of Object.keys(patch.field_labels ?? {})) value.fields.find(f => f.id === id)!.label = '';
  const tables = [...(value.tables ?? []), ...(value.reveal?.tables ?? [])];
  for (const [id, change] of Object.entries(patch.tables ?? {})) {
    const table = tables.find(t => t.id === id)!;
    if (change.caption !== undefined) table.caption = '';
    if (change.columns) table.columns = table.columns.map(() => '');
    for (const [row, column] of change.cells ?? []) table.rows[row][column] = '';
  }
  return value;
}

export function maskContent(content: TaskContent): TaskContent {
  const value = structuredClone(content);
  value.content_version = ''; delete value.plain_language_revision_id;
  // 练习单元（v15）是新增内容，不在v13基线内；其休息参数同理。
  delete value.practice; delete value.practice_revision_id;
  if (value.in_unit_rest) { delete value.in_unit_rest.practice_window_min_ms; delete value.in_unit_rest.practice_duration_ms; }
  value.intro.paragraphs = []; value.completion_text = '';
  for (const stage of value.stages) { stage.card = ''; stage.units = stage.units.map(maskUnit); }
  const comprehension = value.survey_pages!.comprehension;
  comprehension.paragraphs = []; comprehension.notice_field.label = '';
  for (const value of Object.keys(plain.survey_comprehension.notice_options)) comprehension.notice_field.options!.find(o => o.value === value)!.label = '';
  return value;
}

export function maskStimuli(file: { content_version: string; stimuli: StimulusRow[] }) {
  const value = structuredClone(file);
  value.content_version = '';
  for (const stimulus of value.stimuli) {
    const patch = plain.stimuli[stimulus.message_id];
    if (!patch) continue;
    if (patch.text !== undefined) stimulus.text = '';
    if (patch.question !== undefined) stimulus.question = '';
    for (const id of Object.keys(patch.options ?? {})) stimulus.options.find(o => o.id === id)!.text = '';
    if (patch.options?.[stimulus.correct_option]) stimulus.source_answer = '';
  }
  return value;
}
