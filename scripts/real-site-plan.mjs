import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';

import { chromium } from '@playwright/test';

const defaultViewport = Object.freeze({
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
});
const defaultPlan = Object.freeze({
  schemaVersion: 1,
  viewport: defaultViewport,
  sourceSettleMs: 5_000,
  loopbackSettleMs: 15_000,
  actionSettleMs: 1_000,
  actions: Object.freeze([]),
});
const maxPlanBytes = 256 * 1024;
const maxActions = 32;
const maxActionIdLength = 64;
const maxActionLabelLength = 160;
const maxSelectorLength = 2_048;
const maxKeyLength = 64;
const maxActionSettleMs = 30_000;
const maxCoordinate = 100_000;
const maxScrollDelta = 100_000;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function boundedString(value, maximumLength, name, pattern) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes('\0') ||
    (pattern && !pattern.test(value))
  ) {
    throw new TypeError(`${name} is invalid`);
  }

  return value;
}

function optionalBoundedString(value, maximumLength, name) {
  return value === undefined ? undefined : boundedString(value, maximumLength, name);
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }

  return Number(value);
}

function optionalBoundedInteger(value, minimum, maximum, name) {
  return value === undefined ? undefined : boundedInteger(value, minimum, maximum, name);
}

function boundedNumber(value, minimum, maximum, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a finite number from ${minimum} to ${maximum}`);
  }

  return value;
}

function optionalBoundedNumber(value, minimum, maximum, name) {
  return value === undefined ? undefined : boundedNumber(value, minimum, maximum, name);
}

function normalizePoint(value, name) {
  if (!isRecord(value) || !hasOnlyKeys(value, ['x', 'y'])) {
    throw new TypeError(`${name} must contain only x and y coordinates`);
  }

  return {
    x: boundedNumber(value.x, 0, maxCoordinate, `${name}.x`),
    y: boundedNumber(value.y, 0, maxCoordinate, `${name}.y`),
  };
}

function normalizeViewport(value) {
  if (value === undefined) {
    return { ...defaultViewport };
  }

  if (!isRecord(value) || !hasOnlyKeys(value, ['width', 'height', 'deviceScaleFactor'])) {
    throw new TypeError('viewport contains unsupported fields');
  }

  return {
    width: boundedInteger(value.width, 1, 8_192, 'viewport.width'),
    height: boundedInteger(value.height, 1, 8_192, 'viewport.height'),
    deviceScaleFactor: boundedNumber(value.deviceScaleFactor, 0.1, 4, 'viewport.deviceScaleFactor'),
  };
}

function commonActionFields(value, index) {
  const id = boundedString(
    value.id,
    maxActionIdLength,
    `actions[${index}].id`,
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
  );
  const label = optionalBoundedString(value.label, maxActionLabelLength, `actions[${index}].label`);
  const settleMs = optionalBoundedInteger(
    value.settleMs,
    0,
    maxActionSettleMs,
    `actions[${index}].settleMs`,
  );
  const expectSelector = optionalBoundedString(
    value.expectSelector,
    maxSelectorLength,
    `actions[${index}].expectSelector`,
  );
  const expectUrlIncludes = optionalBoundedString(
    value.expectUrlIncludes,
    maxSelectorLength,
    `actions[${index}].expectUrlIncludes`,
  );
  const expectScrollYAtLeast = optionalBoundedNumber(
    value.expectScrollYAtLeast,
    0,
    maxScrollDelta,
    `actions[${index}].expectScrollYAtLeast`,
  );

  return {
    id,
    ...(label ? { label } : {}),
    ...(settleMs !== undefined ? { settleMs } : {}),
    ...(expectSelector ? { expectSelector } : {}),
    ...(expectUrlIncludes ? { expectUrlIncludes } : {}),
    ...(expectScrollYAtLeast !== undefined ? { expectScrollYAtLeast } : {}),
  };
}

function normalizeAction(value, index) {
  if (!isRecord(value)) {
    throw new TypeError(`actions[${index}] must be an object`);
  }

  const commonKeys = [
    'id',
    'type',
    'label',
    'settleMs',
    'expectSelector',
    'expectUrlIncludes',
    'expectScrollYAtLeast',
  ];
  const common = commonActionFields(value, index);

  switch (value.type) {
    case 'click': {
      if (
        !hasOnlyKeys(value, [...commonKeys, 'selector', 'point', 'button', 'clickCount', 'holdMs'])
      ) {
        throw new TypeError(`actions[${index}] contains unsupported click fields`);
      }

      const selector = optionalBoundedString(
        value.selector,
        maxSelectorLength,
        `actions[${index}].selector`,
      );
      const point =
        value.point === undefined
          ? undefined
          : normalizePoint(value.point, `actions[${index}].point`);

      if (
        (selector === undefined && point === undefined) ||
        (selector !== undefined && point !== undefined)
      ) {
        throw new TypeError(`actions[${index}] click requires exactly one of selector or point`);
      }

      const button =
        value.button === undefined
          ? undefined
          : ['left', 'middle', 'right'].includes(String(value.button))
            ? value.button
            : undefined;

      if (value.button !== undefined && button === undefined) {
        throw new TypeError(`actions[${index}].button is invalid`);
      }

      const clickCount = optionalBoundedInteger(
        value.clickCount,
        1,
        3,
        `actions[${index}].clickCount`,
      );
      const holdMs = optionalBoundedInteger(
        value.holdMs,
        1,
        maxActionSettleMs,
        `actions[${index}].holdMs`,
      );

      if (holdMs !== undefined && clickCount !== undefined && clickCount !== 1) {
        throw new TypeError(`actions[${index}] held clicks cannot use clickCount above 1`);
      }

      return {
        ...common,
        type: 'click',
        ...(selector ? { selector } : { point }),
        ...(button ? { button } : {}),
        ...(clickCount !== undefined ? { clickCount } : {}),
        ...(holdMs !== undefined ? { holdMs } : {}),
      };
    }
    case 'scroll': {
      if (!hasOnlyKeys(value, [...commonKeys, 'selector', 'deltaX', 'deltaY'])) {
        throw new TypeError(`actions[${index}] contains unsupported scroll fields`);
      }

      const selector = optionalBoundedString(
        value.selector,
        maxSelectorLength,
        `actions[${index}].selector`,
      );
      const deltaX = optionalBoundedNumber(
        value.deltaX,
        -maxScrollDelta,
        maxScrollDelta,
        `actions[${index}].deltaX`,
      );
      const deltaY = optionalBoundedNumber(
        value.deltaY,
        -maxScrollDelta,
        maxScrollDelta,
        `actions[${index}].deltaY`,
      );

      if ((deltaX ?? 0) === 0 && (deltaY ?? 0) === 0) {
        throw new TypeError(`actions[${index}] scroll delta must not be zero`);
      }

      return {
        ...common,
        type: 'scroll',
        ...(selector ? { selector } : {}),
        ...(deltaX !== undefined ? { deltaX } : {}),
        ...(deltaY !== undefined ? { deltaY } : {}),
      };
    }
    case 'key': {
      if (!hasOnlyKeys(value, [...commonKeys, 'selector', 'key', 'holdMs'])) {
        throw new TypeError(`actions[${index}] contains unsupported key fields`);
      }

      const selector = optionalBoundedString(
        value.selector,
        maxSelectorLength,
        `actions[${index}].selector`,
      );
      const holdMs = optionalBoundedInteger(
        value.holdMs,
        1,
        maxActionSettleMs,
        `actions[${index}].holdMs`,
      );

      return {
        ...common,
        type: 'key',
        key: boundedString(value.key, maxKeyLength, `actions[${index}].key`),
        ...(selector ? { selector } : {}),
        ...(holdMs !== undefined ? { holdMs } : {}),
      };
    }
    case 'drag': {
      if (!hasOnlyKeys(value, [...commonKeys, 'from', 'to', 'steps'])) {
        throw new TypeError(`actions[${index}] contains unsupported drag fields`);
      }

      return {
        ...common,
        type: 'drag',
        from: normalizePoint(value.from, `actions[${index}].from`),
        to: normalizePoint(value.to, `actions[${index}].to`),
        ...(value.steps !== undefined
          ? { steps: boundedInteger(value.steps, 1, 100, `actions[${index}].steps`) }
          : {}),
      };
    }
    case 'wait':
      if (!hasOnlyKeys(value, [...commonKeys, 'durationMs'])) {
        throw new TypeError(`actions[${index}] contains unsupported wait fields`);
      }

      return {
        ...common,
        type: 'wait',
        durationMs: boundedInteger(
          value.durationMs,
          1,
          maxActionSettleMs,
          `actions[${index}].durationMs`,
        ),
      };
    default:
      throw new TypeError(`actions[${index}].type must be click, scroll, key, drag, or wait`);
  }
}

export function normalizeRegressionPlan(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'viewport',
      'sourceSettleMs',
      'loopbackSettleMs',
      'actionSettleMs',
      'actions',
    ])
  ) {
    throw new TypeError('Regression plan must be an object with supported fields only');
  }

  if (value.schemaVersion !== 1) {
    throw new TypeError('Regression plan schemaVersion must be 1');
  }

  if (
    value.actions !== undefined &&
    (!Array.isArray(value.actions) || value.actions.length > maxActions)
  ) {
    throw new TypeError(`Regression plan actions must contain at most ${maxActions} entries`);
  }

  const actions = (value.actions ?? []).map((action, index) => normalizeAction(action, index));
  const ids = actions.map((action) => action.id.toLowerCase());

  if (new Set(ids).size !== ids.length) {
    throw new TypeError(
      'Regression plan action ids must be unique on case-insensitive filesystems',
    );
  }

  return {
    schemaVersion: 1,
    viewport: normalizeViewport(value.viewport),
    sourceSettleMs:
      optionalBoundedInteger(value.sourceSettleMs, 0, maxActionSettleMs, 'sourceSettleMs') ??
      defaultPlan.sourceSettleMs,
    loopbackSettleMs:
      optionalBoundedInteger(value.loopbackSettleMs, 0, maxActionSettleMs, 'loopbackSettleMs') ??
      defaultPlan.loopbackSettleMs,
    actionSettleMs:
      optionalBoundedInteger(value.actionSettleMs, 0, maxActionSettleMs, 'actionSettleMs') ??
      defaultPlan.actionSettleMs,
    actions,
  };
}

export async function loadRegressionPlan(path) {
  if (!path) {
    return normalizeRegressionPlan(defaultPlan);
  }

  const bytes = await readFile(path);

  if (bytes.byteLength > maxPlanBytes) {
    throw new Error(`Regression plan exceeds the ${maxPlanBytes} byte limit: ${path}`);
  }

  let value;

  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Regression plan is not valid JSON: ${path}`, { cause: error });
  }

  return normalizeRegressionPlan(value);
}

