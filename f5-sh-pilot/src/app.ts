import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Engine, HttpError } from './engine.ts';
import { exportData } from './export.ts';
import { InputError } from './tasks.ts';
import { experimentRoot, preflight } from './preflight.ts';

export async function body(request: IncomingMessage): Promise<any> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请使用application/json请求。');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 1024 * 1024) throw new HttpError(413, '请求超过1MB。'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new HttpError(400, 'JSON格式无效。'); }
}
const bearer = (request: IncomingMessage) => request.headers.authorization?.replace(/^Bearer /, '') ?? '';
export function createApp(engine: Engine, adminKey: string, exportRoot: string) {
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
  };
  const admin = (request: IncomingMessage) => {
    const a = Buffer.from(bearer(request)), b = Buffer.from(adminKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, '实验员凭据无效，请使用启动终端提供的后台链接。');
  };
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1'); const path = url.pathname; const method = request.method;
      if (method === 'GET' && ['/', '/admin', '/experiment', '/app.css', '/desktop.css', '/admin.js', '/experiment.js', '/favicon.svg', '/favicon-admin.svg', '/favicon.ico'].includes(path)) {
        const files: Record<string, string> = { '/': 'admin.html', '/admin': 'admin.html', '/experiment': 'experiment.html', '/app.css': 'app.css', '/desktop.css': 'desktop.css', '/admin.js': 'admin.js', '/experiment.js': 'experiment.js', '/favicon.svg': 'favicon.svg', '/favicon-admin.svg': 'favicon-admin.svg', '/favicon.ico': 'favicon.svg' };
        const name = files[path]; const mime = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/css';
        response.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); response.end(await readFile(join(experimentRoot, 'public', name))); return;
      }
      if (method === 'GET' && path === '/api/health') { json(response, { ok: true, repository: 'a5-experiments', experiment_id: 'f5-sh-pilot', phase: 'core', mock_only: engine.adapter.getStatus().source === 'mock', real_presentation_verified: false, adapter: engine.adapter.getStatus() }); return; }
      if (path.startsWith('/api/admin/') || path === '/api/preflight') {
        admin(request);
        if (method === 'GET' && ['/api/preflight', '/api/admin/preflight'].includes(path)) { json(response, { ...await preflight(), adapter: engine.adapter.getStatus() }); return; }
        if (method === 'GET' && path === '/api/admin/device') { json(response, { adapter: engine.adapter.getStatus(), audit: engine.store.deviceAudit() }); return; }
        if (method === 'GET' && path === '/api/admin/config') { json(response, { config: engine.config(), debug_participant: engine.debugParticipant(), adapter: engine.adapter.getStatus(), interview_prompts: engine.material.content.interview_prompts }); return; }
        if (method === 'POST' && path === '/api/admin/config') { json(response, { config: engine.importConfig(await body(request)) }); return; }
        if (method === 'GET' && path === '/api/admin/sessions') { json(response, { adapter: engine.adapter.getStatus(), sessions: engine.store.ids().map(id => engine.summary(id)), deleted_sessions: engine.store.deletedIds().map(id => engine.summary(id)) }); return; }
        if (method === 'POST' && path === '/api/admin/sessions') {
          const input = await body(request); if (typeof input.participant_id !== 'string') throw new HttpError(422, '请选择被试。');
          const created = engine.create(input.participant_id, { user_agent: request.headers['user-agent'] ?? null });
          json(response, { ...created, participant_url: `/experiment#session=${created.session_id}&token=${created.token}` }, 201); return;
        }
        const sessionPath = /^\/api\/admin\/sessions\/([a-f0-9-]+)(?:\/(events|notes|control|access))?$/.exec(path);
        if (sessionPath) {
          const [, id, resource] = sessionPath;
          if (method === 'GET' && !resource) { json(response, { summary: engine.summary(id), view: engine.view(id), assignment: engine.session(id).snapshot.participant, interventions: engine.store.interventions(id) }); return; }
          if (method === 'GET' && resource === 'events') { json(response, { events: engine.store.events(id) }); return; }
          if (method === 'GET' && resource === 'notes') { json(response, { notes: engine.store.events(id).filter(e => e.event_type === 'note_saved') }); return; }
          if (method === 'POST' && resource === 'notes') { const input = await body(request); engine.note(id, input.category, input.text, input.stage_id ?? null); json(response, { saved: true }); return; }
          if (method === 'POST' && resource === 'control') {
            const input = await body(request); if (typeof input.reason !== 'string') throw new HttpError(422, '请填写干预原因。');
            engine.adminAction(id, input.action, input.reason, input.target); json(response, engine.summary(id)); return;
          }
          if (method === 'POST' && resource === 'access') { engine.session(id); const token = engine.rotateToken(id); json(response, { participant_url: `/experiment#session=${id}&token=${token}` }); return; }
        }
        if (method === 'GET' && path === '/api/admin/export') {
          const id = url.searchParams.get('session_id'); const ids = id ? [engine.session(id).id] : engine.store.ids();
          if (!ids.length) throw new HttpError(422, '当前没有可导出的会话。');
          const result = await exportData(engine, ids, exportRoot);
          response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="a5-${result.export_id}.zip"` }); response.end(result.bytes); return;
        }
      }
      const participantPath = /^\/api\/participant\/sessions\/([a-f0-9-]+)(?:\/(commands|assets\/image\d+\.png))?$/.exec(path);
      if (participantPath) {
        const [, id, resource] = participantPath; engine.authenticate(id, bearer(request));
        if (method === 'GET' && !resource) { json(response, engine.view(id)); return; }
        if (method === 'POST' && resource === 'commands') { json(response, engine.command(id, await body(request))); return; }
        if (method === 'GET' && resource?.startsWith('assets/')) {
          const name = resource.slice(7), view = engine.view(id);
          if (![...view.assets, ...(view.reveal?.assets ?? [])].some(a => a.id === name)) throw new HttpError(403, '此资料不属于当前可见任务。');
          const asset = engine.session(id).snapshot.assets[name]; response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(Buffer.from(asset.base64, 'base64')); return;
        }
      }
      json(response, { error: '接口或请求方法不存在。' }, 404);
    } catch (error) {
      const expected = error instanceof HttpError || error instanceof InputError;
      if (!expected) console.error('服务错误：', error);
      if (!response.headersSent) json(response, { error: expected ? error.message : '本地服务发生错误，请联系实验员查看终端。', request_id: randomUUID() }, expected ? error.status : 500);
      else response.end();
    }
  });
}
