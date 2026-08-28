import { describe, expect, it } from 'vitest';

import {
  compressedTextureFamilyForExtension,
  isRuntimeCapabilities,
  runtimeCapabilitiesFromProbe,
} from './runtime-capabilities.js';

describe('runtime capability profiles', () => {
  it('normalizes bounded WebGL compressed-texture extension families', () => {
    expect(
      runtimeCapabilitiesFromProbe({
        webgl: {
          extensions: [
            'WEBGL_compressed_texture_astc',
            'WEBGL_compressed_texture_s3tc',
            'WEBKIT_WEBGL_compressed_texture_s3tc',
            'EXT_texture_compression_bptc',
            'unrelated_extension',
          ],
        },
        webgl2: {
          extensions: ['WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1'],
        },
      }),
    ).toEqual({
      webgl: {
        compressedTextureFamilies: ['astc', 'bptc', 's3tc'],
      },
      webgl2: {
        compressedTextureFamilies: ['etc', 'etc1'],
      },
    });
  });

  it('recognizes aliases and rejects malformed persisted profiles', () => {
    expect(compressedTextureFamilyForExtension('MOZ_WEBGL_compressed_texture_s3tc')).toBe('s3tc');
    expect(compressedTextureFamilyForExtension('WEBGL_compressed_texture_es3_0')).toBe('etc');
    expect(
      isRuntimeCapabilities({
        webgl: { compressedTextureFamilies: ['s3tc'] },
        webgl2: { compressedTextureFamilies: [] },
      }),
    ).toBe(true);
    expect(
      isRuntimeCapabilities({
        webgl: { compressedTextureFamilies: ['s3tc', 's3tc'] },
        webgl2: { compressedTextureFamilies: [] },
      }),
    ).toBe(false);
    expect(
      isRuntimeCapabilities({
        webgl: { compressedTextureFamilies: ['unknown'] },
        webgl2: { compressedTextureFamilies: [] },
      }),
    ).toBe(false);
  });
});