function isLoopbackUrl(value) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '');

    return (
      (parsed.protocol === 'http:' ||
        parsed.protocol === 'https:' ||
        parsed.protocol === 'ws:' ||
        parsed.protocol === 'wss:') &&
      (hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '::1' ||
        hostname === '0:0:0:0:0:0:0:1' ||
        /^127(?:\.\d{1,3}){3}$/u.test(hostname))
    );
  } catch {
    return false;
  }
}

export function isExpectedUnavailableLoopbackUrl(value) {
  try {
    const parsed = new URL(value);
    return isLoopbackUrl(parsed.toString()) && parsed.pathname === '/.webmirror/unavailable.js';
  } catch {
    return false;
  }
}

function isExternalNetworkUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' ||
        parsed.protocol === 'https:' ||
        parsed.protocol === 'ws:' ||
        parsed.protocol === 'wss:') &&
      !isLoopbackUrl(value)
    );
  } catch {
    return false;
  }
}

export function isNonBlockingLoopbackRequestCancellation(errorText) {
  return typeof errorText === 'string' && errorText.trim() === 'net::ERR_ABORTED';
}

export function isRecoverableHydrationError(message) {
  if (typeof message !== 'string') {
    return false;
  }

  const normalized = message.toLowerCase();
  return (
    /minified react error #(?:418|423)\b/iu.test(message) ||
    normalized.includes(
      'hydration failed because the initial ui does not match what was rendered on the server',
    ) ||
    normalized.includes('text content does not match server-rendered html') ||
    normalized.includes('expected server html to contain a matching') ||
    (normalized.includes('error while hydrating') &&
      normalized.includes('entire root will switch to client rendering')) ||
    (normalized.includes('error occurred during hydration') &&
      normalized.includes('server html was replaced'))
  );
}

