import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from './config.ts';
import type { ParticipantConfig, Stimulus } from './contracts.ts';
import { HttpError } from './engine.ts';

/** 文件名只能来自本目录；导入采用新文件，不覆盖现有配置。 */
export class ConfigFiles {
  readonly directory: string;
  private stimuli: Stimulus[];
  constructor(directory: string, stimuli: Stimulus[]) { this.directory = directory; this.stimuli = stimuli; }
  validate(value: unknown): ParticipantConfig {
    const errors = validateConfig(value, this.stimuli);
    if (errors.length) throw new HttpError(422, errors.join('\n'));
    return value as ParticipantConfig;
  }
  async read(name: unknown) {
    if (typeof name !== 'string' || basename(name) !== name || /[\\/:\x00]/.test(name) || !name.endsWith('.json')) throw new HttpError(422, '配置文件名无效。');
    try { return this.validate(JSON.parse(await readFile(join(this.directory, name), 'utf8'))); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(422, '配置文件不存在或JSON无效。'); }
  }
  async list() {
    await mkdir(this.directory, { recursive: true });
    const files = [];
    for (const entry of (await readdir(this.directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try { const cfg = await this.read(entry.name); files.push({ filename: entry.name, label: cfg.config_name ?? entry.name, participant_count: cfg.participants.length, valid: true, error: null }); }
      catch (error) { files.push({ filename: entry.name, label: entry.name, participant_count: 0, valid: false, error: (error as Error).message }); }
    }
    return files;
  }
  async save(value: unknown, originalName: unknown) {
    const config = this.validate(value);
    const stem = typeof originalName === 'string' ? originalName.replace(/\.json$/i, '').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 60) : 'imported';
    const filename = `import-${stem || 'config'}-${randomUUID().slice(0, 8)}.json`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, filename), JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { config, filename };
  }
}
