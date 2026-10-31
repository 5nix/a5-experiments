import { setTimeout } from 'node:timers/promises';
import type { GlassesAdapter, GlassesReceipt, GlassesRequest } from '../contracts.ts';

/** 仅供开发联调。不向桌面显示刺激，不将发送成功当作实际显示。 */
export class MockGlassesAdapter implements GlassesAdapter {
  private readonly options: { connected?: boolean; delay_ms?: number; acknowledge?: boolean };
  private readonly requests = new Map<string, { fingerprint: string; receipt: Promise<GlassesReceipt> }>();

  constructor(options: { connected?: boolean; delay_ms?: number; acknowledge?: boolean } = {}) {
    this.options = options;
  }

  getStatus() {
    return { source: 'mock' as const, connected: this.options.connected !== false };
  }
  async confirm() { /* 仅接受模拟确认，不产生真机绘制或提示音证据。 */ }
  async cancel() { /* Mock 没有实际设备画面。 */ }

  send(request: GlassesRequest): Promise<GlassesReceipt> {
    const fingerprint = JSON.stringify(request);
    const prior = this.requests.get(request.request_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return Promise.reject(new Error('同一 request_id 不能绑定不同消息。'));
      return prior.receipt;
    }
    const receipt = this.simulate(request);
    this.requests.set(request.request_id, { fingerprint, receipt });
    return receipt;
  }

  private async simulate(request: GlassesRequest): Promise<GlassesReceipt> {
    const t_send = new Date().toISOString();
    if (this.options.delay_ms) await setTimeout(this.options.delay_ms);
    const connected = this.getStatus().connected;
    const acknowledged = connected && this.options.acknowledge !== false;
    return {
      request_id: request.request_id,
      source: 'mock',
      status: !connected ? 'failed' : acknowledged ? 'accepted' : 'unacknowledged',
      t_send,
      t_ack: acknowledged ? new Date().toISOString() : null,
      t_display: null,
      t_hide: null,
      display_time_source: 'unavailable',
      error: !connected ? 'mock_disconnected' : acknowledged ? null : 'mock_no_ack',
    };
  }
}
