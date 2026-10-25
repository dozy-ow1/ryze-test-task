import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export interface NetworkOptions {
  allowPrivateNetwork?: boolean;
  allowedHosts?: readonly string[];
}

// These ranges reach local services, metadata endpoints or non-public networks. They must never
// be reachable through a customer-supplied URL. Explicit test/mock hosts are the only exceptions.
const nonPublic = new BlockList();
nonPublic.addSubnet('0.0.0.0', 8, 'ipv4'); // Unspecified and current network.
nonPublic.addSubnet('10.0.0.0', 8, 'ipv4'); // Private networks.
nonPublic.addSubnet('172.16.0.0', 12, 'ipv4');
nonPublic.addSubnet('192.168.0.0', 16, 'ipv4');
nonPublic.addSubnet('100.64.0.0', 10, 'ipv4'); // Carrier-grade NAT.
nonPublic.addSubnet('127.0.0.0', 8, 'ipv4'); // Loopback.
nonPublic.addSubnet('169.254.0.0', 16, 'ipv4'); // Link-local, including cloud metadata.
nonPublic.addSubnet('192.0.0.0', 24, 'ipv4'); // Protocol assignments.
nonPublic.addSubnet('198.18.0.0', 15, 'ipv4'); // Benchmark networks.
nonPublic.addSubnet('224.0.0.0', 4, 'ipv4'); // Multicast.
nonPublic.addSubnet('240.0.0.0', 4, 'ipv4'); // Reserved.
nonPublic.addSubnet('2001:db8::', 32, 'ipv6'); // Documentation.
nonPublic.addSubnet('2001::', 32, 'ipv6'); // Teredo tunnels.
nonPublic.addSubnet('2002::', 16, 'ipv6'); // 6to4 tunnels.

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    return !nonPublic.check(address, 'ipv4');
  }

  // IPv6 global unicast is 2000::/3. This also excludes local and IPv4-mapped addresses.
  return family === 6 && /^[23]/i.test(address) && !nonPublic.check(address, 'ipv6');
}

export function validateHttpUrl(value: string): URL {
  const url = new URL(value);

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('URL must use HTTP(S) without credentials');
  }

  return url;
}

export function createNetworkPolicy(options: NetworkOptions) {
  const trusted = (hostname: string) =>
    options.allowPrivateNetwork || options.allowedHosts?.includes(hostname);

  const checkAddress = (hostname: string, address: string) => {
    if (!trusted(hostname) && !isPublicAddress(address)) {
      throw new Error('private network address is not allowed');
    }
  };

  // Validate the same DNS answers used to connect, preventing a separate preflight lookup from
  // being bypassed by DNS rebinding. Reject mixed public/private answers rather than choosing one.
  const safeLookup: LookupFunction = (hostname, settings, callback) => {
    lookup(hostname, { ...settings, all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);

        return;
      }

      try {
        for (const { address } of addresses) {
          checkAddress(hostname, address);
        }
      } catch (error) {
        callback(error as Error, []);

        return;
      }

      if (settings.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  };

  return {
    lookup: safeLookup,

    checkUrl(url: URL) {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');

      // Node does not call lookup for IP literals, so check those before dispatching.
      if (isIP(hostname)) {
        checkAddress(hostname, hostname);
      }
    },
  };
}
