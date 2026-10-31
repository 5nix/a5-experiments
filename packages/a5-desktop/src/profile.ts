import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * 实验分项目录（f5-sh-pilot、f5-sl-pilot…）：由各分项入口设置 A5_EXPERIMENT_ROOT，
 * 未设置时取当前工作目录（启动器与 npm 工作区脚本均在分项目录内运行）。
 */
export const experimentRoot = resolve(process.env.A5_EXPERIMENT_ROOT ?? process.cwd());

/** 分项差异的静态声明，位于 `<分项>/config/experiment.json`；题目、触发规则等内容差异在 content/tasks.json 内。 */
export interface ExperimentProfile {
  experiment_id: string;
  /** 任务组编号前缀，例如 SH、SL；任务组为前缀+01…07。 */
  stage_prefix: string;
  title: string;
  /** 是否有补充资料附件（SH 有，SL 没有）。 */
  attachments: boolean;
  /** SH 的 F 标记所在单元；没有则不记录。 */
  f_candidate_unit?: string;
  /** 自检输出的待办事项；缺省时使用 SH 的清单。 */
  remaining?: string[];
}

const file = join(experimentRoot, 'config/experiment.json');
export const profile: ExperimentProfile = (() => {
  try { return JSON.parse(readFileSync(file, 'utf8')) as ExperimentProfile; }
  catch (error) { throw new Error(`缺少实验分项配置 ${file}（工作目录或 A5_EXPERIMENT_ROOT 不是实验分项目录）：${(error as Error).message}`); }
})();

export const stageIds: readonly string[] = Array.from({ length: 7 }, (_, i) => `${profile.stage_prefix}${String(i + 1).padStart(2, '0')}`);
export const readJson = async <T>(relative: string): Promise<T> => JSON.parse(await readFile(join(experimentRoot, relative), 'utf8'));
