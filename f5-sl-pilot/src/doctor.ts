import { resolve } from 'node:path';
process.env.A5_EXPERIMENT_ROOT ??= resolve(import.meta.dirname, '..');
await import('@a5/desktop/doctor.ts');