export function isRecoverableMediaPlaybackInterruption(message) {
  if (typeof message !== 'string') {
    return false;
  }

  const normalized = message.trim().toLowerCase();
  return (
    normalized.startsWith('the play() request was interrupted by a call to pause().') ||
    normalized.startsWith('the play() request was interrupted by a new load request.') ||
    normalized.startsWith(
      'the play() request was interrupted because the media was removed from the document.',
    )
  );
}

export function isRecoverableExternalIntegrationConsoleError(message) {
  if (typeof message !== 'string') {
    return false;
  }

  const normalized = message.trim();
  const lower = normalized.toLowerCase();

  if (!/^\[[^\]\r\n]{1,80}\]\s+/u.test(normalized)) {
    return false;
  }

  if (
    /\b(?:typeerror|referenceerror|syntaxerror|rangeerror)\b/u.test(lower) ||
    lower.includes('cannot read properties') ||
    lower.includes('is not a function') ||
    lower.includes('is not defined')
  ) {
    return false;
  }

  return (
    /\b(?:error|failed|failure|unable|unavailable)\b/u.test(lower) &&
    /\b(?:client|init|initialization|initialize|integration|pixel|service|tracker|tracking|widget)\b/u.test(
      lower,
    )
  );
}

export function isRecoverableReplayError(message) {
  return isRecoverableHydrationError(message) || isRecoverableMediaPlaybackInterruption(message);
}

