// 浏览器验收脚本：见 qa/browser/README.md。环境变量 A5_BASE、A5_RUNTIME_DIR、A5_QA_OUT、A5_PLAYWRIGHT。
import { mkdirSync as __mkdir } from 'node:fs';
const __out = process.env.A5_QA_OUT ?? '/tmp/a5-qa'; __mkdir(__out, { recursive: true });
const { chromium } = await import(process.env.A5_PLAYWRIGHT ?? 'playwright');
import { readFileSync, writeFileSync } from 'node:fs';
const base=(process.env.A5_BASE ?? 'http://127.0.0.1:5174'); const b=await chromium.launch({channel:'chrome'}); const p=await b.newPage({viewport:{width:1440,height:900}});
const bad=[]; p.on('response',r=>{ if(r.status()===404) bad.push(r.url()); }); p.on('pageerror',e=>bad.push('pageerror '+e));
await p.goto(`${base}/admin`); await p.waitForSelector('#participant option[value="001"]',{state:'attached'});
await p.click('#nav-setup');
await p.setInputFiles('#config',decodeURIComponent(new URL('../../config/participants.pilot.json', import.meta.url).pathname));
await p.click('#import button[type=submit]'); await p.waitForSelector('#notice:not([hidden])'); console.log('valid:', await p.textContent('#notice-text'));
writeFileSync(__out + '/bad.json','{"participants":[]}');
await p.setInputFiles('#config',__out + '/bad.json'); await p.click('#import button[type=submit]'); await p.waitForSelector('#error:not([hidden])'); console.log('invalid:', (await p.textContent('#error-text')).slice(0,120));
console.log('404s/errors:', bad); await b.close();
