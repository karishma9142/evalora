import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProviderError } from './types.js';

// Users choose the base URL our server calls. On a public server that could be abused to reach
// private services (cloud metadata, databases, other containers). In production we block private
// and internal addresses. Self-hosters with local models (Ollama) can allow them with
// ALLOW_PRIVATE_URLS=true. Default: allowed in development, blocked when NODE_ENV=production.
function allowPrivate(): boolean {
  const fallback = process.env.NODE_ENV === 'production' ? 'false' : 'true';
  return (process.env.ALLOW_PRIVATE_URLS ?? fallback).toLowerCase() === 'true';
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, includes cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    a >= 224 // multicast and reserved
  );
}

export function isBlockedAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  if (ip === '::' || ip === '::1') return true;
  const mappedDotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4 inside IPv6
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]);
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip); // unique-local fc00::/7 and link-local fe80::/10
}

export async function assertAllowedUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError('The provider URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('The provider URL must start with http:// or https://');
  }
  if (allowPrivate()) return;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string }[];
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new ProviderError(`Could not resolve the host "${host}"`);
    }
  }
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    throw new ProviderError(
      'Blocked: this URL points to a private or internal address. Self-hosted instances can allow it with ALLOW_PRIVATE_URLS=true.',
    );
  }
}