/** 任务组编号随实验分项变化（SH01—SH07、SL01—SL07…），由 config/experiment.json 的 stage_prefix 决定。 */
export type StageId = string;
export const conditions = ['N-T0', 'N-T1', 'N-T2', 'A-T0', 'A-T1', 'A-T2', 'NONE'] as const;
export type Condition = typeof conditions[number];
import type { DisplayMode } from '@a5/glasses/contracts.ts';
export type { DisplayMode };
export type { GlassesRequest, GlassesReceipt, GlassesEvent, GlassesStatus, GlassesAdapter } from '@a5/glasses/contracts.ts';

export interface Assignment {
  stage_id: StageId;
  condition: Condition;
  message_id: string | null;
  display_mode?: DisplayMode;
}

export interface Participant {
  participant_id: string;
  version_label?: string;
  debug?: boolean;
  copied_from?: string;
  stages: Assignment[];
}

export interface ParticipantConfig {
  experiment_id: string;
  schema_version: string;
  participants: Participant[];
  debug_participant?: Participant;
  config_name?: string;
}

export interface Stimulus {
  stage_id: StageId;
  message_id: string;
  text: string;
  duration_ms: number;
  question: string;
  options: { id: string; text: string }[];
  correct_option: string;
}
