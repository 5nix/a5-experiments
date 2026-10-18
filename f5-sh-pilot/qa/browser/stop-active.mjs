// 浏览器验收脚本：见 qa/browser/README.md。环境变量 A5_BASE、A5_RUNTIME_DIR、A5_QA_OUT、A5_PLAYWRIGHT。
import { mkdirSync as __mkdir } from 'node:fs';
const __out = process.env.A5_QA_OUT ?? '/tmp/a5-qa'; __mkdir(__out, { recursive: true });
import { readFileSync } from 'node:fs';
const key = readFileSync(`${process.env.A5_RUNTIME_DIR ?? '/tmp/a5-frontend-runtime'}/admin-key`, 'utf8').trim();
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const s = await (await fetch((process.env.A5_BASE ?? 'http://127.0.0.1:5174') + '/api/admin/sessions', { headers: H })).json();
for (const x of s.sessions) if (x.available_actions?.includes('stop')) await fetch(`${process.env.A5_BASE ?? 'http://127.0.0.1:5174'}/api/admin/sessions/${x.session_id}/control`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'stop', reason: '前端验收清理' }) });
