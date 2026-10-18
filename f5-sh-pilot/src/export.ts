import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { Engine } from './engine.ts';
import type { EventRecord } from './store.ts';

type Row = Record<string, unknown>;
function csv(headers: string[], rows: Row[]) {
  const cell = (v: unknown) => {
    if (v === undefined || v === null) return '';
    let text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [headers.map(cell).join(','), ...rows.map(row => headers.map(h => cell(row[h])).join(','))].join('\r\n') + '\r\n';
}
const timestamp = (event?: EventRecord) => event?.timestamp_iso ?? null;
const elapsed = (event?: EventRecord) => event?.elapsed_ms ?? null;
const last = <T>(array: T[]) => array[array.length - 1];

export async function exportData(engine: Engine, ids: string[], outputRoot: string) {
  const captures = ids.map(id => {
    const summary = engine.summary(id);
    return { session: engine.session(id), events: engine.store.events(id), interventions: engine.store.interventions(id), summary };
  });
  const events = captures.flatMap(c => c.events);
  const trials: Row[] = [], surveys: Row[] = [], notes: Row[] = [], sessions: Row[] = [], interventions: Row[] = [];
  for (const c of captures) {
    const { session: s } = c; const participant = s.snapshot.participant;
    const common = { session_id: s.id, participant_id: participant.participant_id, is_debug: engine.isDebug(s), version_label: participant.version_label ?? '', content_version: s.snapshot.content.content_version };
    const intro = c.events.find(e => e.event_type === 'intro_displayed'); const introEnd = c.events.find(e => e.event_type === 'intro_continue');
    sessions.push({ ...common, ...c.summary, device_source: (c.events.find(e => e.event_type === 'session_created')?.payload.adapter as { source?: string })?.source,
      stimulus_version: s.snapshot.stimulus_version, content_hash: s.snapshot.content_hash, intro_displayed: timestamp(intro), intro_continue: timestamp(introEnd), intro_duration_ms: intro && introEnd ? introEnd.elapsed_ms - intro.elapsed_ms : null,
      resume_count: c.events.filter(e => e.event_type === 'app_resumed').length, anomaly_count: s.state.attention.length,
      breaks_skipped: c.events.filter(e => e.event_type === 'break_skipped').length, debug_jumps: c.events.filter(e => e.event_type === 'debug_jump').length });
    for (const stage of s.snapshot.content.stages) {
      const assignment = participant.stages.find(a => a.stage_id === stage.stage_id)!;
      for (const unit of stage.units) {
        const unitEvents = c.events.filter(e => e.unit_id === unit.unit_id);
        const displayed = unitEvents.find(e => e.event_type === 'unit_displayed');
        const submission = unitEvents.find(e => e.event_type === 'submission_recorded');
        if (!unitEvents.length) continue;
        const edits = unitEvents.filter(e => e.event_type === 'answer_changed');
        const revealClick = unitEvents.find(e => e.event_type === 'reveal_clicked' && e.payload.open === true);
        const reveal = unitEvents.find(e => e.event_type === 'reveal_displayed'); const f = unitEvents.find(e => e.event_type === 'F_candidate');
        trials.push({ ...common, stage_id: stage.stage_id, unit_id: unit.unit_id, condition: assignment.condition,
          page_displayed: timestamp(displayed), page_displayed_elapsed_ms: elapsed(displayed), client_display_evidence: displayed?.payload.client ?? null,
          e_clicked: timestamp(revealClick), e_displayed: timestamp(reveal), e_elapsed_ms: elapsed(reveal), f_submitted: timestamp(f), f_semantics: f?.payload.semantics ?? null,
          first_answer: timestamp(edits[0]), last_answer: timestamp(last(edits)), first_answer_elapsed_ms: elapsed(edits[0]), last_answer_elapsed_ms: elapsed(last(edits)),
          submitted: timestamp(submission), submitted_elapsed_ms: elapsed(submission), raw_answer: submission?.payload.raw_answer ?? null, normalized_answer: submission?.payload.normalized_answer ?? null,
          score: unitEvents.find(e => e.event_type === 'unit_scored')?.payload.score ?? null,
          completion_ms: displayed && submission ? submission.elapsed_ms - displayed.elapsed_ms : null, submission_attempts: unitEvents.filter(e => e.event_type === 'submit_clicked').length,
          scratchpad_text: s.state.scratchpads?.[unit.unit_id] ?? '', scratchpad_changes: unitEvents.filter(e => e.event_type === 'scratchpad_changed').length });
      }
      const comp = c.events.find(e => e.stage_id === stage.stage_id && e.event_type === 'comprehension_submitted');
      const ratings = c.events.find(e => e.stage_id === stage.stage_id && e.event_type === 'ratings_submitted');
      if (comp || ratings) surveys.push({ ...common, stage_id: stage.stage_id, condition: assignment.condition, message_id: assignment.message_id,
        comprehension_answer: comp?.payload.answer ?? null, comprehension_correct: comp?.payload.correct ?? null, comprehension_submitted: timestamp(comp),
        ...(ratings?.payload.ratings as Row ?? {}), ratings_submitted: timestamp(ratings) });
    }
    for (const e of c.events.filter(e => e.event_type === 'note_saved')) notes.push({ ...common, ...e.payload, saved_at: e.timestamp_iso, elapsed_ms: e.elapsed_ms });
    for (const message of c.interventions) {
      const sent = message.t_send ? Date.parse(message.t_send) : null;
      const ack = message.t_ack ? Date.parse(message.t_ack) : null;
      const displayed = message.t_display ? Date.parse(message.t_display) : null;
      interventions.push({ ...common, ...message, timing: message.condition.split('-')[1], latency_baseline: 't_event', latency_unit: 'ms',
        send_latency_ms: sent === null ? null : sent - Date.parse(message.t_event), acknowledgement_latency_ms: sent !== null && ack !== null ? ack - sent : null,
        display_latency_ms: displayed === null ? null : displayed - Date.parse(message.t_event) });
    }
  }
  const files: Record<string, string> = {
    'events.jsonl': events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''),
    'trials.csv': csv(['session_id', 'participant_id', 'is_debug', 'version_label', 'stage_id', 'unit_id', 'condition', 'page_displayed', 'page_displayed_elapsed_ms', 'client_display_evidence', 'e_clicked', 'e_displayed', 'e_elapsed_ms', 'f_submitted', 'f_semantics', 'first_answer', 'last_answer', 'first_answer_elapsed_ms', 'last_answer_elapsed_ms', 'submitted', 'submitted_elapsed_ms', 'raw_answer', 'normalized_answer', 'score', 'completion_ms', 'submission_attempts', 'scratchpad_text', 'scratchpad_changes', 'content_version'], trials),
    'interventions.csv': csv(['session_id', 'participant_id', 'is_debug', 'stage_id', 'condition', 'message_id', 'timing', 'request_id', 'duration_ms', 't_event', 'event_elapsed_ms', 't_send', 't_ack', 't_display', 't_hide', 'source', 'display_time_source', 'status', 'error', 'send_latency_ms', 'acknowledgement_latency_ms', 'display_latency_ms', 'latency_baseline', 'latency_unit', 'receipt', 'content_version'], interventions),
    'surveys.csv': csv(['session_id', 'participant_id', 'is_debug', 'stage_id', 'condition', 'message_id', 'comprehension_answer', 'comprehension_correct', 'comprehension_submitted', 'timing', 'disruption', 'effort', 'helpfulness', 'ratings_submitted', 'content_version'], surveys),
    'sessions.csv': csv(['session_id', 'participant_id', 'is_debug', 'copied_from', 'version_label', 'status', 'phase', 'started_at', 'ended_at', 'elapsed_ms', 'device_source', 'real_presentation_verified', 'validation_status', 'intro_displayed', 'intro_continue', 'intro_duration_ms', 'resume_count', 'anomaly_count', 'breaks_skipped', 'debug_jumps', 'attention', 'config_hash', 'content_hash', 'content_version', 'stimulus_version'], sessions),
    'notes.csv': csv(['session_id', 'participant_id', 'is_debug', 'note_id', 'category', 'stage_id', 'text', 'saved_at', 'elapsed_ms', 'content_version'], notes),
    'snapshots.json': JSON.stringify(captures.map(c => ({ session_id: c.session.id, snapshot: c.session.snapshot })), null, 2),
    'manifest.json': JSON.stringify({ schema_version: '1.1', created_at: new Date().toISOString(), session_ids: ids,
      debug_session_ids: captures.filter(c => engine.isDebug(c.session)).map(c => c.session.id),
      row_counts: { events: events.length, trials: trials.length, interventions: interventions.length, surveys: surveys.length, sessions: sessions.length, notes: notes.length },
      timing: '服务器ISO墙上时间与会话单调相对毫秒；客户端实际可见证据在事件payload；未测得时间为null/CSV空值。恢复衔接包含停机时间。',
      presentation: 'Mock不是实际眼镜显示；本应用不控制消息关闭。', csv: 'UTF-8 BOM；公式前缀字符串在CSV加单引号，原始值在JSONL中保留。' }, null, 2),
  };
  const exportId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = join(outputRoot, exportId); await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(directory, name), text, 'utf8')));
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 1 });
  await writeFile(join(directory, 'export.zip'), bytes);
  return { export_id: exportId, directory, bytes, row_counts: { events: events.length, trials: trials.length, interventions: interventions.length, surveys: surveys.length, sessions: sessions.length, notes: notes.length } };
}
