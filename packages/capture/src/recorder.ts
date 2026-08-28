import { sanitizeHeaders } from './headers.js';
import type {
  CapturePrivacyEvidence,
  CapturedResource,
  CapturedResponseBodyDescriptor,
  LoadingFailedEvent,
  LoadingFinishedEvent,
  RequestWillBeSentEvent,
  RequestWillBeSentExtraInfoEvent,
  ResponsePayload,
  ResponseReceivedEvent,
  ResponseReceivedExtraInfoEvent,
} from './types.js';

function sessionKey(sessionId: string | undefined): string {
  return sessionId ?? 'root';
}

function requestKey(sessionId: string | undefined, requestId: string): string {
  return `${sessionKey(sessionId)}:${requestId}`;
}

function resourceId(
  sessionId: string | undefined,
  requestId: string,
  redirectIndex: number,
): string {
  return `${requestKey(sessionId, requestId)}:${redirectIndex}`;
}

function responseDetails(response: ResponsePayload, fallbackUrl: string) {
  return {
    url: response.url ?? fallbackUrl,
    status: response.status ?? 0,
    statusText: response.statusText ?? '',
    mimeType: response.mimeType ?? 'application/octet-stream',
    protocol: response.protocol ?? '',
    headers: sanitizeHeaders(response.headers),
    hasSetCookie:
      response.headers !== undefined &&
      Object.keys(response.headers).some((name) => name.toLowerCase() === 'set-cookie'),
    fromDiskCache: response.fromDiskCache ?? false,
    fromPrefetchCache: response.fromPrefetchCache ?? false,
    fromServiceWorker: response.fromServiceWorker ?? false,
  };
}

function headerValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === target,
  );
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function hasHeader(headers: Record<string, unknown> | undefined, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers ?? {}).some((headerName) => headerName.toLowerCase() === target);
}

function hasPrivateCacheDirective(value: string | undefined): boolean {
  return (
    value
      ?.toLowerCase()
      .split(/[,\r\n]+/u)
      .some((directive) => {
        const directiveName = directive.trim().split('=', 1)[0];
        return directiveName === 'private' || directiveName === 'no-store';
      }) ?? false
  );
}

function variesByCredential(value: string | undefined): boolean {
  return (
    value
      ?.toLowerCase()
      .split(/[,\r\n]+/u)
      .some((header) => {
        const normalized = header.trim();
        return normalized === '*' || normalized === 'cookie' || normalized === 'authorization';
      }) ?? false
  );
}

function associatedCookieWasSent(
  cookies: RequestWillBeSentExtraInfoEvent['associatedCookies'],
): boolean {
  return (
    cookies?.some(
      (cookie) => cookie.blockedReasons === undefined || cookie.blockedReasons.length === 0,
    ) ?? false
  );
}

function createPrivacyEvidence(): CapturePrivacyEvidence {
  return {
    requestExtraInfoReceived: false,
    responseExtraInfoReceived: false,
    requestHasCookie: false,
    requestHasAuthorization: false,
    responseHasSetCookie: false,
    responsePrivateOrNoStore: false,
    responseVariesByCredential: false,
    responseCookiePolicyAffected: false,
    ambiguousRedirect: false,
  };
}

interface RequestExtraInfoEvidence {
  requestHasCookie: boolean;
  requestHasAuthorization: boolean;
  ambiguous: boolean;
}

interface ResponseExtraInfoEvidence {
  responseHasSetCookie: boolean;
  responsePrivateOrNoStore: boolean;
  responseVariesByCredential: boolean;
  responseCookiePolicyAffected: boolean;
  responseStatusCode?: number;
  ambiguous: boolean;
}

function requestExtraInfoEvidence(
  event: RequestWillBeSentExtraInfoEvent,
): RequestExtraInfoEvidence {
  return {
    requestHasCookie:
      hasHeader(event.headers, 'cookie') || associatedCookieWasSent(event.associatedCookies),
    requestHasAuthorization: hasHeader(event.headers, 'authorization'),
    ambiguous: false,
  };
}

function responseExtraInfoEvidence(
  event: ResponseReceivedExtraInfoEvent,
): ResponseExtraInfoEvidence {
  return {
    responseHasSetCookie: hasHeader(event.headers, 'set-cookie'),
    responsePrivateOrNoStore: hasPrivateCacheDirective(headerValue(event.headers, 'cache-control')),
    responseVariesByCredential: variesByCredential(headerValue(event.headers, 'vary')),
    responseCookiePolicyAffected:
      (event.blockedCookies?.length ?? 0) > 0 || (event.exemptedCookies?.length ?? 0) > 0,
    ...(typeof event.statusCode === 'number' ? { responseStatusCode: event.statusCode } : {}),
    ambiguous: false,
  };
}