function pushUnique(values, value) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function pushUniqueRecord(values, value, key) {
  if (!values.some((candidate) => key(candidate) === key(value))) {
    values.push(value);
  }
}

function eventOffsets(evidence) {
  return {
    consoleErrors: evidence.consoleErrors.length,
    pageErrors: evidence.pageErrors.length,
    localHttpFailures: evidence.localHttpFailures.length,
    localRequestFailures: evidence.localRequestFailures.length,
    localRequestCancellations: evidence.localRequestCancellations.length,
    remoteRequests: evidence.remoteRequests.length,
    screenshotErrors: evidence.screenshotErrors.length,
  };
}

function eventDelta(evidence, offsets) {
  return {
    consoleErrors: evidence.consoleErrors.slice(offsets.consoleErrors),
    pageErrors: evidence.pageErrors.slice(offsets.pageErrors),
    localHttpFailures: evidence.localHttpFailures.slice(offsets.localHttpFailures),
    localRequestFailures: evidence.localRequestFailures.slice(offsets.localRequestFailures),
    localRequestCancellations: evidence.localRequestCancellations.slice(
      offsets.localRequestCancellations,
    ),
    remoteRequests: evidence.remoteRequests.slice(offsets.remoteRequests),
    screenshotErrors: evidence.screenshotErrors.slice(offsets.screenshotErrors),
  };
}

