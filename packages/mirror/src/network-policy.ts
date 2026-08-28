import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { MirrorSecurityError } from './errors.js';
import { parseResourceUrl } from './url-mapper.js';

export interface ResolvedDownloadTarget {
  url: URL;
  address: string;
  family: 4 | 6;
  lookup: LookupFunction;
}

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, 'ipv6');
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  );
}

export function isPublicAddress(address: string, family: 4 | 6): boolean {
  return family === 4
    ? !blockedIpv4Addresses.check(address, 'ipv4')
    : !blockedIpv6Addresses.check(address, 'ipv6');
}

export async function resolveDownloadTarget(
  value: string,
  allowPrivateNetwork = false,
): Promise<ResolvedDownloadTarget> {
  const url = parseResourceUrl(value);
  const hostname = normalizedHostname(url);

  if (!allowPrivateNetwork && isLocalHostname(hostname)) {
    throw new MirrorSecurityError(
      'PRIVATE_NETWORK',
      `Private hostname is not allowed: ${hostname}`,
    );
  }

  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily === 4 || literalFamily === 6
      ? [{ address: hostname, family: literalFamily }]
      : await lookup(hostname, { all: true, verbatim: true });

  const supported = addresses.filter(
    (entry): entry is { address: string; family: 4 | 6 } =>
      entry.family === 4 || entry.family === 6,
  );

  if (supported.length === 0) {
    throw new Error(`No IPv4 or IPv6 address was found for ${hostname}`);
  }

  if (
    !allowPrivateNetwork &&
    supported.some((entry) => !isPublicAddress(entry.address, entry.family))
  ) {
    throw new MirrorSecurityError(
      'PRIVATE_NETWORK',
      `Resource host resolves to a non-public address: ${hostname}`,
    );
  }

  const selected = supported[0];

  if (!selected) {
    throw new Error(`No usable address was found for ${hostname}`);
  }

  const pinnedLookup: LookupFunction = (_requestedHostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: selected.address, family: selected.family }]);
      return;
    }

    callback(null, selected.address, selected.family);
  };

  return {
    url,
    address: selected.address,
    family: selected.family,
    lookup: pinnedLookup,
  };
}