export class CaptureRecorder {
  readonly #resources = new Map<string, CapturedResource>();
  readonly #currentRedirectIndex = new Map<string, number>();
  readonly #pendingRequestExtraInfo = new Map<string, RequestExtraInfoEvidence>();
  readonly #pendingResponseExtraInfo = new Map<string, ResponseExtraInfoEvidence>();

  get size(): number {
    return this.#resources.size;
  }

  requestWillBeSent(sessionId: string | undefined, event: RequestWillBeSentEvent): void {
    const key = requestKey(sessionId, event.requestId);
    let redirectIndex = this.#currentRedirectIndex.get(key) ?? 0;

    if (event.redirectResponse) {
      const previousId = resourceId(sessionId, event.requestId, redirectIndex);
      const previous = this.#resources.get(previousId);

      if (previous) {
        previous.response = responseDetails(event.redirectResponse, previous.request.url);
        previous.state = 'complete';
      }

      redirectIndex += 1;
    }

    this.#currentRedirectIndex.set(key, redirectIndex);

    const resource: CapturedResource = {
      id: resourceId(sessionId, event.requestId, redirectIndex),
      ...(sessionId ? { sessionId } : {}),
      requestId: event.requestId,
      redirectIndex,
      state: 'discovered',
      request: {
        url: event.request.url,
        method: event.request.method,
        headers: sanitizeHeaders(event.request.headers),
        ...(event.type ? { resourceType: event.type } : {}),
        ...(event.frameId ? { frameId: event.frameId } : {}),
        ...(event.loaderId ? { loaderId: event.loaderId } : {}),
        ...(event.initiator?.type ? { initiatorType: event.initiator.type } : {}),
      },
    };

    this.#resources.set(resource.id, resource);
    const pendingRequestExtraInfo = this.#pendingRequestExtraInfo.get(key);

    if (pendingRequestExtraInfo) {
      this.#pendingRequestExtraInfo.delete(key);
      this.#applyRequestExtraInfo(resource, pendingRequestExtraInfo);
    }

    const pendingResponseExtraInfo = this.#pendingResponseExtraInfo.get(key);

    if (pendingResponseExtraInfo) {
      this.#pendingResponseExtraInfo.delete(key);
      this.#applyResponseExtraInfo(resource, pendingResponseExtraInfo);
    }

    if (redirectIndex > 0) {
      this.#ensurePrivacy(resource).ambiguousRedirect = true;
    }
  }

  responseReceived(sessionId: string | undefined, event: ResponseReceivedEvent): void {
    const resource = this.#currentResource(sessionId, event.requestId);

    if (!resource) {
      return;
    }

    resource.response = responseDetails(event.response, resource.request.url);
    resource.state = 'response';
    const privacy = this.#ensurePrivacy(resource);
    privacy.responseHasSetCookie ||= resource.response.hasSetCookie;
    privacy.responsePrivateOrNoStore ||= hasPrivateCacheDirective(
      headerValue(event.response.headers, 'cache-control'),
    );
    privacy.responseVariesByCredential ||= variesByCredential(
      headerValue(event.response.headers, 'vary'),
    );

    if (!resource.request.resourceType && event.type) {
      resource.request.resourceType = event.type;
    }
  }

  loadingFinished(sessionId: string | undefined, event: LoadingFinishedEvent): void {
    const resource = this.#currentResource(sessionId, event.requestId);

    if (!resource) {
      return;
    }

    resource.state = 'complete';

    if (typeof event.encodedDataLength === 'number') {
      resource.encodedDataLength = event.encodedDataLength;
    }
  }

  loadingFailed(sessionId: string | undefined, event: LoadingFailedEvent): void {
    const resource = this.#currentResource(sessionId, event.requestId);

    if (!resource) {
      return;
    }

    resource.state = 'failed';
    resource.failureReason = event.errorText ?? 'Network request failed';

    if (event.blockedReason) {
      resource.blockedReason = event.blockedReason;
    }

    if (typeof event.canceled === 'boolean') {
      resource.canceled = event.canceled;
    }
  }

