import { describe, expect, it } from 'vitest';

import { MirrorSecurityError } from './errors.js';
import { canonicalizeResourceUrl, mapUrlToLocalPath, resolvePathInsideRoot } from './url-mapper.js';

describe('mapUrlToLocalPath', () => {
  it('maps same-origin and external resources to deterministic isolated paths', () => {
    const first = mapUrlToLocalPath('https://example.com/assets/app.js?v=1#section', {
      sourceOrigin: 'https://example.com',
      contentType: 'application/javascript',
    });
    const second = mapUrlToLocalPath('https://example.com/assets/app.js?v=1', {
      sourceOrigin: 'https://example.com',
      contentType: 'application/javascript',
    });
    const external = mapUrlToLocalPath('https://cdn.example.net/fonts/site.woff2', {
      sourceOrigin: 'https://example.com',
      contentType: 'font/woff2',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^site\/assets\/app~q-[a-f0-9]{12}\.js$/u);
    expect(external).toBe('site/_external/https/cdn.example.net/fonts/site.woff2');
  });

  it('escapes encoded separators and Windows reserved names', () => {
    const encodedTraversal = mapUrlToLocalPath('https://example.com/assets/%2e%2e%2fprivate.txt', {
      sourceOrigin: 'https://example.com',
    });
    const reservedName = mapUrlToLocalPath('https://example.com/con', {
      sourceOrigin: 'https://example.com',
      contentType: 'text/html',
    });

    expect(encodedTraversal).toBe('site/assets/~2e~2e~2fprivate.txt');
    expect(encodedTraversal).not.toContain('../');
    expect(reservedName).toBe('site/~r-con.html');
  });

  it.each([
    'file:///C:/Windows/win.ini',
    'data:text/plain,secret',
    'javascript:alert(1)',
    'blob:https://example.com/id',
  ])('rejects dangerous protocol URL %s', (value) => {
    expect(() => mapUrlToLocalPath(value)).toThrowError(MirrorSecurityError);
  });

  it('rejects embedded URL credentials and removes fragments from canonical URLs', () => {
    expect(() => canonicalizeResourceUrl('https://user:secret@example.com/file')).toThrow(
      'credentials',
    );
    expect(canonicalizeResourceUrl('https://example.com/file#fragment')).toBe(
      'https://example.com/file',
    );
  });

  it('does not derive local file names from sensitive query values', () => {
    const first = mapUrlToLocalPath('https://example.com/app.js?token=first&rev=7', {
      sourceOrigin: 'https://example.com',
    });
    const second = mapUrlToLocalPath('https://example.com/app.js?token=second&rev=7', {
      sourceOrigin: 'https://example.com',
    });
    const changedRevision = mapUrlToLocalPath('https://example.com/app.js?token=second&rev=8', {
      sourceOrigin: 'https://example.com',
    });

    expect(first).toBe(second);
    expect(changedRevision).not.toBe(first);
  });
});

describe('resolvePathInsideRoot', () => {
  it('allows safe relative paths and rejects traversal and Windows alternate streams', () => {
    const root = 'C:\\mirror-root';

    expect(resolvePathInsideRoot(root, 'site/assets/app.js')).toBe(
      'C:\\mirror-root\\site\\assets\\app.js',
    );
    expect(() => resolvePathInsideRoot(root, 'site/../secret.txt')).toThrow('unsafe segments');
    expect(() => resolvePathInsideRoot(root, 'site\\..\\secret.txt')).toThrow(
      'relative POSIX path',
    );
    expect(() => resolvePathInsideRoot(root, 'site/file.txt:secret')).toThrow('unsafe segments');
  });
});
