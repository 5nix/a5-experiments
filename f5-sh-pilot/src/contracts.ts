export const stageIds = ['SH01', 'SH02', 'SH03', 'SH04', 'SH05'] as const;
export type StageId = typeof stageIds[number];
export type Condition = 'N-T0' | 'N-T1' | 'A-T0' | 'A-T1' | 'NONE';

export interface Assignment {
  stage_id: StageId;
  condition: Condition;
  message_id: string | null;
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

export interface GlassesRequest {
  request_id: string;
  session_id: string;
  participant_id: string;
  stage_id: StageId;
  message_id: string;
  text: string;
  duration_ms: 8500;
  device_id?: string;
}

export interface GlassesReceipt {
  request_id: string;
  source: 'mock' | 'device';
  status: 'accepted' | 'failed' | 'unacknowledged';
  t_send: string;
  t_ack: string | null;
  t_display: string | null;
  t_hide: string | null;
  display_time_source: 'mock' | 'device_reported' | 'unavailable';
  error: string | null;
  device_id?: string;
  evidence?: unknown;
}

/** 设备时钟原样保存；应用绘制证据不等于光学呈现实测。 */
export interface GlassesEvent {
  event_id: string;
  request_id: string;
  device_id: string;
  kind: 'accepted' | 'drawn' | 'hidden' | 'failed';
  device_wall_ms: number;
  device_monotonic_ms: number;
  clock_id: string;
  error: string | null;
}
export interface GlassesStatus {
  source: 'mock' | 'device'; connected: boolean;
  device_id?: string; ready?: boolean; busy?: boolean; error?: string | null;
  protocol?: string; independent_duration?: boolean; persistent_deduplication?: boolean;
  display_evidence?: string; device_info?: Record<string, string>;
}
export interface GlassesAdapter {
  getStatus(): GlassesStatus;
  probe?(): Promise<void>;
  reconnect?(): Promise<void>;
  pollEvents?(receive: (event: GlassesEvent) => void): Promise<void>;
  close?(): void | Promise<void>;
  send(request: GlassesRequest): Promise<GlassesReceipt>;
}
