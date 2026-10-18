import { createHash } from 'node:crypto';
import { readFile, mkdir, access, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ParticipantConfig, Stimulus } from './contracts.ts';
import { validateConfig } from './config.ts';
import type { TaskContent } from './tasks.ts';

export const experimentRoot = resolve(import.meta.dirname, '..');
export const readJson = async <T>(relative: string): Promise<T> => JSON.parse(await readFile(join(experimentRoot, relative), 'utf8'));

export async function preflight() {
  const [pilot, source, material, manifest, tasks] = await Promise.all([
    readJson<ParticipantConfig>('config/participants.pilot.json'),
    readJson<ParticipantConfig>('config/participants.source.json'),
    readJson<{ content_version: string; stimuli: Stimulus[] }>('content/stimuli.json'),
    readJson<{ files: { path: string; sha256: string }[]; image_count: number; native_table_count: number; embedded_workbook_count?: number; sheet_names: string[] }>('content/source/manifest.json'),
    readJson<TaskContent>('content/tasks.json'),
  ]);
  const pilotErrors = validateConfig(pilot, material.stimuli);
  const sourceErrors = validateConfig(source, material.stimuli);
  const materialErrors: string[] = [];
  if (tasks.stages.length !== 5 || tasks.stages.some(s => s.units.length !== 2)) materialErrors.push('任务配置必须为5组10单元。');
  if (tasks.break_ms !== 180000 || tasks.message_duration_ms !== 8500) materialErrors.push('任务休息或消息目标时长与当前协议不一致。');
  for (const stage of tasks.stages) for (const unit of stage.units) {
    if (!unit.fields.length || unit.fields.some(f => !f.required)) materialErrors.push(`${unit.unit_id}必须配置完整必答字段。`);
    for (const table of [...(unit.tables ?? []), ...(unit.reveal?.tables ?? [])]) {
      if (!table.caption || !table.columns.length || !table.rows.length || table.rows.some(row => row.length !== table.columns.length)) materialErrors.push(`${unit.unit_id}文本表格结构无效。`);
    }
    for (const asset of [...unit.assets, ...(unit.reveal?.assets ?? [])]) {
      if (!/^image\d+\.png$/.test(asset.id)) materialErrors.push(`${unit.unit_id}原图标识非法。`);
      else await access(join(experimentRoot, 'content/source/assets', asset.id), constants.R_OK);
    }
  }
  for (const file of manifest.files) {
    const hash = createHash('sha256').update(await readFile(join(experimentRoot, file.path))).digest('hex');
    if (hash !== file.sha256) materialErrors.push(`${file.path} 已变更，请重新提取并核对材料。`);
  }
  for (const directory of ['runtime', 'exports']) {
    const path = join(experimentRoot, directory);
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
    const probe = join(path, `.write-probe-${process.pid}-${crypto.randomUUID()}`);
    try { await writeFile(probe, '', { flag: 'wx' }); } finally { await unlink(probe).catch(() => {}); }
  }
  return {
    repository: 'a5-experiments',
    experiment_id: 'f5-sh-pilot',
    phase: 'core',
    startup_ok: pilotErrors.length === 0 && materialErrors.length === 0,
    software_flow_ready: pilotErrors.length === 0 && materialErrors.length === 0,
    pilot_ready: false,
    content_version: tasks.content_version,
    stimulus_version: material.content_version,
    materials: { source_files: manifest.files.length, native_tables: manifest.native_table_count, embedded_images: manifest.image_count, embedded_workbooks: manifest.embedded_workbook_count ?? 0,
      text_tables: tasks.stages.reduce((sum, s) => sum + s.units.reduce((n, u) => n + (u.tables?.length ?? 0) + (u.reveal?.tables?.length ?? 0), 0), 0), sheets: manifest.sheet_names, sh_stimuli: material.stimuli.length },
    pilot_participants: pilot.participants.map(p => p.participant_id),
    pilot_errors: pilotErrors,
    source_config_errors: sourceErrors,
    material_errors: materialErrors,
    remaining: ['雷鸟显示端真机部署与实际硬件呈现验证', '材料最终确认版本替换', 'Windows现场实机验证', '由后续Agent完成可视化设计'],
  };
}
