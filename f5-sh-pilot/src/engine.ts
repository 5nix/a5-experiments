import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Store } from './store.ts';
import type { EventRecord, Intervention, Session, Phase } from './store.ts';
import { hash, InputError, normalize, score } from './tasks.ts';
import type { DataTable, Field, Snapshot, Unit } from './tasks.ts';
import type { GlassesAdapter, GlassesEvent, GlassesReceipt, Participant, ParticipantConfig } from './contracts.ts';
import { validateConfig } from './config.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface Command {
  command_id: string; page_token: string; action: string; answer?: Record<string, unknown>; open?: boolean;
  text?: string; target?: string;
  client?: { timestamp_iso?: string; monotonic_ms?: number; time_origin_ms?: number; visibility_state?: string; user_agent?: string };
}
export type Material = Omit<Snapshot, 'participant' | 'config_hash' | 'content_hash'>;

export class Engine {
  readonly store: Store;
  readonly adapter: GlassesAdapter;
  readonly material: Material;
  private readonly wallNow: () => number;
  private readonly monoNow: () => number;
  private readonly clocks = new Map<string, { base: number; origin: number }>();
  private readonly pending = new Set<Promise<void>>();

  constructor(store: Store, adapter: GlassesAdapter, material: Material, initialConfig: ParticipantConfig, clock?: { wall: () => number; mono: () => number }) {
    this.store = store; this.adapter = adapter; this.material = material;
    this.wallNow = clock?.wall ?? Date.now; this.monoNow = clock?.mono ?? (() => performance.now());
    if (!store.setting('participants')) this.importConfig(initialConfig);
    for (const id of store.allIds()) {
      const session = this.session(id);
      this.store.tx(() => {
        if (session.state.status === 'active') this.log(session, 'server_restarted', { clock_source: 'max(persisted_elapsed,wall_since_start)', downtime_included: true });
        for (const message of this.store.interventions(id)) if (['scheduled', 'send_requested'].includes(message.status)) {
          message.status = 'unknown'; message.error = 'server_restarted_delivery_unknown'; this.store.intervention(message);
          session.state.attention.push(`${message.stage_id}:message_delivery_unknown`);
          this.log(session, 'message_failed', { request_id: message.request_id, reason: message.error, retry: false }, { stage_id: message.stage_id, unit_id: null, condition: message.condition });
        }
        this.store.save(session);
      });
    }
  }

