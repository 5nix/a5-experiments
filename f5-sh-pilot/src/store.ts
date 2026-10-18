import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Snapshot } from './tasks.ts';

export type Phase = 'INTRO' | 'CARD' | 'UNIT' | 'COMPREHENSION' | 'RATINGS' | 'BREAK' | 'COMPLETED' | 'ABORTED';
export interface State {
  phase: Phase; stage: number; unit: number; page_token: string;
  displayed: Record<string, boolean>; drafts: Record<string, Record<string, unknown>>;
  scratchpads?: Record<string, string>;
  reveals: Record<string, { open: boolean; requested: boolean; displayed: boolean }>;
  started_at: string; ended_at: string | null; ended_elapsed_ms: number | null; last_elapsed_ms: number;
  break_until_ms: number | null; break_completed: boolean;
  paused_at_ms: number | null; attention: string[]; status: 'active' | 'completed' | 'aborted';
}
export interface Session { id: string; token_hash: string; state: State; snapshot: Snapshot }
export interface EventRecord {
  event_id: string; session_id: string; participant_id: string; stage_id: string | null; unit_id: string | null;
  condition: string | null; event_type: string; timestamp_iso: string; elapsed_ms: number;
  payload: Record<string, unknown>; content_version: string;
  is_debug?: boolean;
}
export interface Intervention {
  session_id: string; stage_id: string; participant_id: string; message_id: string; condition: string;
  request_id: string; status: string; source: 'mock' | 'device'; duration_ms: number;
  t_event: string; event_elapsed_ms: number; t_send: string | null; t_ack: string | null; t_display: string | null; t_hide: string | null;
  display_time_source: string; receipt: unknown; error: string | null;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, state TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id,seq);
      CREATE TABLE IF NOT EXISTS commands(session_id TEXT NOT NULL REFERENCES sessions(id), command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(session_id,command_id));
      CREATE TABLE IF NOT EXISTS interventions(session_id TEXT NOT NULL REFERENCES sessions(id), stage_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,stage_id));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;`);
  }
  tx<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  create(session: Session) {
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(session.id, session.token_hash, JSON.stringify(session.state), JSON.stringify(session.snapshot));
    this.snapshots.set(session.id, session.snapshot);
  }
  get(id: string): Session | undefined {
    const row = this.db.prepare('SELECT id,token_hash,state FROM sessions WHERE id=?').get(id) as { id: string; token_hash: string; state: string } | undefined;
    if (!row) return;
    let snapshot = this.snapshots.get(id);
    if (!snapshot) { const stored = this.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(id) as { snapshot: string }; snapshot = JSON.parse(stored.snapshot) as Snapshot; this.snapshots.set(id, snapshot); }
    return { id: row.id, token_hash: row.token_hash, state: JSON.parse(row.state), snapshot };
  }
  ids() { return (this.db.prepare('SELECT id FROM sessions ORDER BY rowid').all() as { id: string }[]).map(r => r.id); }
  save(session: Session) { this.db.prepare('UPDATE sessions SET state=? WHERE id=?').run(JSON.stringify(session.state), session.id); }
  event(event: EventRecord) { this.db.prepare('INSERT INTO events(event_id,session_id,data) VALUES (?,?,?)').run(event.event_id, event.session_id, JSON.stringify(event)); }
  events(id: string): EventRecord[] { return (this.db.prepare('SELECT data FROM events WHERE session_id=? ORDER BY seq').all(id) as { data: string }[]).map(r => JSON.parse(r.data)); }
  command(id: string, commandId: string) { return (this.db.prepare('SELECT fingerprint FROM commands WHERE session_id=? AND command_id=?').get(id, commandId) as { fingerprint: string } | undefined)?.fingerprint; }
  acceptCommand(id: string, commandId: string, fingerprint: string) { this.db.prepare('INSERT INTO commands VALUES (?,?,?)').run(id, commandId, fingerprint); }
  interventions(id: string): Intervention[] { return (this.db.prepare('SELECT data FROM interventions WHERE session_id=? ORDER BY stage_id').all(id) as { data: string }[]).map(r => JSON.parse(r.data)); }
  intervention(value: Intervention) { this.db.prepare('INSERT INTO interventions VALUES (?,?,?) ON CONFLICT(session_id,stage_id) DO UPDATE SET data=excluded.data').run(value.session_id, value.stage_id, JSON.stringify(value)); }
  setting<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) : undefined; }
  setSetting(key: string, value: unknown) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  close() { this.db.close(); }
}
