import { describe, expect, it } from 'vitest';

import { isPublicAddress } from './network-policy.js';

describe('isPublicAddress', () => {
  it('accepts public IPv4 and IPv6 addresses', () => {
    expect(isPublicAddress('8.8.8.8', 4)).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111', 6)).toBe(true);
  });

  it('rejects private, loopback, documentation, and IPv4-mapped addresses', () => {
    expect(isPublicAddress('10.0.0.1', 4)).toBe(false);
    expect(isPublicAddress('127.0.0.1', 4)).toBe(false);
    expect(isPublicAddress('192.0.2.1', 4)).toBe(false);
    expect(isPublicAddress('::1', 6)).toBe(false);
    expect(isPublicAddress('fc00::1', 6)).toBe(false);
    expect(isPublicAddress('::ffff:8.8.8.8', 6)).toBe(false);
  });
});