async function runAction(page, action) {
  switch (action.type) {
    case 'click':
      if (action.holdMs === undefined) {
        if (action.selector) {
          await page.locator(action.selector).click({
            button: action.button ?? 'left',
            clickCount: action.clickCount ?? 1,
            timeout: 10_000,
          });
        } else {
          await page.mouse.click(action.point.x, action.point.y, {
            button: action.button ?? 'left',
            clickCount: action.clickCount ?? 1,
          });
        }
        return;
      }

      if (action.selector) {
        await page.locator(action.selector).hover({ timeout: 10_000 });
      } else {
        await page.mouse.move(action.point.x, action.point.y);
      }

      await page.mouse.down({ button: action.button ?? 'left' });
      try {
        await page.waitForTimeout(action.holdMs);
      } finally {
        await page.mouse.up({ button: action.button ?? 'left' });
      }
      return;
    case 'scroll':
      if (action.selector) {
        const target = page.locator(action.selector);
        await target.scrollIntoViewIfNeeded({ timeout: 10_000 });
        await target.hover({ timeout: 10_000 });
      }
      await page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 0);
      return;
    case 'key':
      if (action.selector) {
        await page.locator(action.selector).focus({ timeout: 10_000 });
      }
      if (action.holdMs === undefined) {
        await page.keyboard.press(action.key);
        return;
      }

      await page.keyboard.down(action.key);
      try {
        await page.waitForTimeout(action.holdMs);
      } finally {
        await page.keyboard.up(action.key);
      }
      return;
    case 'drag':
      await page.mouse.move(action.from.x, action.from.y);
      await page.mouse.down();
      try {
        await page.mouse.move(action.to.x, action.to.y, {
          steps: action.steps ?? 10,
        });
      } finally {
        await page.mouse.up();
      }
      return;
    case 'wait':
      await page.waitForTimeout(action.durationMs);
  }
}

async function assertActionOutcome(page, action) {
  if (action.expectSelector) {
    await page.locator(action.expectSelector).first().waitFor({
      state: 'visible',
      timeout: 10_000,
    });
  }

  if (action.expectUrlIncludes && !page.url().includes(action.expectUrlIncludes)) {
    throw new Error(
      `Action ${action.id} did not navigate to a URL containing ${JSON.stringify(action.expectUrlIncludes)}.`,
    );
  }

  if (action.expectScrollYAtLeast !== undefined) {
    const scrollY = await page.evaluate(() => globalThis.scrollY);

    if (scrollY < action.expectScrollYAtLeast) {
      throw new Error(
        `Action ${action.id} reached scrollY ${scrollY}, below the required ${action.expectScrollYAtLeast}.`,
      );
    }
  }
}

