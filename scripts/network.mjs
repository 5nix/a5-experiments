import { networkInterfaces } from 'node:os';

/** 列出当前可供局域网连接的 IPv4 地址；热点与虚拟网卡名称不作平台假设。 */
export function lanAddresses(port, interfaces = networkInterfaces()) {
  const seen = new Set();
  return Object.entries(interfaces).flatMap(([name, entries]) => (entries ?? [])
    .filter(item => item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.') && !seen.has(item.address) && seen.add(item.address))
    .map(item => ({ name, address: item.address, base_url: `http://${item.address}:${port}` })))
    .sort((a, b) => Number(/utun|tun|tap|vpn|docker|vEthernet/i.test(a.name)) - Number(/utun|tun|tap|vpn|docker|vEthernet/i.test(b.name)) || a.name.localeCompare(b.name));
}
