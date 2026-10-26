import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { Engine } from './engine.ts';
import { HttpError } from './engine.ts';
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
    if (engine.session(id).state.deleted) throw new HttpError(410, '此会话记录已删除，请先恢复记录再导出。');
    const summary = engine.summary(id);
    return { session: engine.session(id), events: engine.store.events(id), interventions: engine.store.interventions(id), summary };
  });
  const events = captures.flatMap(c => c.events);
  const trials: Row[] = [], surveys: Row[] = [], breaks: Row[] = [], notes: Row[] = [], sessions: Row[] = [], interventions: Row[] = [];
  for (const c of captures) {
    const { session: s } = c; const participant = s.snapshot.participant;
    const common = { session_id: s.id, participant_id: participant.participant_id, is_debug: engine.isDebug(s), version_label: participant.version_label ?? '', content_version: s.snapshot.content.content_version };
    const intro = c.events.find(e => e.event_type === 'intro_displayed'); const introEnd = c.events.find(e => e.event_type === 'intro_continue');
    const tutorialStart=c.events.find(e=>e.event_type==='tutorial_intro_displayed'), tutorialEnd=c.events.find(e=>e.event_type==='tutorial_completed');
    sessions.push({ ...common, tutorial_started_at:timestamp(tutorialStart),tutorial_completed_at:timestamp(tutorialEnd),tutorial_duration_ms:tutorialStart&&tutorialEnd?tutorialEnd.elapsed_ms-tutorialStart.elapsed_ms:null,tutorial_answer_attempts:c.events.filter(e=>e.event_type==='tutorial_answer_submitted').length, ...c.summary, device_source: (c.events.find(e => e.event_type === 'session_created')?.payload.adapter as { source?: string })?.source,
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
      const ratingsSkipped = c.events.find(e => e.stage_id === stage.stage_id && e.event_type === 'ratings_skipped');
      if (comp || ratings) surveys.push({ ...common, stage_id: stage.stage_id, condition: assignment.condition, message_id: assignment.message_id,
        message_notice: comp?.payload.message_notice ?? null,
        comprehension_answer: comp?.payload.answer ?? null, comprehension_correct: comp?.payload.correct ?? null, comprehension_submitted: timestamp(comp),
        ratings_status: ratings ? 'submitted' : ratingsSkipped ? 'skipped' : 'pending',
        ratings_skip_reason: ratingsSkipped?.payload.reason ?? null, ratings_skipped_at: timestamp(ratingsSkipped),
        ...(ratings?.payload.ratings as Row ?? {}), ratings_submitted: timestamp(ratings) });
    }
    for (const displayed of c.events.filter(e => e.event_type === 'break_displayed')) {
      const breakId = displayed.payload.page_token;
      const related = c.events.filter(e => breakId && e.payload.break_id === breakId);
      const started = related.find(e => e.event_type === 'break_started');
      const completed = related.find(e => e.event_type === 'break_completed');
      const continued = related.find(e => e.event_type === 'continue_clicked');
      const skipped = related.find(e => e.event_type === 'break_skipped');
      const finish = continued ?? skipped;
      breaks.push({ ...common, break_id: breakId, stage_id: displayed.stage_id, condition: displayed.condition,
        planned_rest_ms: started?.payload.duration_ms ?? s.snapshot.content.break_ms,
        displayed_at: displayed.timestamp_iso, displayed_elapsed_ms: displayed.elapsed_ms, display_client: displayed.payload.client ?? null,
        countdown_ended_at: completed?.payload.countdown_ended_at ?? null,
        countdown_ended_elapsed_ms: completed?.payload.countdown_ended_elapsed_ms ?? null, completion_observed_at: timestamp(completed),
        continue_clicked_at: timestamp(continued), continue_clicked_elapsed_ms: elapsed(continued), continue_client: continued?.payload.client ?? null,
        actual_rest_ms: finish?.payload.actual_rest_ms ?? null,
        ended_by: continued ? 'continue' : skipped ? 'skip' : null,
        skipped_at: timestamp(skipped), skip_actor: skipped?.payload.actor ?? null, skip_reason: skipped?.payload.reason ?? null,
        remaining_at_skip_ms: skipped?.payload.remaining_ms ?? null });
    }
    for (const e of c.events.filter(e => e.event_type === 'note_saved')) notes.push({ ...common, ...e.payload, saved_at: e.timestamp_iso, elapsed_ms: e.elapsed_ms });
    for (const message of c.interventions) {
      const deviceEvent = (kind: string) => message.device_events?.find(e => e.kind === kind);
      const duration = (from: string, to: string) => {
        const a = deviceEvent(from), b = deviceEvent(to);
        return a && b && a.clock_id === b.clock_id && b.device_monotonic_ms >= a.device_monotonic_ms ? b.device_monotonic_ms - a.device_monotonic_ms : null;
      };
      const sent = message.t_send ? Date.parse(message.t_send) : null;
      const ack = message.t_ack ? Date.parse(message.t_ack) : null;
      const displayed = message.t_display ? Date.parse(message.t_display) : null;
      interventions.push({ ...common, ...message, data_kind:message.data_kind??'formal', timing: message.condition.split('-')[1], latency_baseline: 't_event', latency_unit: 'ms',
        display_mode: message.display_mode ?? s.snapshot.display_mode ?? 'legacy_8500',
        auto_hide_after_ms: (message.display_mode ?? s.snapshot.display_mode) === 'confirm_until_ack' ? null : message.duration_ms,
        device_drawn_wall_ms: deviceEvent('drawn')?.device_wall_ms ?? null, device_drawn_monotonic_ms: deviceEvent('drawn')?.device_monotonic_ms ?? null,
        device_hidden_wall_ms: deviceEvent('hidden')?.device_wall_ms ?? null, device_hidden_monotonic_ms: deviceEvent('hidden')?.device_monotonic_ms ?? null,
        hide_reason: deviceEvent('hidden')?.hide_reason ?? null,
        device_confirmed_wall_ms: deviceEvent('confirmed')?.device_wall_ms ?? null, device_confirmed_monotonic_ms: deviceEvent('confirmed')?.device_monotonic_ms ?? null,
        cue_status: deviceEvent('cue_failed') ? 'failed' : deviceEvent('cue_started') ? 'started' : message.display_mode === 'tone_8500' ? 'unverified' : 'not_required',
        confirmation_recorded: !!message.confirmation_requested_at, device_confirmation_recorded: !!deviceEvent('confirmed'),
        device_confirmation_delay_ms: duration('drawn', 'confirmed'), actual_display_duration_ms: duration('drawn', 'hidden'), post_confirmation_duration_ms: duration('confirmed', 'hidden'),
        send_latency_ms: sent === null ? null : sent - Date.parse(message.t_event), acknowledgement_latency_ms: sent !== null && ack !== null ? ack - sent : null,
        display_latency_ms: displayed === null ? null : displayed - Date.parse(message.t_event) });
    }
  }
  const files: Record<string, string> = {
    'notice_clicks.csv': csv(['session_id','participant_id','is_debug','data_kind','event_id','timestamp_iso','elapsed_ms','stage_id','unit_id','condition','click_id','disposition','pending_request_id','confirmation_request_id','phase','page_token','page_token_matches','visible_request_id','client_timestamp_iso','client_monotonic_ms','client_time_origin_ms','client_visibility_state','client'],events.filter(e=>e.event_type==='notice_read_clicked').map(e=>({...e,...e.payload,client_timestamp_iso:(e.payload.client as Row|null)?.timestamp_iso??null,client_monotonic_ms:(e.payload.client as Row|null)?.monotonic_ms??null,client_time_origin_ms:(e.payload.client as Row|null)?.time_origin_ms??null,client_visibility_state:(e.payload.client as Row|null)?.visibility_state??null}))),
    'tutorial.csv': csv(['session_id','participant_id','data_kind','event_id','event_type','timestamp_iso','elapsed_ms','payload'],events.filter(e=>e.data_kind==='tutorial').map(e=>({...e,data_kind:'tutorial'}))),
    'events.jsonl': events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''),
    'breaks.csv': csv(['session_id', 'participant_id', 'is_debug', 'break_id', 'stage_id', 'condition', 'planned_rest_ms', 'displayed_at', 'displayed_elapsed_ms', 'display_client', 'countdown_ended_at', 'countdown_ended_elapsed_ms', 'completion_observed_at', 'continue_clicked_at', 'continue_clicked_elapsed_ms', 'continue_client', 'actual_rest_ms', 'ended_by', 'skipped_at', 'skip_actor', 'skip_reason', 'remaining_at_skip_ms', 'content_version'], breaks),
    'trials.csv': csv(['session_id', 'participant_id', 'is_debug', 'version_label', 'stage_id', 'unit_id', 'condition', 'page_displayed', 'page_displayed_elapsed_ms', 'client_display_evidence', 'e_clicked', 'e_displayed', 'e_elapsed_ms', 'f_submitted', 'f_semantics', 'first_answer', 'last_answer', 'first_answer_elapsed_ms', 'last_answer_elapsed_ms', 'submitted', 'submitted_elapsed_ms', 'raw_answer', 'normalized_answer', 'score', 'completion_ms', 'submission_attempts', 'scratchpad_text', 'scratchpad_changes', 'content_version'], trials),
    'interventions.csv': csv(['session_id', 'participant_id', 'is_debug', 'stage_id', 'condition', 'message_id', 'data_kind', 'timing', 'request_id', 'device_id', 'device_events', 'duration_ms', 'display_mode', 'auto_hide_after_ms', 'device_drawn_wall_ms', 'device_drawn_monotonic_ms', 'device_hidden_wall_ms', 'device_hidden_monotonic_ms', 'hide_reason', 'device_confirmed_wall_ms', 'device_confirmed_monotonic_ms', 'cue_status', 'confirmation_requested_at', 'confirmation_elapsed_ms', 'confirmation_status', 'confirmation_recorded', 'device_confirmation_recorded', 'device_confirmation_delay_ms', 'actual_display_duration_ms', 'post_confirmation_duration_ms', 't_event', 'event_elapsed_ms', 't_send', 't_ack', 't_display', 't_hide', 'source', 'display_time_source', 'status', 'error', 'send_latency_ms', 'acknowledgement_latency_ms', 'display_latency_ms', 'latency_baseline', 'latency_unit', 'receipt', 'content_version'], interventions),
    'surveys.csv': csv(['session_id', 'participant_id', 'is_debug', 'stage_id', 'condition', 'message_id', 'message_notice', 'comprehension_answer', 'comprehension_correct', 'comprehension_submitted', 'ratings_status', 'ratings_skip_reason', 'ratings_skipped_at', 'timing', 'attention_distraction', 'thought_disruption', 'task_interference', 'perceived_disturbance', 'disruption', 'effort', 'helpfulness', 'ratings_submitted', 'content_version'], surveys),
    'sessions.csv': csv(['session_id', 'participant_id', 'is_debug', 'copied_from', 'version_label', 'display_mode', 'status', 'phase', 'started_at', 'ended_at', 'elapsed_ms', 'device_source', 'real_presentation_verified', 'validation_status', 'device_id', 'expected_messages', 'device_drawn_messages', 'application_presentation_complete', 'tutorial_started_at','tutorial_completed_at','tutorial_duration_ms','tutorial_answer_attempts','intro_displayed', 'intro_continue', 'intro_duration_ms', 'resume_count', 'anomaly_count', 'breaks_skipped', 'debug_jumps', 'attention', 'config_hash', 'content_hash', 'content_version', 'stimulus_version'], sessions),
    'notes.csv': csv(['session_id', 'participant_id', 'is_debug', 'note_id', 'category', 'stage_id', 'text', 'saved_at', 'elapsed_ms', 'content_version'], notes),
    'snapshots.json': JSON.stringify(captures.map(c => ({ session_id: c.session.id, snapshot: c.session.snapshot })), null, 2),
    'manifest.json': JSON.stringify({ schema_version: '1.10', created_at: new Date().toISOString(), session_ids: ids,
      break_semantics: 'v9起默认30000毫秒，休息页实际可见回执后起算。breaks.csv记录显示、倒计时结束、继续点击和实际休息毫秒数；actual_rest_ms为显示到继续/跳过的会话单调时间差，包含到零后停留及人工暂停时间，不封顶为计划时长。人工暂停冻结倒计时。countdown_ended_at为倒计时逻辑到零时刻，completion_observed_at为服务端检测时刻；客户端显示与点击证据另存。未继续/未跳过或历史缺字段时留空，不伪造实际时长。',
      survey_fields: { message_notice: { not_noticed: '没有注意到任何消息提示', partially_read: '注意到了提示，但没有完整读到消息内容', fully_read: '完整读到了消息内容' },
        ratings: { timing: '消息出现的时机', attention_distraction: '分散注意力', thought_disruption: '扰乱思路', task_interference: '妨碍继续完成任务', perceived_disturbance: '感到被打扰' },
        legacy_ratings: ['disruption', 'effort', 'helpfulness'],
        ratings_status: { submitted: '已提交', skipped: '按规则跳过', pending: '尚未提交' },
        ratings_skip_reason: { not_noticed: '未注意到消息提示', no_message: '无消息条件' },
        semantics: '消息注意情况与内容题分别保存，内容题仍单独判分。v8起提交并保存理解页后，未注意到提示者跳过量表，其余进入量表，与内容题正误无关。跳过的评分为空；无消息组的两页跳过原因写入events.jsonl，不生成虚假问卷行。旧会话按快照规则执行，缺少的新增字段导出为空。' },
      tutorial_event_count:events.filter(e=>e.data_kind==='tutorial').length, tutorial_semantics:'教程数据单独标记，不计入正式题目和正式呈现完成率；tutorial.csv包含作答尝试及设备证据。手动通知标记manual。',
      debug_session_ids: captures.filter(c => engine.isDebug(c.session)).map(c => c.session.id),
      row_counts: { events: events.length, trials: trials.length, interventions: interventions.length, surveys: surveys.length, breaks: breaks.length, sessions: sessions.length, notes: notes.length },
      timing: '服务器ISO墙上时间与会话单调相对毫秒；客户端实际可见证据在事件payload；未测得时间为null/CSV空值。恢复衔接包含停机时间。',
      presentation: 'Mock不是真机证据。策略标识legacy_8500、tone_8500为兼容名称，v10起新会话两种固定模式从设备drawn事件记录时刻起计11000ms，分别无提示音/沿用提示音。confirm_until_ack沿用原提示音配置，持续至确认后立即关闭，不设自动或确认后倒计时；其duration_ms为兼容协议值，不参与计时，auto_hide_after_ms为空。实际绘制、隐藏和确认时间来自设备事件；hide_reason区分auto_timeout、user_confirmed及异常取消，旧数据缺失原因时留空。cue_started仅说明播放调用成功，不证明可听见；确认不是注意起点。电脑与眼镜时钟未同步，仅在同一设备clock_id内计算间隔，不换算跨设备时间。结束会话时取消未结束的持续消息，保留失败/未确认记录。', adapter: engine.adapter.getStatus(), csv: 'UTF-8 BOM；公式前缀字符串在CSV加单引号，原始值在JSONL中保留。' }, null, 2),
  };
  const exportId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = join(outputRoot, exportId); await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(directory, name), text, 'utf8')));
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 1 });
  await writeFile(join(directory, 'export.zip'), bytes);
  return { export_id: exportId, directory, bytes, row_counts: { events: events.length, trials: trials.length, interventions: interventions.length, surveys: surveys.length, breaks: breaks.length, sessions: sessions.length, notes: notes.length } };
}