  requestWillBeSentExtraInfo(
    sessionId: string | undefined,
    event: RequestWillBeSentExtraInfoEvent,
  ): void {
    const key = requestKey(sessionId, event.requestId);
    const resource = this.#currentResource(sessionId, event.requestId);
    const evidence = requestExtraInfoEvidence(event);

    if (resource) {
      this.#applyRequestExtraInfo(resource, evidence);
      return;
    }

    const previous = this.#pendingRequestExtraInfo.get(key);
    this.#pendingRequestExtraInfo.set(
      key,
      previous
        ? {
            requestHasCookie: previous.requestHasCookie || evidence.requestHasCookie,
            requestHasAuthorization:
              previous.requestHasAuthorization || evidence.requestHasAuthorization,
            ambiguous: true,
          }
        : evidence,
    );
  }

  responseReceivedExtraInfo(
    sessionId: string | undefined,
    event: ResponseReceivedExtraInfoEvent,
  ): void {
    const key = requestKey(sessionId, event.requestId);
    const resource = this.#currentResource(sessionId, event.requestId);
    const evidence = responseExtraInfoEvidence(event);

    if (resource) {
      this.#applyResponseExtraInfo(resource, evidence);
      return;
    }

    const previous = this.#pendingResponseExtraInfo.get(key);
    this.#pendingResponseExtraInfo.set(
      key,
      previous
        ? {
            responseHasSetCookie: previous.responseHasSetCookie || evidence.responseHasSetCookie,
            responsePrivateOrNoStore:
              previous.responsePrivateOrNoStore || evidence.responsePrivateOrNoStore,
            responseVariesByCredential:
              previous.responseVariesByCredential || evidence.responseVariesByCredential,
            responseCookiePolicyAffected:
              previous.responseCookiePolicyAffected || evidence.responseCookiePolicyAffected,
            ...(previous.responseStatusCode !== undefined
              ? { responseStatusCode: previous.responseStatusCode }
              : evidence.responseStatusCode !== undefined
                ? { responseStatusCode: evidence.responseStatusCode }
                : {}),
            ambiguous: true,
          }
        : evidence,
    );
  }

  snapshot(): CapturedResource[] {
    return [...this.#resources.values()]
      .map((resource) => structuredClone(resource))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  currentResource(sessionId: string | undefined, requestId: string): CapturedResource | undefined {
    const resource = this.#currentResource(sessionId, requestId);
    return resource ? structuredClone(resource) : undefined;
  }

  attachResponseBody(
    sessionId: string | undefined,
    requestId: string,
    body: CapturedResponseBodyDescriptor,
  ): boolean {
    const resource = this.#currentResource(sessionId, requestId);

    if (!resource) {
      return false;
    }

    resource.body = structuredClone(body);
    return true;
  }

  attachResponseBodyByResourceId(
    resourceId: string,
    body: CapturedResponseBodyDescriptor,
  ): boolean {
    const resource = this.#resources.get(resourceId);

    if (!resource) {
      return false;
    }

    resource.body = structuredClone(body);
    return true;
  }

  #currentResource(sessionId: string | undefined, requestId: string): CapturedResource | undefined {
    const key = requestKey(sessionId, requestId);
    const redirectIndex = this.#currentRedirectIndex.get(key);

    if (redirectIndex === undefined) {
      return undefined;
    }

    return this.#resources.get(resourceId(sessionId, requestId, redirectIndex));
  }

  #ensurePrivacy(resource: CapturedResource): CapturePrivacyEvidence {
    resource.privacy ??= createPrivacyEvidence();
    return resource.privacy;
  }

  #applyRequestExtraInfo(resource: CapturedResource, evidence: RequestExtraInfoEvidence): void {
    const privacy = this.#ensurePrivacy(resource);

    if (privacy.requestExtraInfoReceived) {
      privacy.ambiguousRedirect = true;
    }

    privacy.requestExtraInfoReceived = true;
    privacy.requestHasCookie ||= evidence.requestHasCookie;
    privacy.requestHasAuthorization ||= evidence.requestHasAuthorization;
    privacy.ambiguousRedirect ||= evidence.ambiguous;
  }

  #applyResponseExtraInfo(resource: CapturedResource, evidence: ResponseExtraInfoEvidence): void {
    const privacy = this.#ensurePrivacy(resource);

    if (privacy.responseExtraInfoReceived) {
      privacy.ambiguousRedirect = true;
    }

    privacy.responseExtraInfoReceived = true;
    privacy.responseHasSetCookie ||= evidence.responseHasSetCookie;
    privacy.responsePrivateOrNoStore ||= evidence.responsePrivateOrNoStore;
    privacy.responseVariesByCredential ||= evidence.responseVariesByCredential;
    privacy.responseCookiePolicyAffected ||= evidence.responseCookiePolicyAffected;
    privacy.ambiguousRedirect ||= evidence.ambiguous;
    if (
      privacy.responseStatusCode !== undefined &&
      evidence.responseStatusCode !== undefined &&
      privacy.responseStatusCode !== evidence.responseStatusCode
    ) {
      privacy.ambiguousRedirect = true;
    } else if (evidence.responseStatusCode !== undefined) {
      privacy.responseStatusCode = evidence.responseStatusCode;
    }
  }
}