export function evaluateLoopbackEvidence(evidence, actionCount) {
  const actionFailures = evidence.checkpoints.filter(
    (checkpoint) => checkpoint.action && checkpoint.error,
  );
  const recoverableExternalIntegrationErrors = evidence.consoleErrors.filter(
    isRecoverableExternalIntegrationConsoleError,
  );
  const recoverableReplayConsoleErrors = evidence.consoleErrors.filter(
    (message) =>
      isRecoverableReplayError(message) || isRecoverableExternalIntegrationConsoleError(message),
  );
  const recoverableReplayPageErrors = evidence.pageErrors.filter(isRecoverableReplayError);
  const ordinaryConsoleErrors = evidence.consoleErrors.filter(
    (message) =>
      !isRecoverableReplayError(message) && !isRecoverableExternalIntegrationConsoleError(message),
  );
  const ordinaryPageErrors = evidence.pageErrors.filter(
    (message) => !isRecoverableReplayError(message),
  );
  const hydrationCandidateCount =
    evidence.consoleErrors.filter(isRecoverableHydrationError).length +
    evidence.pageErrors.filter(isRecoverableHydrationError).length;
  const mediaPlaybackCandidateCount =
    evidence.consoleErrors.filter(isRecoverableMediaPlaybackInterruption).length +
    evidence.pageErrors.filter(isRecoverableMediaPlaybackInterruption).length;
  const recoverableReplayErrorCount =
    recoverableReplayConsoleErrors.length + recoverableReplayPageErrors.length;
  const replayRecovered =
    recoverableReplayErrorCount > 0 &&
    actionFailures.length === 0 &&
    ordinaryConsoleErrors.length === 0 &&
    ordinaryPageErrors.length === 0 &&
    evidence.localHttpFailures.length === 0 &&
    evidence.localRequestFailures.length === 0 &&
    evidence.remoteRequests.length === 0 &&
    evidence.screenshotErrors.length === 0 &&
    evidence.checkpoints.length === actionCount + 1;
  const blockingConsoleErrors = replayRecovered ? ordinaryConsoleErrors : evidence.consoleErrors;
  const blockingPageErrors = replayRecovered ? ordinaryPageErrors : evidence.pageErrors;
  const warnings = [];

  if (replayRecovered && hydrationCandidateCount > 0) {
    warnings.push(
      `${hydrationCandidateCount} React hydration recovery error event(s) were retained as warnings after offline replay and all planned actions passed.`,
    );
  }

  if (replayRecovered && mediaPlaybackCandidateCount > 0) {
    warnings.push(
      `${mediaPlaybackCandidateCount} browser media playback interruption error event(s) were retained as warnings after offline replay and all planned actions passed.`,
    );
  }

  if (replayRecovered && recoverableExternalIntegrationErrors.length > 0) {
    warnings.push(
      `${recoverableExternalIntegrationErrors.length} handled external integration initialization error event(s) were retained as warnings after offline replay and all planned actions passed.`,
    );
  }

  const passed =
    actionFailures.length === 0 &&
    blockingConsoleErrors.length === 0 &&
    blockingPageErrors.length === 0 &&
    evidence.localHttpFailures.length === 0 &&
    evidence.localRequestFailures.length === 0 &&
    evidence.remoteRequests.length === 0 &&
    evidence.screenshotErrors.length === 0 &&
    evidence.checkpoints.length === actionCount + 1;

  return {
    actionFailures,
    blockingConsoleErrors,
    blockingPageErrors,
    recoverableHydrationErrors: replayRecovered ? hydrationCandidateCount : 0,
    recoverableMediaPlaybackInterruptions: replayRecovered ? mediaPlaybackCandidateCount : 0,
    recoverableExternalIntegrationErrors: replayRecovered
      ? recoverableExternalIntegrationErrors.length
      : 0,
    recoverableReplayErrors: replayRecovered ? recoverableReplayErrorCount : 0,
    warnings,
    passed,
  };
}

