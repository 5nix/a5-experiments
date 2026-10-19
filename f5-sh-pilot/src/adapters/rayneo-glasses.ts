import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection, type Socket } from 'node:net';
import type { GlassesAdapter, GlassesEvent, GlassesReceipt, GlassesRequest, GlassesStatus } from '../contracts.ts';

const execute = promisify(execFile);
export const rayneoProtocol = 'a5-rayneo/1';
export type AdbRunner = (file: string, args: string[]) => Promise<string>;
const runAdb: AdbRunner = async (file, args) => (await execute(file, args, { timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout;
class DeviceRejection extends Error {
  readonly evidence: unknown;
  constructor(message: string, evidence: unknown) { super(message); this.evidence = evidence; }
}
interface Reply {
  request_id?: string; text_sha256?: string; ledger_id?: string;
  ready?: boolean; busy?: boolean; device_info?: Record<string, string>;
  events?: { seq: number; event: GlassesEvent }[];
}

/** ADB 只建立 USB 隧道；刺激走持久套接字，不经过 shell 或启动子进程。 */
export class RayNeoGlassesAdapter implements GlassesAdapter {
  private readonly serial: string;
  private readonly adb: string;
  private readonly run: AdbRunner;
  private state: GlassesStatus;
  private socket?: Socket;
  private port?: number;
  private connecting?: Promise<void>;
  private readonly waiting = new Map<number, { resolve: (value: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private cursor = 0;
  private ledger?: string;
  private closed = false;
  private polling = false;
  constructor(serial: string, options: { adb?: string; run?: AdbRunner } = {}) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(serial)) throw new Error('必须配置明确且有效的 A5_RAYNEO_SERIAL。');
    this.serial = serial; this.adb = options.adb ?? 'adb'; this.run = options.run ?? runAdb;
    this.state = { source: 'device', connected: false, ready: false, device_id: `adb:${serial}`, error: 'device_not_probed', protocol: rayneoProtocol,
      independent_duration: true, persistent_deduplication: true, display_evidence: 'android_dual_eye_onDraw; optical_validation_pending' };
  }
  getStatus() { return { ...this.state }; }
  async reconnect() {
    if (this.state.busy || this.waiting.size) throw new Error('设备忙碌，暂不能重建连接。');
    this.disconnect(new Error('device_manual_reconnect'));
    await this.probe();
  }
  private disconnect(error: Error) {
    this.state = { ...this.state, connected: false, ready: false, busy: false, error: error.message };
    this.socket?.destroy(); this.socket = undefined;
    for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.waiting.clear();
  }
  private async connect() {
    if (this.closed) throw new Error('device_transport_closed');
    if (this.socket) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (this.port) await this.run(this.adb, ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`]).catch(() => {});
      const port = Number((await this.run(this.adb, ['-s', this.serial, 'forward', 'tcp:0', 'localabstract:a5-rayneo-v1'])).trim());
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('device_invalid_forward_port');
      this.port = port;
      if (this.closed) throw new Error('device_transport_closed');
      const socket = createConnection({ host: '127.0.0.1', port });
      this.socket = socket; socket.setNoDelay(true); socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1024 * 1024) { this.disconnect(new Error('device_reply_too_large')); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.protocol !== rayneoProtocol || !Number.isSafeInteger(value.id)) throw new Error('device_protocol_mismatch');
            const pending = this.waiting.get(value.id);
            if (!pending) continue; // 迟到应答不重新发送；独立事件仍可回收证据。
            this.waiting.delete(value.id); clearTimeout(pending.timer);
            if (value.ok !== true) pending.reject(new DeviceRejection(typeof value.error === 'string' ? value.error : 'device_bridge_rejected', value));
            else pending.resolve(value);
          } catch (error) { this.disconnect(error instanceof Error ? error : new Error('device_invalid_reply')); return; }
        }
      });
      socket.on('error', error => { if (this.socket === socket) this.disconnect(error); });
      socket.on('close', () => { if (this.socket === socket) this.disconnect(new Error('device_disconnected')); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('device_connect_timeout')); }, 3000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
        socket.once('close', () => { clearTimeout(timer); reject(new Error('device_disconnected')); });
      });
    })();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private call(command: string, payload: unknown): Promise<Reply> {
    if (this.closed || !this.socket || this.socket.destroyed) return Promise.reject(new Error('device_disconnected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('device_reply_timeout_delivery_unknown')); }, 3000);
      this.waiting.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify({ protocol: rayneoProtocol, id, command, payload }) + '\n', 'utf8', error => {
        if (error) this.disconnect(error);
      });
    });
  }
  async probe() {
    try {
      await this.connect();
      const value = await this.call('status', {});
      if (typeof value.ready !== 'boolean' || typeof value.busy !== 'boolean' || typeof value.ledger_id !== 'string') throw new Error('device_invalid_status');
      if (value.ledger_id !== this.ledger) { this.ledger = value.ledger_id; this.cursor = 0; }
      this.state = { ...this.state, connected: true, ready: value.ready, busy: value.busy, device_info: value.device_info, error: null };
    } catch (error) { this.disconnect(error instanceof Error ? error : new Error(String(error))); }
  }
  async send(request: GlassesRequest): Promise<GlassesReceipt> {
    const t_send = new Date().toISOString();
    if (request.device_id !== this.state.device_id) throw new Error('device_binding_mismatch');
    if (Buffer.byteLength(request.text, 'utf8') > 16000 || !request.text.trim() || request.duration_ms !== 8500) throw new Error('device_invalid_stimulus');
    let evidence: unknown;
    try {
      // 不重连后补发；断线恢复仅用于状态和历史事件。
      const value = await this.call('show', request); evidence = value;
      if (value.request_id !== request.request_id) throw new Error('device_request_id_mismatch');
      if (value.text_sha256 !== createHash('sha256').update(request.text, 'utf8').digest('hex')) throw new Error('device_text_integrity_mismatch');
      return { request_id: request.request_id, device_id: request.device_id, source: 'device', status: 'accepted', t_send,
        t_ack: new Date().toISOString(), t_display: null, t_hide: null, display_time_source: 'unavailable', error: null, evidence: value };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { request_id: request.request_id, device_id: request.device_id, source: 'device', status: error instanceof DeviceRejection || reason === 'device_text_integrity_mismatch' ? 'failed' : 'unacknowledged', t_send,
        t_ack: null, t_display: null, t_hide: null, display_time_source: 'unavailable', error: reason, evidence: error instanceof DeviceRejection ? error.evidence : evidence };
    }
  }
  async pollEvents(receive: (event: GlassesEvent) => void) {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      await this.probe();
      if (!this.state.connected) return;
      const value = await this.call('events', { after: this.cursor });
      if (value.ledger_id !== this.ledger || !Array.isArray(value.events)) throw new Error('device_invalid_event_batch');
      for (const item of value.events) {
        if (!Number.isSafeInteger(item.seq) || item.seq <= this.cursor) throw new Error('device_invalid_event_cursor');
        const event = item.event as GlassesEvent;
        if (!event || typeof event.event_id !== 'string' || typeof event.request_id !== 'string' || event.device_id !== this.state.device_id ||
          !['accepted', 'drawn', 'hidden', 'failed'].includes(event.kind) || !Number.isFinite(event.device_wall_ms) || !Number.isFinite(event.device_monotonic_ms) ||
          typeof event.clock_id !== 'string' || !(event.error === null || typeof event.error === 'string')) throw new Error('device_invalid_event');
        receive(event); // 持久化成功才前移游标；重复批次由 Store 去重。
        this.cursor = item.seq;
      }
    } catch (error) { this.disconnect(error instanceof Error ? error : new Error(String(error))); }
    finally { this.polling = false; }
  }
  async close() {
    this.closed = true; this.disconnect(new Error('device_transport_closed'));
    await this.connecting?.catch(() => {});
    if (this.port) await this.run(this.adb, ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`]).catch(() => {});
  }
}
