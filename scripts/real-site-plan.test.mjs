import { describe, expect, it } from 'vitest';

import {
  evaluateLoopbackEvidence,
  isExpectedUnavailableLoopbackUrl,
  isRecoverableExternalIntegrationConsoleError,
  isNonBlockingLoopbackRequestCancellation,
  isRecoverableMediaPlaybackInterruption,
  isRecoverableReplayError,
  isRecoverableHydrationError,
  normalizeRegressionPlan,
} from './real-site-plan.mjs';

describe('real-site regression plans', () => {
  it('normalizes selector and coordinate browser-input actions', () => {
    const plan = normalizeRegressionPlan({
      schemaVersion: 1,
      viewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
      },
      sourceSettleMs: 1_000,
      loopbackSettleMs: 2_000,
      actionSettleMs: 250,
      actions: [
        {
          id: 'open-menu',
          type: 'click',
          selector: '[data-nav-ham]',
          expectSelector: '[data-nav-m]',
        },
        {
          id: 'begin',
          type: 'click',
          point: { x: 640, y: 620 },
          holdMs: 2_000,
          settleMs: 2_000,
        },
        {
          id: 'drag-scene',
          type: 'drag',
          from: { x: 180, y: 360 },
          to: { x: 1_020, y: 360 },
          steps: 16,
        },
        {
          id: 'walk-forward',
          type: 'key',
          key: 'd',
          holdMs: 2_500,
          expectScrollYAtLeast: 900,
        },
      ],
    });

    expect(plan).toMatchObject({
      sourceSettleMs: 1_000,
      loopbackSettleMs: 2_000,
      actionSettleMs: 250,
      actions: [
        {
          id: 'open-menu',
          type: 'click',
          selector: '[data-nav-ham]',
          expectSelector: '[data-nav-m]',
        },
        {
          id: 'begin',
          type: 'click',
          point: { x: 640, y: 620 },
          holdMs: 2_000,
          settleMs: 2_000,
        },
        {
          id: 'drag-scene',
          type: 'drag',
          from: { x: 180, y: 360 },
          to: { x: 1_020, y: 360 },
          steps: 16,
        },
        {
          id: 'walk-forward',
          type: 'key',
          key: 'd',
          holdMs: 2_500,
          expectScrollYAtLeast: 900,
        },
      ],
    });
  });

  it('rejects ambiguous click targets and unsupported plan fields', () => {
    expect(() =>
      normalizeRegressionPlan({
        schemaVersion: 1,
        actions: [
          {
            id: 'ambiguous',
            type: 'click',
            selector: '#start',
            point: { x: 10, y: 10 },
          },
        ],
      }),
    ).toThrow('requires exactly one of selector or point');

    expect(() =>
      normalizeRegressionPlan({
        schemaVersion: 1,
        unsupported: true,
      }),
    ).toThrow('supported fields only');

    expect(() =>
      normalizeRegressionPlan({
        schemaVersion: 1,
        actions: [
          {
            id: 'invalid-key-hold',
            type: 'key',
            key: 'd',
            holdMs: 0,
          },
        ],
      }),
    ).toThrow('actions[0].holdMs');

    expect(() =>
      normalizeRegressionPlan({
        schemaVersion: 1,
        actions: [
          {
            id: 'invalid-mouse-hold',
            type: 'click',
            point: { x: 10, y: 10 },
            holdMs: 1_000,
            clickCount: 2,
          },
        ],
      }),
    ).toThrow('held clicks cannot use clickCount above 1');
  });

  it('only treats the browser cancellation code as non-blocking', () => {
    expect(isNonBlockingLoopbackRequestCancellation('net::ERR_ABORTED')).toBe(true);
    expect(isNonBlockingLoopbackRequestCancellation(' net::ERR_ABORTED ')).toBe(true);
    expect(isNonBlockingLoopbackRequestCancellation('net::ERR_FAILED')).toBe(false);
    expect(isNonBlockingLoopbackRequestCancellation('net::ERR_ABORTED_DETAILS')).toBe(false);
  });

  it('only ignores the reserved dynamic-script failure route', () => {
    expect(
      isExpectedUnavailableLoopbackUrl('http://127.0.0.1:61234/.webmirror/unavailable.js'),
    ).toBe(true);
    expect(
      isExpectedUnavailableLoopbackUrl('http://localhost:61234/.webmirror/unavailable.js'),
    ).toBe(true);
    expect(isExpectedUnavailableLoopbackUrl('http://127.0.0.1:61234/missing.js')).toBe(false);
    expect(isExpectedUnavailableLoopbackUrl('https://example.test/.webmirror/unavailable.js')).toBe(
      false,
    );
  });

  it('only classifies known React hydration recovery messages as recoverable', () => {
    expect(
      isRecoverableHydrationError(
        'Error: Minified React error #418; visit the decoder for more information',
      ),
    ).toBe(true);
    expect(
      isRecoverableHydrationError(
        'There was an error while hydrating. The entire root will switch to client rendering.',
      ),
    ).toBe(true);
    expect(isRecoverableHydrationError('TypeError: sceneLoader is not a function')).toBe(false);
    expect(isRecoverableHydrationError('Failed to load resource: 404')).toBe(false);
  });

  it('classifies only browser media playback cancellation messages as recoverable', () => {
    expect(
      isRecoverableMediaPlaybackInterruption(
        'The play() request was interrupted by a call to pause(). https://goo.gl/LdLk22',
      ),
    ).toBe(true);
    expect(
      isRecoverableMediaPlaybackInterruption(
        'The play() request was interrupted by a new load request. https://goo.gl/LdLk22',
      ),
    ).toBe(true);
    expect(
      isRecoverableMediaPlaybackInterruption(
        'The play() request was interrupted because the media was removed from the document.',
      ),
    ).toBe(true);
    expect(isRecoverableMediaPlaybackInterruption('NotAllowedError: play() failed')).toBe(false);
    expect(isRecoverableReplayError('TypeError: sceneLoader is not a function')).toBe(false);
  });

  it('classifies only handled, namespaced integration initialization failures as recoverable', () => {
    expect(
      isRecoverableExternalIntegrationConsoleError(
        '[EXTERNAL WIDGET] Error: Unable to initialize tracker',
      ),
    ).toBe(true);
    expect(
      isRecoverableExternalIntegrationConsoleError(
        '[EXTERNAL WIDGET] Error tracker initialization: Object',
      ),
    ).toBe(true);
    expect(
      isRecoverableExternalIntegrationConsoleError(
        '[EXTERNAL WIDGET] TypeError: Cannot read properties of undefined',
      ),
    ).toBe(false);
    expect(isRecoverableExternalIntegrationConsoleError('Unable to initialize tracker')).toBe(
      false,
    );
  });

  it('downgrades a recoverable replay error only when all other replay evidence passes', () => {
    const completeEvidence = {
      consoleErrors: [],
      pageErrors: ['The play() request was interrupted by a call to pause().'],
      localHttpFailures: [],
      localRequestFailures: [],
      remoteRequests: [],
      screenshotErrors: [],
      checkpoints: [{}, {}, {}],
    };

    expect(evaluateLoopbackEvidence(completeEvidence, 2)).toMatchObject({
      blockingConsoleErrors: [],
      blockingPageErrors: [],
      recoverableMediaPlaybackInterruptions: 1,
      recoverableReplayErrors: 1,
      passed: true,
    });

    expect(
      evaluateLoopbackEvidence(
        {
          ...completeEvidence,
          remoteRequests: ['https://example.test/runtime.json'],
        },
        2,
      ),
    ).toMatchObject({
      blockingPageErrors: completeEvidence.pageErrors,
      recoverableReplayErrors: 0,
      passed: false,
    });
  });

  it('downgrades handled external integration errors only after all replay evidence passes', () => {
    const message = '[EXTERNAL WIDGET] Error: Unable to initialize tracker';
    const completeEvidence = {
      consoleErrors: [message],
      pageErrors: [],
      localHttpFailures: [],
      localRequestFailures: [],
      remoteRequests: [],
      screenshotErrors: [],
      checkpoints: [{}],
    };

    expect(evaluateLoopbackEvidence(completeEvidence, 0)).toMatchObject({
      blockingConsoleErrors: [],
      recoverableExternalIntegrationErrors: 1,
      recoverableReplayErrors: 1,
      passed: true,
    });
    expect(
      evaluateLoopbackEvidence(
        {
          ...completeEvidence,
          localHttpFailures: [{ status: 404, url: 'http://127.0.0.1:6000/app.js' }],
        },
        0,
      ),
    ).toMatchObject({
      blockingConsoleErrors: [message],
      recoverableExternalIntegrationErrors: 0,
      passed: false,
    });
  });

  it('rejects invalid scroll evidence thresholds', () => {
    expect(() =>
      normalizeRegressionPlan({
        schemaVersion: 1,
        actions: [
          {
            id: 'invalid-scroll-evidence',
            type: 'scroll',
            deltaY: 1_000,
            expectScrollYAtLeast: 100_001,
          },
        ],
      }),
    ).toThrow('expectScrollYAtLeast');
  });
});
