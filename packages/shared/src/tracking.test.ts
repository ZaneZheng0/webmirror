import { describe, expect, it } from 'vitest';

import {
  isKnownNonessentialEmbedUrl,
  isKnownNonessentialExternalUrl,
  isKnownNonessentialTelemetryUrl,
  isKnownTrackingUrl,
} from './tracking.js';

describe('isKnownTrackingUrl', () => {
  it('recognizes known analytics hosts and their subdomains', () => {
    expect(isKnownTrackingUrl('https://www.google-analytics.com/analytics.js')).toBe(true);
    expect(isKnownTrackingUrl('//www.googletagmanager.com/gtag/js', 'https://example.com/')).toBe(
      true,
    );
    expect(isKnownTrackingUrl('https://stats.g.doubleclick.net/j/collect')).toBe(true);
  });

  it('does not block unrelated application resources', () => {
    expect(isKnownTrackingUrl('https://example.com/analytics.js')).toBe(false);
    expect(isKnownTrackingUrl('/assets/app.js', 'https://example.com/')).toBe(false);
    expect(isKnownTrackingUrl('not a URL')).toBe(false);
  });

  it('recognizes legacy social embed runtimes without treating ordinary Google resources as embeds', () => {
    expect(isKnownNonessentialEmbedUrl('http://connect.facebook.net/en_US/sdk.js')).toBe(true);
    expect(isKnownNonessentialEmbedUrl('https://platform.twitter.com/widgets.js')).toBe(true);
    expect(isKnownNonessentialEmbedUrl('https://apis.google.com/js/platform.js')).toBe(true);
    expect(
      isKnownNonessentialEmbedUrl(
        'https://apis.google.com/_/scs/abc-static/_/js/k=platform/m=plusone/rt=j',
      ),
    ).toBe(true);
    expect(isKnownNonessentialEmbedUrl('https://developers.google.com/')).toBe(true);
    expect(
      isKnownNonessentialEmbedUrl(
        'https://accounts.google.com/o/oauth2/postmessageRelay?parent=https%3A%2F%2Fexample.com',
      ),
    ).toBe(true);
    expect(isKnownNonessentialEmbedUrl('https://maps.googleapis.com/maps/api/js')).toBe(false);
    expect(isKnownNonessentialEmbedUrl('https://example.com/assets/app.js')).toBe(false);
  });

  it('recognizes browser translation components without blocking ordinary Google assets', () => {
    expect(
      isKnownNonessentialExternalUrl(
        'https://translate.googleapis.com/_/translate_http/_/js/k=translate_http.tr.en_US.js',
      ),
    ).toBe(true);
    expect(
      isKnownNonessentialExternalUrl(
        'https://www.gstatic.com/_/translate_http/_/ss/k=translate_http.tr.Y.css',
      ),
    ).toBe(true);
    expect(
      isKnownNonessentialExternalUrl(
        'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit',
      ),
    ).toBe(true);
    expect(
      isKnownNonessentialExternalUrl(
        'https://www.google.com/gen204?client=te_lib&logld=vTE_20260318',
      ),
    ).toBe(true);
    expect(
      isKnownNonessentialExternalUrl(
        'https://www.gstatic.com/draco/v1/decoders/draco_decoder.wasm',
      ),
    ).toBe(false);
    expect(
      isKnownNonessentialExternalUrl('https://maps.googleapis.com/maps/api/js?key=public'),
    ).toBe(false);
  });

  it('recognizes known nonessential telemetry endpoints without matching ordinary well-known files', () => {
    expect(isKnownNonessentialTelemetryUrl('https://www.example.com/.well-known/dux?v2')).toBe(
      true,
    );
    expect(isKnownNonessentialExternalUrl('https://www.example.com/.well-known/dux?v2')).toBe(true);
    expect(
      isKnownNonessentialTelemetryUrl('https://www.example.com/.well-known/assetlinks.json'),
    ).toBe(false);
    expect(isKnownNonessentialTelemetryUrl('https://consent.trustarc.com/analytics?action=0')).toBe(
      true,
    );
    expect(isKnownNonessentialTelemetryUrl('https://connect.facebook.net/en_US/fbevents.js')).toBe(
      true,
    );
    expect(isKnownNonessentialTelemetryUrl('https://sc-static.net/scevent.min.js')).toBe(true);
    expect(isKnownNonessentialTelemetryUrl('http://img.en25.com/i/elqCfg.min.js')).toBe(true);
    expect(
      isKnownNonessentialTelemetryUrl(
        'https://www.google.com/g/collect?v=2&tid=G-TEST&en=page_view',
      ),
    ).toBe(true);
    expect(isKnownNonessentialTelemetryUrl('https://tr.snapchat.com/cm/i?pid=public-test-id')).toBe(
      true,
    );
    expect(isKnownNonessentialTelemetryUrl('https://www.facebook.com/tr/?id=123')).toBe(true);
    expect(
      isKnownNonessentialTelemetryUrl('https://tr.snapchat.com/config/global/public-test-id.js'),
    ).toBe(false);
    expect(isKnownNonessentialTelemetryUrl('https://example.com/g/collect')).toBe(false);
    expect(isKnownNonessentialTelemetryUrl('https://consent.trustarc.com/asset/notice.js')).toBe(
      false,
    );
    expect(isKnownNonessentialTelemetryUrl('https://www.example.com/analytics')).toBe(false);
    expect(
      isKnownNonessentialTelemetryUrl(
        'https://shop.example.com/web-pixels@abc/app/example/pixel.modern.js',
      ),
    ).toBe(true);
    expect(
      isKnownNonessentialTelemetryUrl('https://shop.example.com/cdn/wpm/sandbox-runtime.js'),
    ).toBe(true);
    expect(isKnownNonessentialTelemetryUrl('https://shop.example.com/cdn/app.js')).toBe(false);
  });

  it('combines tracking and legacy social embeds for offline capture filtering', () => {
    expect(isKnownNonessentialExternalUrl('https://www.google-analytics.com/analytics.js')).toBe(
      true,
    );
    expect(isKnownNonessentialExternalUrl('https://platform.twitter.com/widgets.js')).toBe(true);
    expect(isKnownNonessentialExternalUrl('https://cdn.example.net/app.js')).toBe(false);
  });
});
