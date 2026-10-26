import { readJson } from '../src/preflight.ts';
import type { ParticipantConfig } from '../src/contracts.ts';

/** 测试夹具：从默认28人预分配取V1—V4各一人，改编号为001—004，沿用旧用例的编号习惯。 */
export async function testConfig(): Promise<ParticipantConfig> {
  const pilot = await readJson<ParticipantConfig>('config/participants.pilot.json');
  const participants = ['V1', 'V2', 'V3', 'V4'].map((version, index) => {
    const source = pilot.participants.find(p => p.version_label === version)!;
    return { ...structuredClone(source), participant_id: `00${index + 1}`, version_label: version };
  });
  return { experiment_id: pilot.experiment_id, schema_version: pilot.schema_version, participants };
}
