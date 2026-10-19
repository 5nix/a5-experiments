import type { NetworkInterfaceInfo } from 'node:os';
export interface LanAddress { name: string; address: string; base_url: string }
export function lanAddresses(port: number, interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>): LanAddress[];