  config(): ParticipantConfig { return this.store.setting<ParticipantConfig>('participants')!; }
  debugParticipant(): Participant | null {
    const template = this.config().participants.find(p => p.participant_id === '001');
    return template ? { ...structuredClone(template), participant_id: '000', debug: true, copied_from: '001' } : null;
  }
  isDebug(s: Session) { return s.snapshot.participant.participant_id === '000' && s.snapshot.participant.debug === true && s.snapshot.participant.copied_from === '001'; }
  importConfig(input: unknown) {
    const errors = validateConfig(input, this.material.stimuli);
    if (errors.length) throw new HttpError(422, errors.join('\n'));
    this.store.tx(() => {
      this.store.setSetting('participants', input);
      this.store.db.prepare('INSERT INTO admin_audit(data) VALUES (?)').run(JSON.stringify({ event_type: 'config_imported', timestamp_iso: this.iso(), config_hash: hash(input) }));
    });
    return this.config();
  }
  iso() { return new Date(this.wallNow()).toISOString(); }
  session(id: string) { const s = this.store.get(id); if (!s) throw new HttpError(404, '会话不存在。'); return s; }
  private requireAvailable(s: Session) { if (s.state.deleted) throw new HttpError(410, '此会话记录已删除，请先在后台恢复记录。'); }
  authenticate(id: string, token: string) {
    const session = this.session(id);
    const candidate = hash(token);
    if (!token || !timingSafeEqual(Buffer.from(candidate), Buffer.from(session.token_hash))) throw new HttpError(401, '被试访问凭据无效。');
    this.requireAvailable(session);
    return session;
  }
  elapsed(s: Session) {
    let clock = this.clocks.get(s.id);
    if (!clock) {
      clock = { base: Math.max(s.state.last_elapsed_ms, this.wallNow() - Date.parse(s.state.started_at), 0), origin: this.monoNow() };
      this.clocks.set(s.id, clock);
    }
    return Math.max(s.state.last_elapsed_ms, Math.floor(clock.base + this.monoNow() - clock.origin));
  }
  log(s: Session, type: string, payload: Record<string, unknown> = {}, context?: { stage_id?: string; unit_id?: string | null; condition?: string }) {
    const stage = s.snapshot.content.stages[s.state.stage];
    const assignment = s.snapshot.participant.stages.find(a => a.stage_id === stage?.stage_id);
    const elapsed = this.elapsed(s); s.state.last_elapsed_ms = elapsed;
    const event: EventRecord = {
      event_id: randomUUID(), session_id: s.id, participant_id: s.snapshot.participant.participant_id,
      stage_id: context?.stage_id ?? (s.state.phase === 'INTRO' ? null : stage?.stage_id ?? null),
      unit_id: context?.unit_id === undefined ? (s.state.phase === 'UNIT' ? stage.units[s.state.unit].unit_id : null) : context.unit_id,
      condition: context?.condition ?? (s.state.phase === 'INTRO' ? null : assignment?.condition ?? null),
      event_type: type, timestamp_iso: this.iso(), elapsed_ms: elapsed, payload, content_version: s.snapshot.content.content_version, is_debug: this.isDebug(s),
    };
    this.store.event(event); return event;
  }
  create(participantId: string, metadata: Record<string, unknown> = {}) {
    const participant = participantId === '000' ? this.debugParticipant() : this.config().participants.find(p => p.participant_id === participantId);
    if (!participant) throw new HttpError(404, '被试不在当前已导入配置中。');
    if (this.store.ids().some(id => { const s = this.session(id); return s.snapshot.participant.participant_id === participantId && s.state.status === 'active'; })) throw new HttpError(409, '该被试已有未结束会话，请恢复已有会话。');
    const device = this.adapter.getStatus();
    if (device.source === 'device') {
      if (!device.connected || !device.ready || device.busy || !device.device_id) throw new HttpError(409, '眼镜尚未就绪，请检查 USB、授权和显示端前台状态。');
      if (this.store.ids().some(id => { const existing = this.session(id); return existing.state.status === 'active' && existing.state.device_id === device.device_id; })) throw new HttpError(409, '此眼镜已绑定一个进行中的会话，请先结束该会话。');
    }
    const token = randomBytes(32).toString('hex');
    const snapshot: Snapshot = structuredClone({ ...this.material, participant, config_hash: hash(participant), content_hash: hash(this.material) });
    const s: Session = { id: randomUUID(), token_hash: hash(token), snapshot, state: {
      phase: 'INTRO', stage: 0, unit: 0, page_token: randomUUID(), displayed: {}, drafts: {}, reveals: {},
      started_at: this.iso(), ended_at: null, ended_elapsed_ms: null, last_elapsed_ms: 0, break_until_ms: null, break_completed: false,
      paused_at_ms: null, attention: [], status: 'active', scratchpads: {}, delivery_source: device.source, ...(device.source === 'device' ? { device_id: device.device_id } : {}),
    } };
    this.clocks.set(s.id, { base: 0, origin: this.monoNow() });
    this.store.tx(() => {
      this.store.create(s);
      this.log(s, 'session_created', { config_hash: snapshot.config_hash, content_hash: snapshot.content_hash, stimulus_version: snapshot.stimulus_version, adapter: this.adapter.getStatus(), metadata, is_debug: this.isDebug(s), copied_from: participant.copied_from ?? null });
      this.store.save(s);
    });
    return { session_id: s.id, token, view: this.view(s.id) };
  }
  rotateToken(id: string) {
    const token = randomBytes(32).toString('hex');
    this.store.tx(() => {
      const s = this.session(id);
      this.requireAvailable(s);
      this.store.db.prepare('UPDATE sessions SET token_hash=? WHERE id=?').run(hash(token), id);
      this.log(s, 'admin_intervention', { action: 'participant_token_rotated' }); this.store.save(s);
    });
    return token;
  }
  unit(s: Session): Unit { return s.snapshot.content.stages[s.state.stage].units[s.state.unit]; }
  assignment(s: Session) { return s.snapshot.participant.stages.find(a => a.stage_id === s.snapshot.content.stages[s.state.stage].stage_id)!; }
  stimulus(s: Session) {
    const a = this.assignment(s); const stimulus = s.snapshot.stimuli.find(m => m.stage_id === a.stage_id && m.message_id === a.message_id);
    if (!stimulus) throw new HttpError(409, '当前配置缺少刺激或理解题。'); return stimulus;
  }
  fields(s: Session): Field[] {
    if (s.state.phase === 'UNIT') return this.unit(s).fields;
    if (s.state.phase === 'COMPREHENSION') return [{ id: 'answer', label: this.stimulus(s).question, type: 'single', required: true, options: this.stimulus(s).options.map(o => ({ value: o.id, label: `${o.id} ${o.text}` })) }];
    if (s.state.phase === 'RATINGS') return s.snapshot.content.ratings.map(r => ({ id: r.id, label: r.label, type: 'single', required: true, options: Array.from({ length: r.max - r.min + 1 }, (_, i) => ({ value: String(i + r.min), label: String(i + r.min) })) }));
    return [];
  }
  draftKey(s: Session) { return `${s.state.stage}:${s.state.phase}:${s.state.unit}`; }
  transition(s: Session, phase: Phase) { s.state.phase = phase; s.state.page_token = randomUUID(); }
  debugTargets(s: Session) {
    if (!this.isDebug(s)) return [];
    const targets: { id: string; label: string; phase: Phase; stage: number; unit: number }[] = [{ id: 'INTRO', label: '情景导入', phase: 'INTRO', stage: 0, unit: 0 }];
    for (const [index, stage] of s.snapshot.content.stages.entries()) {
      targets.push({ id: `${stage.stage_id}_CARD`, label: `${stage.stage_id} 说明卡`, phase: 'CARD', stage: index, unit: 0 });
      stage.units.forEach((unit, n) => targets.push({ id: unit.unit_id, label: `${stage.stage_id} ${unit.title}`, phase: 'UNIT', stage: index, unit: n }));
      if (s.snapshot.participant.stages.find(a => a.stage_id === stage.stage_id)?.condition !== 'NONE') {
        targets.push({ id: `${stage.stage_id}_COMPREHENSION`, label: `${stage.stage_id} 消息理解题`, phase: 'COMPREHENSION', stage: index, unit: 1 });
        targets.push({ id: `${stage.stage_id}_RATINGS`, label: `${stage.stage_id} 四项评价`, phase: 'RATINGS', stage: index, unit: 1 });
      }
      if (index < s.snapshot.content.stages.length - 1) targets.push({ id: `${stage.stage_id}_BREAK`, label: `${stage.stage_id} 休息`, phase: 'BREAK', stage: index, unit: 1 });
    }
    targets.push({ id: 'COMPLETED', label: '完成页', phase: 'COMPLETED', stage: s.snapshot.content.stages.length - 1, unit: 1 });
    return targets;
  }
  private jump(s: Session, targetId: unknown, actor: 'admin' | 'participant', reason: string) {
    if (!this.isDebug(s)) throw new HttpError(403, '只有调试测试者000可以自由跳转。');
    const target = this.debugTargets(s).find(t => t.id === targetId);
    if (!target) throw new HttpError(422, '调试跳转目标无效。');
    this.log(s, 'debug_jump', { from_phase: s.state.phase, from_stage: s.state.stage, from_unit: s.state.unit, target: target.id, actor, reason, is_debug: true });
    s.state.stage = target.stage; s.state.unit = target.unit; s.state.paused_at_ms = null;
    s.state.status = target.phase === 'COMPLETED' ? 'completed' : 'active';
    s.state.ended_at = target.phase === 'COMPLETED' ? this.iso() : null;
    s.state.ended_elapsed_ms = target.phase === 'COMPLETED' ? this.elapsed(s) : null;
    s.state.break_until_ms = null; s.state.break_completed = false;
    this.transition(s, target.phase);
    if (target.phase === 'BREAK') {
      s.state.break_until_ms = this.elapsed(s) + s.snapshot.content.break_ms;
      this.log(s, 'break_started', { duration_ms: s.snapshot.content.break_ms, until_elapsed_ms: s.state.break_until_ms, source_debug_jump: true });
    }
  }
  private nextAfterBreak(s: Session) { s.state.stage++; s.state.unit = 0; s.state.break_until_ms = null; this.transition(s, 'CARD'); }
  private skipBreak(s: Session, actor: 'admin' | 'participant', reason: string) {
    if (s.state.phase !== 'BREAK' || s.state.paused_at_ms !== null || s.state.status !== 'active') throw new HttpError(409, '当前不是可跳过的休息状态。');
    if (s.snapshot.content.allow_break_skip === false) throw new HttpError(409, '此会话协议未开放跳过休息。');
    const remaining = Math.max(0, s.state.break_until_ms! - this.elapsed(s));
    this.log(s, 'break_skipped', { actor, reason, remaining_ms: remaining, actual_rest_ms: Math.max(0, s.snapshot.content.break_ms - remaining), planned_rest_ms: s.snapshot.content.break_ms });
    this.nextAfterBreak(s);
  }
  stageEnd(s: Session) {
    this.log(s, 'stage_completed');
    if (s.state.stage === s.snapshot.content.stages.length - 1) {
      this.transition(s, 'COMPLETED'); s.state.status = 'completed'; s.state.ended_at = this.iso(); s.state.ended_elapsed_ms = this.elapsed(s);
      this.log(s, 'session_completed', { ...this.presentation(s.id), attention_count: s.state.attention.length });
    } else {
      this.transition(s, 'BREAK'); s.state.break_until_ms = this.elapsed(s) + s.snapshot.content.break_ms; s.state.break_completed = false;
      this.log(s, 'break_started', { duration_ms: s.snapshot.content.break_ms, until_elapsed_ms: s.state.break_until_ms });
    }
  }
  tick(id: string) {
    const s = this.session(id);
    if (s.state.phase !== 'BREAK' || s.state.paused_at_ms !== null || s.state.break_completed || this.elapsed(s) < s.state.break_until_ms!) return;
    this.store.tx(() => { s.state.break_completed = true; this.log(s, 'break_completed'); this.store.save(s); });
  }
  view(id: string) {
    this.tick(id);
    const s = this.session(id), state = s.state, content = s.snapshot.content;
    const base = { session_id: id, phase: state.phase as string, page_token: state.page_token, stage_number: state.stage + 1, stage_count: content.stages.length,
      title: '', paragraphs: [] as string[], fields: [] as Field[], assets: [] as { id: string; label: string }[], answer: {} as Record<string, unknown>,
      reveal: null as null | { button_label: string; open: boolean; observed: boolean; paragraphs: string[]; assets: { id: string; label: string }[]; tables: DataTable[] },
      tables: [] as DataTable[], scratchpad: null as null | { label: string; placeholder: string; max_length: number; text: string },
      is_debug: this.isDebug(s), debug_targets: this.debugTargets(s).map(t => ({ id: t.id, label: t.label })),
      remaining_ms: 0, can_continue: true, can_skip_break: false,
      // 当前任务组说明卡中的情景时间，被试端在任务栏固定显示；旧快照无此字段时为null。
      scene_time: state.phase === 'INTRO' ? null : content.stages[state.stage]?.scene_time ?? null };
    if (state.paused_at_ms !== null) return { ...base, phase: 'PAUSED', title: '实验已暂停，请等待实验员。', can_continue: false };
    if (state.phase === 'INTRO') Object.assign(base, content.intro);
    else if (state.phase === 'CARD') { base.title = content.stages[state.stage].title; base.paragraphs = [content.stages[state.stage].card]; }
    else if (state.phase === 'UNIT') {
      const unit = this.unit(s); base.title = unit.title; base.paragraphs = unit.paragraphs; base.assets = (unit.assets ?? []).map(a => ({ id: a.id, label: a.label })); base.tables = unit.tables ?? [];
      if (unit.scratchpad) base.scratchpad = { ...unit.scratchpad, text: state.scratchpads?.[unit.unit_id] ?? '' };
      const reveal = state.reveals[unit.unit_id];
      if (unit.reveal) base.reveal = { button_label: unit.reveal.button_label, open: reveal?.open ?? false, observed: reveal?.displayed ?? false,
        paragraphs: reveal?.open ? unit.reveal.paragraphs : [], assets: reveal?.open ? (unit.reveal.assets ?? []).map(a => ({ id: a.id, label: a.label })) : [], tables: reveal?.open ? unit.reveal.tables ?? [] : [] };
    } else if (state.phase === 'COMPREHENSION') base.title = '消息理解题';
    else if (state.phase === 'RATINGS') base.title = '信息体验评价';
    else if (state.phase === 'BREAK') { base.title = '休息'; base.remaining_ms = Math.max(0, state.break_until_ms! - this.elapsed(s)); base.can_continue = base.remaining_ms === 0; base.can_skip_break = s.snapshot.content.allow_break_skip !== false; }
    else if (state.phase === 'COMPLETED') { base.title = '实验完成'; base.paragraphs = [content.completion_text]; }
    else base.title = '实验已结束，请联系实验员。';
    base.fields = this.fields(s); base.answer = state.drafts[this.draftKey(s)] ?? {};
    return base;
  }
  private schedule(s: Session, event: EventRecord, timing: 'T0' | 'T1') {
    const a = this.assignment(s);
    if (a.condition === 'NONE' || !a.condition.endsWith(timing) || this.store.interventions(s.id).some(m => m.stage_id === a.stage_id)) return;
    const message: Intervention = { session_id: s.id, participant_id: s.snapshot.participant.participant_id, stage_id: a.stage_id, message_id: a.message_id!, condition: a.condition,
      device_id: s.state.device_id, device_events: [], request_id: randomUUID(), status: 'scheduled', source: this.deliverySource(s), duration_ms: s.snapshot.content.message_duration_ms,
      t_event: event.timestamp_iso, event_elapsed_ms: event.elapsed_ms, t_send: null, t_ack: null, t_display: null, t_hide: null,
      display_time_source: 'unavailable', receipt: null, error: null };
    this.store.intervention(message);
    this.log(s, 'message_scheduled', { request_id: message.request_id, trigger_event_id: event.event_id, timing, duration_ms: message.duration_ms });
  }
  private dispatch(id: string) {
    for (const message of this.store.interventions(id).filter(m => m.status === 'scheduled')) {
      const s = this.session(id); const stimulus = s.snapshot.stimuli.find(m => m.stage_id === message.stage_id && m.message_id === message.message_id)!;
      const context = { stage_id: message.stage_id, unit_id: null, condition: message.condition };
      this.store.tx(() => {
        message.status = 'send_requested'; message.t_send = this.iso(); this.store.intervention(message);
        this.log(s, 'message_send_requested', { request_id: message.request_id, message_id: message.message_id, duration_ms: message.duration_ms, source: message.source }, context); this.store.save(s);
      });
      // 已先持久化发送意图；网络调用绝不阻塞主任务响应，不在恢复后自动重发。
      let timer: ReturnType<typeof setTimeout>;
      const sending = Promise.resolve().then(() => {
        const target = this.adapter.getStatus();
        if (target.source !== message.source || (message.source === 'device' && target.device_id !== message.device_id)) throw new Error('adapter_mode_or_device_mismatch');
        return this.adapter.send({ session_id: id, participant_id: message.participant_id, stage_id: stimulus.stage_id, message_id: stimulus.message_id,
        request_id: message.request_id, text: stimulus.text, device_id: message.device_id, duration_ms: message.duration_ms as 8500 });
      });
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('adapter_send_timeout_delivery_unknown')), 5000); });
      const task = Promise.race([sending, deadline]).then(receipt => {
        if (receipt.request_id !== message.request_id || receipt.source !== message.source || (message.device_id && receipt.device_id !== message.device_id)) throw new Error('adapter_receipt_identity_mismatch');
        this.store.tx(() => {
          const current = this.session(id);
          // 轮询事件可能先到；始终合并数据库中的最新记录。
          Object.assign(message, this.store.findRequest(message.request_id));
          const deviceFailed = message.device_events?.some(e => e.kind === 'failed');
          Object.assign(message, { status: deviceFailed || receipt.status === 'failed' ? 'failed' : message.device_events?.length ? 'accepted' : receipt.status, source: receipt.source, t_ack: receipt.t_ack, t_display: receipt.t_display, t_hide: receipt.t_hide,
            display_time_source: receipt.display_time_source, receipt, error: receipt.status === 'failed' ? receipt.error : deviceFailed ? message.error : message.device_events?.length ? null : receipt.error });
          this.store.intervention(message);
          this.log(current, receipt.status === 'accepted' ? 'message_send_accepted' : 'message_failed', { request_id: message.request_id, receipt }, context);
          if (receipt.t_display) this.log(current, 'message_display_confirmed', { request_id: message.request_id, t_display: receipt.t_display, source: receipt.source }, context);
          if (receipt.t_hide) this.log(current, 'message_hidden', { request_id: message.request_id, t_hide: receipt.t_hide, source: receipt.source }, context);
          if (receipt.status !== 'accepted') current.state.attention.push(`${message.stage_id}:${receipt.error ?? receipt.status}`);
          this.store.save(current);
        });
      }).catch(error => {
        this.store.tx(() => {
          const current = this.session(id); Object.assign(message, this.store.findRequest(message.request_id));
          if (message.device_events?.length) { this.log(current, 'message_transport_error', { request_id: message.request_id, reason: String(error) }, context); this.store.save(current); return; }
          message.status = message.source === 'device' ? 'unknown' : 'failed'; message.error = error instanceof Error ? error.message : String(error);
          this.store.intervention(message); current.state.attention.push(`${message.stage_id}:message_failed`);
          this.log(current, 'message_failed', { request_id: message.request_id, reason: message.error }, context); this.store.save(current);
        });
      });
      const tracked = task.finally(() => clearTimeout(timer));
      this.pending.add(tracked); void tracked.then(() => this.pending.delete(tracked), () => this.pending.delete(tracked));
    }
  }
  async settle() { await Promise.all([...this.pending]); }

  /** 分阶段事件按原 request_id 落盘，允许来自已结束或软删除会话。 */
  receiveDeviceEvent(event: GlassesEvent) {
    this.store.tx(() => {
      const prior = this.store.db.prepare('SELECT data FROM device_events WHERE event_id=?').get(event.event_id) as { data: string } | undefined;
      if (prior) { if (prior.data !== JSON.stringify(event)) throw new Error('device_event_id_conflict'); return; }
      const message = this.store.findRequest(event.request_id);
      const rejection = !message ? 'unknown_request' : message.source !== 'device' || message.device_id !== event.device_id ? 'device_binding_mismatch' : null;
      this.store.db.prepare('INSERT INTO device_events VALUES (?,?)').run(event.event_id, JSON.stringify(event));
      if (rejection) {
        this.store.db.prepare('INSERT INTO admin_audit(data) VALUES (?)').run(JSON.stringify({ event_type: 'device_event_rejected', reason: rejection, event, received_at: this.iso() })); return;
      }
      if (!message) return;
      const current = this.session(message.session_id);
      const m = message;
      m.device_events = [...(m.device_events ?? []), event];
      if (event.kind === 'failed') { m.status = 'failed'; m.error = event.error ?? 'device_failed'; current.state.attention.push(`${m.stage_id}:${m.error}`); }
      else if (!m.device_events.some(e => e.kind === 'failed') && (m.receipt as GlassesReceipt | null)?.status !== 'failed') { m.status = 'accepted'; m.error = null; }
      // Android wall/uptime 尚未与服务器同步，不写入跨设备 ISO 时间字段。
      this.store.intervention(m);
      this.log(current, `message_device_${event.kind}`, { request_id: m.request_id, evidence: event, received_at: this.iso(), clock_synchronization: 'unavailable' },
        { stage_id: m.stage_id, unit_id: null, condition: m.condition });
      this.store.save(current);
    });
  }
  pollDevice() {
    if (!this.adapter.pollEvents) return;
    const task = this.adapter.pollEvents(event => this.receiveDeviceEvent(event)).then(() => {
      const status = this.adapter.getStatus();
      const previous = this.store.setting('device_status');
      if (JSON.stringify(status) !== JSON.stringify(previous)) {
        this.store.tx(() => {
          this.store.setSetting('device_status', status);
          this.store.db.prepare('INSERT INTO admin_audit(data) VALUES (?)').run(JSON.stringify({ event_type: 'device_status_changed', timestamp_iso: this.iso(), status }));
        });
      }
    });
    this.pending.add(task); void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
  }
  private deliverySource(s: Session): 'mock' | 'device' {
    const created = this.store.events(s.id).find(e => e.event_type === 'session_created')?.payload.adapter as { source?: 'mock' | 'device' } | undefined;
    return s.state.delivery_source ?? (s.state.device_id ? 'device' : created?.source ?? 'mock');
  }
  presentation(id: string) {
    const s = this.session(id), messages = this.store.interventions(id);
    const expected = s.snapshot.participant.stages.filter(a => a.condition !== 'NONE').length;
    const drawn = messages.filter(m => m.source === 'device' && m.device_events?.some(e => e.kind === 'drawn')).length;
    return { delivery_source: this.deliverySource(s),
      validation_status: s.state.device_id || messages.some(m => m.source === 'device') ? 'hardware_validation_pending' : 'mock_only',
      real_presentation_verified: false, expected_messages: expected, device_drawn_messages: drawn,
      application_presentation_complete: messages.length === expected && drawn === expected && messages.every(m => m.status === 'accepted' && m.device_events?.some(e => e.kind === 'hidden')) };
  }

  command(id: string, command: Command) {
    if (!command || typeof command.command_id !== 'string' || command.command_id.length > 100 || !command.command_id || typeof command.action !== 'string') throw new HttpError(400, '操作必须包含有效command_id和action。');
    this.requireAvailable(this.session(id));
    const fingerprint = hash(command); let rejected: Error | undefined;
    this.store.tx(() => {
      const prior = this.store.command(id, command.command_id);
      if (prior) { if (prior !== fingerprint) throw new HttpError(409, '同一command_id不能用于不同操作。'); return; }
      const s = this.session(id), state = s.state;
      if (command.page_token !== state.page_token) throw new HttpError(409, '页面已变化，请刷新当前任务。');
      if (state.paused_at_ms !== null && command.action !== 'jump') throw new HttpError(409, '实验已暂停。');
      const client = command.client ?? {};
      if (JSON.stringify(client).length > 4000) throw new HttpError(400, '客户端时间信息过长。');
      if (command.action === 'jump') {
        this.jump(s, command.target, 'participant', '调试测试者主动跳题');
      } else if (command.action === 'resume' || command.action === 'blur') {
        this.log(s, command.action === 'resume' ? 'app_resumed' : 'app_blurred', { client, page_token: state.page_token });
      } else if (command.action === 'displayed') {
        if (client.visibility_state !== 'visible') throw new HttpError(422, '只有实际可见页面才能报告显示事件。');
        if (!state.displayed[state.page_token]) {
          state.displayed[state.page_token] = true;
          const eventName = { INTRO: 'intro_displayed', CARD: 'card_displayed', UNIT: 'unit_displayed', COMPREHENSION: 'comprehension_displayed', RATINGS: 'ratings_displayed', BREAK: 'break_displayed', COMPLETED: 'completion_displayed', ABORTED: 'termination_displayed' }[state.phase];
          this.log(s, eventName, { client, page_token: state.page_token });
          if (state.phase === 'UNIT' && state.unit === 1) this.schedule(s, this.log(s, 'u2_displayed', { client }), 'T1');
        }
      } else {
        if (!state.displayed[state.page_token]) throw new HttpError(409, '当前页面尚未报告实际可见。');
        if (command.action === 'reveal') {
          if (state.phase !== 'UNIT' || !this.unit(s).reveal || typeof command.open !== 'boolean') throw new HttpError(409, '当前任务没有此操作。');
          const unit = this.unit(s); const reveal = state.reveals[unit.unit_id] ?? { open: false, requested: false, displayed: false };
          reveal.open = command.open; reveal.requested ||= command.open; state.reveals[unit.unit_id] = reveal;
          this.log(s, 'reveal_clicked', { open: command.open, client });
        } else if (command.action === 'reveal_displayed') {
          if (state.phase !== 'UNIT') throw new HttpError(409, '当前不是任务页。');
          const reveal = state.reveals[this.unit(s).unit_id];
          if (!reveal?.open || !reveal.requested || client.visibility_state !== 'visible') throw new HttpError(409, '补充资料尚未展开或不可见。');
          if (!reveal.displayed) { reveal.displayed = true; this.schedule(s, this.log(s, 'reveal_displayed', { client, marker: 'E' }), 'T0'); }
        } else if (command.action === 'scratchpad') {
          if (state.phase !== 'UNIT' || !this.unit(s).scratchpad) throw new HttpError(409, '当前单元没有草稿本。');
          const options = this.unit(s).scratchpad!;
          if (typeof command.text !== 'string' || command.text.length > options.max_length) throw new HttpError(422, '草稿本格式或长度无效。');
          state.scratchpads ??= {};
          if (state.scratchpads[this.unit(s).unit_id] !== command.text) {
            state.scratchpads[this.unit(s).unit_id] = command.text;
            this.log(s, 'scratchpad_changed', { text: command.text, client, not_scored: true });
          }
        } else if (command.action === 'skip_break') {
          this.skipBreak(s, 'participant', '被试主动跳过休息');
        } else if (command.action === 'draft' || command.action === 'submit') {
          if (!['UNIT', 'COMPREHENSION', 'RATINGS'].includes(state.phase)) throw new HttpError(409, '当前页面不可提交答案。');
          const raw = command.answer;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || JSON.stringify(raw).length > 20000) throw new HttpError(422, '答案格式无效。');
          const fields = this.fields(s);
          if (Object.keys(raw).some(k => !fields.some(f => f.id === k))) throw new HttpError(422, '答案包含不属于本题的字段。');
          const key = this.draftKey(s);
          if (JSON.stringify(state.drafts[key]) !== JSON.stringify(raw)) { state.drafts[key] = raw; this.log(s, 'answer_changed', { raw_answer: raw, client }); }
          if (command.action === 'submit') {
            this.log(s, 'submit_clicked', { raw_answer: raw, client });
            try {
              const normalized = normalize(fields, raw);
              if (state.phase === 'UNIT' && this.unit(s).reveal && !state.reveals[this.unit(s).unit_id]?.displayed) throw new InputError('请按题目要求先查看补充资料，再提交答案。');
              if (state.phase === 'UNIT') {
                const unit = this.unit(s); const value = score(unit, normalized);
                this.log(s, 'submission_recorded', { raw_answer: raw, normalized_answer: normalized });
                this.log(s, 'unit_scored', { score: value });
                if (unit.unit_id === 'SH05_U1' && !this.store.events(id).some(e => e.event_type === 'F_candidate')) this.log(s, 'F_candidate', { semantics: 'first_submission', criterion_version: 'user-2026-10-18', score: value, complete: true });
                if (state.unit === 0) { this.log(s, 'unit_transition_started', { from: unit.unit_id, to: unit.unit_id.replace('U1', 'U2') }); state.unit = 1; this.transition(s, 'UNIT'); }
                else if (this.assignment(s).condition === 'NONE') this.stageEnd(s);
                else this.transition(s, 'COMPREHENSION');
              } else if (state.phase === 'COMPREHENSION') {
                this.log(s, 'comprehension_submitted', { answer: normalized.answer, correct: normalized.answer === this.stimulus(s).correct_option, message_id: this.stimulus(s).message_id });
                this.transition(s, 'RATINGS');
              } else {
                this.log(s, 'ratings_submitted', { ratings: Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, Number(v)])), message_id: this.stimulus(s).message_id }); this.stageEnd(s);
              }
            } catch (error) {
              if (!(error instanceof InputError)) throw error;
              this.log(s, 'submission_rejected', { reason: error.message }); rejected = error;
            }
          }
        } else if (command.action === 'continue') {
          if (state.phase === 'INTRO') { this.log(s, 'intro_continue'); this.transition(s, 'CARD'); }
          else if (state.phase === 'CARD') { this.log(s, 'card_continue'); state.unit = 0; this.transition(s, 'UNIT'); }
          else if (state.phase === 'BREAK') {
            if (this.elapsed(s) < state.break_until_ms!) throw new HttpError(422, '休息尚未满180秒。');
            if (!state.break_completed) { state.break_completed = true; this.log(s, 'break_completed'); }
            this.log(s, 'continue_clicked'); this.nextAfterBreak(s);
          } else throw new HttpError(409, '当前页面没有继续操作。');
        } else throw new HttpError(400, '未知操作。');
      }
      if (!rejected) this.store.acceptCommand(id, command.command_id, fingerprint);
      this.store.save(s);
    });
    this.dispatch(id);
    if (rejected) throw rejected;
    return this.view(id);
  }

  adminAction(id: string, action: string, reason: string, target?: string) {
    if (!reason.trim() || reason.length > 4000) throw new HttpError(422, '人工干预必须填写原因。');
    this.store.tx(() => {
      const s = this.session(id);
      if (action === 'restore') {
        if (!s.state.deleted) throw new HttpError(409, '此会话未删除，无需恢复。');
        const deletion = s.state.deleted; delete s.state.deleted;
        this.log(s, 'session_restored', { reason, deletion, restored_status: s.state.status }); this.store.save(s); return;
      }
      if (action === 'delete' && s.state.deleted) return;
      this.requireAvailable(s);
      if (action === 'delete') {
        if (s.state.status === 'active') throw new HttpError(409, '会话仍在进行中，请先结束会话，再删除记录。');
        s.state.deleted = { deleted_at: this.iso(), reason };
        this.log(s, 'session_deleted', { reason, recoverable: true, status: s.state.status }); this.store.save(s); return;
      }
      if (action === 'debug_jump') {
        this.jump(s, target, 'admin', reason);
        this.log(s, 'admin_intervention', { action, reason, target, is_debug: true }); this.store.save(s); return;
      }
      if (s.state.status !== 'active') throw new HttpError(409, '会话已结束。');
      const elapsed = this.elapsed(s);
      if (action === 'skip_break') this.skipBreak(s, 'admin', reason);
      else if (action === 'pause' && s.state.paused_at_ms === null) s.state.paused_at_ms = elapsed;
      else if (action === 'resume' && s.state.paused_at_ms !== null) {
        if (s.state.break_until_ms !== null) s.state.break_until_ms += elapsed - s.state.paused_at_ms;
        s.state.paused_at_ms = null;
      } else if (action === 'stop') {
        s.state.paused_at_ms = null; s.state.status = 'aborted'; s.state.ended_at = this.iso(); s.state.ended_elapsed_ms = elapsed; this.transition(s, 'ABORTED');
      } else throw new HttpError(409, '当前状态不支持该操作。');
      this.log(s, 'admin_intervention', { action, reason }); this.store.save(s);
    });
  }
  note(id: string, category: string, text: string, stageId: string | null) {
    this.requireAvailable(this.session(id));
    if (!['interview', 'observation', 'anomaly'].includes(category) || typeof text !== 'string' || text.length > 50000) throw new HttpError(422, '备注类型或长度不合法。');
    if (stageId !== null && !this.session(id).snapshot.content.stages.some(s => s.stage_id === stageId)) throw new HttpError(422, '备注任务组非法。');
    this.store.tx(() => { const s = this.session(id); this.log(s, 'note_saved', { note_id: randomUUID(), category, text, stage_id: stageId }); this.store.save(s); });
  }
  summary(id: string) {
    this.tick(id); const s = this.session(id);
    const fields = this.fields(s), draft = s.state.drafts[this.draftKey(s)] ?? {};
    const answered = fields.filter(f => Array.isArray(draft[f.id]) ? (draft[f.id] as unknown[]).length > 0 : draft[f.id] !== undefined && draft[f.id] !== null && String(draft[f.id]).trim() !== '').length;
    const lastEvent = this.store.events(id).at(-1);
    const actions: string[] = [];
    if (s.state.deleted) actions.push('restore');
    else if (s.state.status === 'active') {
      actions.push(s.state.paused_at_ms === null ? 'pause' : 'resume', 'stop');
      if (s.state.phase === 'BREAK' && s.state.paused_at_ms === null && s.snapshot.content.allow_break_skip !== false) actions.push('skip_break');
    }
    else actions.push('delete');
    if (this.isDebug(s) && !s.state.deleted) actions.push('debug_jump');
    const message = this.store.interventions(id).find(m => m.stage_id === this.assignment(s).stage_id);
    return { session_id: id, participant_id: s.snapshot.participant.participant_id, version_label: s.snapshot.participant.version_label,
      is_debug: this.isDebug(s), copied_from: s.snapshot.participant.copied_from ?? null, current_title: this.view(id).title,
      deleted: !!s.state.deleted, deleted_at: s.state.deleted?.deleted_at ?? null, deletion_reason: s.state.deleted?.reason ?? null,
      answered_fields: answered, total_fields: fields.length, reveal_observed: s.state.phase === 'UNIT' ? s.state.reveals[this.unit(s).unit_id]?.displayed ?? false : null,
      available_actions: actions, last_event_type: lastEvent?.event_type ?? null, last_event_at: lastEvent?.timestamp_iso ?? null, message_status: message?.status ?? (this.assignment(s).condition === 'NONE' ? 'NONE' : 'not_triggered'),
      phase: s.state.phase, stage_id: s.snapshot.content.stages[s.state.stage].stage_id, unit: s.state.unit + 1, status: s.state.status, paused: s.state.paused_at_ms !== null,
      started_at: s.state.started_at, ended_at: s.state.ended_at, elapsed_ms: s.state.ended_elapsed_ms ?? this.elapsed(s), remaining_ms: s.state.phase === 'BREAK' ? Math.max(0, s.state.break_until_ms! - (s.state.paused_at_ms ?? this.elapsed(s))) : null,
      content_version: s.snapshot.content.content_version, config_hash: s.snapshot.config_hash, attention: s.state.attention,
      device_id: s.state.device_id ?? null, adapter: this.adapter.getStatus(),
      message_evidence: message?.device_events?.some(e => e.kind === 'failed') ? 'failed' : message?.device_events?.some(e => e.kind === 'hidden') ? 'hidden' : message?.device_events?.some(e => e.kind === 'drawn') ? 'drawn' : null,
      ...this.presentation(id) };
  }
}
