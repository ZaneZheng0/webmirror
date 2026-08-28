export const knownTrackingDomainSuffixes = [
  'doubleclick.net',
  'google-analytics.com',
  'googletagmanager.com',
] as const;

export const knownNonessentialTelemetryPathnames = ['/.well-known/dux'] as const;

export const knownNonessentialTelemetryPathPrefixes = ['/cdn/wpm/', '/web-pixels'] as const;

export const knownNonessentialTelemetryRoutes = [
  ['connect.facebook.net', '/en_us/fbevents.js'],
  ['consent.trustarc.com', '/analytics'],
  ['img.en25.com', '/i/elqcfg.min.js'],
  ['sc-static.net', '/scevent.min.js'],
  ['tr.snapchat.com', '/cm/i'],
  ['www.google.com', '/g/collect'],
  ['www.facebook.com', '/tr'],
  ['www.facebook.com', '/tr/'],
] as const;

const legacySocialEmbedHostnames = new Set([
  'connect.facebook.net',
  'platform.twitter.com',
  'platform.x.com',
  'syndication.twitter.com',
  'syndication.x.com',
  'static.xx.fbcdn.net',
  'staticxx.facebook.com',
]);

function parseHttpUrl(value: string, baseUrl?: string): URL | undefined {
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);

    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export function isKnownTrackingUrl(value: string, baseUrl?: string): boolean {
  const url = parseHttpUrl(value, baseUrl);

  if (!url) {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  return knownTrackingDomainSuffixes.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

export function isKnownNonessentialTelemetryUrl(value: string, baseUrl?: string): boolean {
  const url = parseHttpUrl(value, baseUrl);

  if (!url) {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const pathname = url.pathname.toLowerCase();

  return (
    knownNonessentialTelemetryPathnames.includes(
      pathname as (typeof knownNonessentialTelemetryPathnames)[number],
    ) ||
    knownNonessentialTelemetryPathPrefixes.some((prefix) => pathname.startsWith(prefix)) ||
    knownNonessentialTelemetryRoutes.some(
      ([routeHostname, routePathname]) => hostname === routeHostname && pathname === routePathname,
    )
  );
}

export function isKnownNonessentialEmbedUrl(value: string, baseUrl?: string): boolean {
  const url = parseHttpUrl(value, baseUrl);

  if (!url) {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const pathname = url.pathname.toLowerCase();

  if (legacySocialEmbedHostnames.has(hostname)) {
    return true;
  }

  if (
    (hostname === 'www.facebook.com' || hostname === 'm.facebook.com') &&
    (pathname.startsWith('/plugins/') ||
      pathname.startsWith('/v2.0/plugins/') ||
      pathname.startsWith('/data/manifest/'))
  ) {
    return true;
  }

  if (hostname === 'apis.google.com') {
    return true;
  }

  if (hostname === 'developers.google.com') {
    return true;
  }

  if (hostname === 'accounts.google.com' && pathname.startsWith('/o/oauth2/postmessagerelay')) {
    return true;
  }

  return (
    hostname === 'ssl.gstatic.com' &&
    pathname.startsWith('/accounts/o/') &&
    pathname.endsWith('postmessagerelay.js')
  );
}

function isKnownBrowserTranslationUrl(value: string, baseUrl?: string): boolean {
  const url = parseHttpUrl(value, baseUrl);

  if (!url) {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const pathname = url.pathname.toLowerCase();

  if (
    (hostname === 'translate.googleapis.com' || hostname === 'translate.google.com') &&
    (pathname.startsWith('/_/translate_http/') ||
      pathname.startsWith('/translate_a/element') ||
      pathname.startsWith('/translate_static/'))
  ) {
    return true;
  }

  if (hostname === 'www.gstatic.com' && pathname.startsWith('/_/translate_http/')) {
    return true;
  }

  return (
    (hostname === 'www.google.com' ||
      hostname === 'translate.google.com' ||
      hostname === 'translate.googleapis.com') &&
    pathname === '/gen204' &&
    (url.searchParams.get('client') ?? '').toLowerCase() === 'te_lib'
  );
}

export function isKnownNonessentialExternalUrl(value: string, baseUrl?: string): boolean {
  return (
    isKnownTrackingUrl(value, baseUrl) ||
    isKnownNonessentialTelemetryUrl(value, baseUrl) ||
    isKnownNonessentialEmbedUrl(value, baseUrl) ||
    isKnownBrowserTranslationUrl(value, baseUrl)
  );
}