export async function runLoopbackRegression(entryUrl, evidenceDirectory, plan) {
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: false,
  });
  const context = await browser.newContext({
    viewport: {
      width: plan.viewport.width,
      height: plan.viewport.height,
    },
    deviceScaleFactor: plan.viewport.deviceScaleFactor,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const page = await context.newPage();
  const evidence = {
    consoleErrors: [],
    pageErrors: [],
    localHttpFailures: [],
    localRequestFailures: [],
    localRequestCancellations: [],
    remoteRequests: [],
    screenshotErrors: [],
    checkpoints: [],
  };

  page.on('console', (message) => {
    if (message.type() === 'error' && !isExpectedUnavailableLoopbackUrl(message.location().url)) {
      pushUnique(evidence.consoleErrors, message.text());
    }
  });
  page.on('pageerror', (error) => {
    pushUnique(evidence.pageErrors, error.message);
  });
  page.on('response', (response) => {
    if (
      isLoopbackUrl(response.url()) &&
      response.status() >= 400 &&
      !isExpectedUnavailableLoopbackUrl(response.url())
    ) {
      pushUniqueRecord(
        evidence.localHttpFailures,
        {
          status: response.status(),
          url: response.url(),
        },
        (value) => `${value.status}:${value.url}`,
      );
    }
  });
  page.on('request', (request) => {
    if (isExternalNetworkUrl(request.url())) {
      pushUnique(evidence.remoteRequests, request.url());
    }
  });
  page.on('requestfailed', (request) => {
    if (isLoopbackUrl(request.url())) {
      if (isExpectedUnavailableLoopbackUrl(request.url())) {
        return;
      }

      const failure = {
        url: request.url(),
        errorText: request.failure()?.errorText ?? 'Unknown request failure',
      };
      const destination = isNonBlockingLoopbackRequestCancellation(failure.errorText)
        ? evidence.localRequestCancellations
        : evidence.localRequestFailures;

      pushUniqueRecord(destination, failure, (value) => `${value.url}:${value.errorText}`);
    }
  });
  page.on('websocket', (webSocket) => {
    if (isExternalNetworkUrl(webSocket.url())) {
      pushUnique(evidence.remoteRequests, webSocket.url());
    }
  });

  await context.route('**/*', async (route) => {
    if (isExternalNetworkUrl(route.request().url())) {
      pushUnique(evidence.remoteRequests, route.request().url());
      await route.abort('blockedbyclient');
      return;
    }

    await route.continue();
  });
  await context.routeWebSocket(/.*/u, async (webSocket) => {
    if (isExternalNetworkUrl(webSocket.url())) {
      pushUnique(evidence.remoteRequests, webSocket.url());
      await webSocket.close({
        code: 1008,
        reason: 'WebMirror real-site regression blocks remote network traffic.',
      });
      return;
    }

    await webSocket.connectToServer();
  });

  const captureCheckpoint = async (id, label, action, actionError, offsets) => {
    const checkpointOffsets = offsets ?? eventOffsets(evidence);
    const screenshot = `mirror-${String(evidence.checkpoints.length + 1).padStart(2, '0')}-${id}.png`;
    let screenshotPath;

    try {
      await page.screenshot({
        fullPage: false,
        path: join(evidenceDirectory, screenshot),
      });
      screenshotPath = screenshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      evidence.screenshotErrors.push(message);
    }

    const scroll = await page.evaluate(() => ({
      x: globalThis.scrollX,
      y: globalThis.scrollY,
      documentWidth: Math.max(
        globalThis.document.documentElement.scrollWidth,
        globalThis.document.body?.scrollWidth ?? 0,
      ),
      documentHeight: Math.max(
        globalThis.document.documentElement.scrollHeight,
        globalThis.document.body?.scrollHeight ?? 0,
      ),
    }));
    const checkpoint = {
      id,
      label,
      ...(action ? { action } : {}),
      ...(actionError ? { error: actionError } : {}),
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      title: await page.title(),
      url: page.url(),
      canvasCount: await page.locator('canvas').count(),
      scroll,
      ...eventDelta(evidence, checkpointOffsets),
    };
    evidence.checkpoints.push(checkpoint);
    return checkpoint;
  };

  try {
    const initialOffsets = eventOffsets(evidence);
    await page.goto(entryUrl, {
      timeout: 60_000,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(plan.loopbackSettleMs);
    await captureCheckpoint(
      'initial',
      'Initial offline replay',
      undefined,
      undefined,
      initialOffsets,
    );

    for (const action of plan.actions) {
      const actionOffsets = eventOffsets(evidence);
      let actionError;

      try {
        await runAction(page, action);
        await page.waitForTimeout(action.settleMs ?? plan.actionSettleMs);
        await assertActionOutcome(page, action);
      } catch (error) {
        actionError = error instanceof Error ? error.message : String(error);
      }

      await captureCheckpoint(
        action.id,
        action.label ?? `${action.type}: ${action.id}`,
        action,
        actionError,
        actionOffsets,
      );

      if (actionError) {
        break;
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return {
    ...evidence,
    ...evaluateLoopbackEvidence(evidence, plan.actions.length),
  };
}
