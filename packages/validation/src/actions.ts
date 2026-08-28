import type { Page } from 'playwright';

import type {
  ValidationAction,
  ValidationDragAction,
  ValidationPerceptualOptions,
  ValidationPoint,
} from './types.js';
import { PublicValidationError } from './diagnostics.js';

const MAX_ACTIONS = 32;
const MAX_ACTION_ID_LENGTH = 64;
const MAX_ACTION_LABEL_LENGTH = 160;
const MAX_SELECTOR_LENGTH = 2_048;
const MAX_KEY_LENGTH = 64;
const MAX_ACTION_TIMEOUT_MS = 30_000;
const MAX_ACTION_SETTLE_MS = 10_000;
const MAX_COORDINATE = 100_000;
const MAX_SCROLL_DELTA = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function boundedString(
  value: unknown,
  maximumLength: number,
  name: string,
  pattern?: RegExp,
): string {
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

function optionalBoundedString(
  value: unknown,
  maximumLength: number,
  name: string,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, maximumLength, name);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }

  return Number(value);
}

function optionalBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number | undefined {
  return value === undefined ? undefined : boundedInteger(value, minimum, maximum, name);
}

function boundedNumber(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a finite number from ${minimum} to ${maximum}`);
  }

  return value;
}

function optionalBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number | undefined {
  return value === undefined ? undefined : boundedNumber(value, minimum, maximum, name);
}

function normalizePoint(value: unknown, name: string): ValidationPoint {
  if (!isRecord(value) || !hasOnlyKeys(value, ['x', 'y'])) {
    throw new TypeError(`${name} must contain only x and y coordinates`);
  }

  return {
    x: boundedNumber(value.x, 0, MAX_COORDINATE, `${name}.x`),
    y: boundedNumber(value.y, 0, MAX_COORDINATE, `${name}.y`),
  };
}

function normalizePerceptualOptions(
  value: unknown,
  name: string,
): ValidationPerceptualOptions | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'threshold',
      'maxDifferenceRatio',
      'partialDifferenceRatio',
      'includeAntialiasing',
    ])
  ) {
    throw new TypeError(`${name} contains unsupported fields`);
  }

  const threshold = optionalBoundedNumber(value.threshold, 0, 1, `${name}.threshold`);
  const maxDifferenceRatio = optionalBoundedNumber(
    value.maxDifferenceRatio,
    0,
    1,
    `${name}.maxDifferenceRatio`,
  );
  const partialDifferenceRatio = optionalBoundedNumber(
    value.partialDifferenceRatio,
    0,
    1,
    `${name}.partialDifferenceRatio`,
  );

  if (
    maxDifferenceRatio !== undefined &&
    partialDifferenceRatio !== undefined &&
    partialDifferenceRatio < maxDifferenceRatio
  ) {
    throw new TypeError(
      `${name}.partialDifferenceRatio must be greater than or equal to maxDifferenceRatio`,
    );
  }

  if (value.includeAntialiasing !== undefined && typeof value.includeAntialiasing !== 'boolean') {
    throw new TypeError(`${name}.includeAntialiasing must be a boolean`);
  }

  return {
    ...(threshold !== undefined ? { threshold } : {}),
    ...(maxDifferenceRatio !== undefined ? { maxDifferenceRatio } : {}),
    ...(partialDifferenceRatio !== undefined ? { partialDifferenceRatio } : {}),
    ...(value.includeAntialiasing !== undefined
      ? { includeAntialiasing: value.includeAntialiasing }
      : {}),
  };
}

function commonActionFields(value: Record<string, unknown>, index: number) {
  const id = boundedString(
    value.id,
    MAX_ACTION_ID_LENGTH,
    `actions[${index}].id`,
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
  );

  if (id.toLowerCase() === 'initial') {
    throw new TypeError('The action id "initial" is reserved for the initial checkpoint');
  }

  const label = optionalBoundedString(
    value.label,
    MAX_ACTION_LABEL_LENGTH,
    `actions[${index}].label`,
  );
  const timeoutMs = optionalBoundedInteger(
    value.timeoutMs,
    1,
    MAX_ACTION_TIMEOUT_MS,
    `actions[${index}].timeoutMs`,
  );
  const settleTimeMs = optionalBoundedInteger(
    value.settleTimeMs,
    0,
    MAX_ACTION_SETTLE_MS,
    `actions[${index}].settleTimeMs`,
  );
  const perceptual = normalizePerceptualOptions(value.perceptual, `actions[${index}].perceptual`);

  return {
    id,
    ...(label ? { label } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(settleTimeMs !== undefined ? { settleTimeMs } : {}),
    ...(perceptual ? { perceptual } : {}),
  };
}

function normalizeAction(value: unknown, index: number): ValidationAction {
  if (!isRecord(value)) {
    throw new TypeError(`actions[${index}] must be an object`);
  }

  const commonKeys = ['id', 'type', 'label', 'timeoutMs', 'settleTimeMs', 'perceptual'];
  const common = commonActionFields(value, index);

  switch (value.type) {
    case 'click': {
      if (!hasOnlyKeys(value, [...commonKeys, 'selector', 'button', 'clickCount'])) {
        throw new TypeError(`actions[${index}] contains unsupported click fields`);
      }

      const selector = boundedString(
        value.selector,
        MAX_SELECTOR_LENGTH,
        `actions[${index}].selector`,
      );
      const button =
        value.button === undefined
          ? undefined
          : ['left', 'middle', 'right'].includes(String(value.button))
            ? (value.button as 'left' | 'middle' | 'right')
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
      return {
        ...common,
        type: 'click',
        selector,
        ...(button ? { button } : {}),
        ...(clickCount !== undefined ? { clickCount } : {}),
      };
    }
    case 'scroll': {
      if (!hasOnlyKeys(value, [...commonKeys, 'selector', 'deltaX', 'deltaY'])) {
        throw new TypeError(`actions[${index}] contains unsupported scroll fields`);
      }

      const selector = optionalBoundedString(
        value.selector,
        MAX_SELECTOR_LENGTH,
        `actions[${index}].selector`,
      );
      const deltaX = optionalBoundedNumber(
        value.deltaX,
        -MAX_SCROLL_DELTA,
        MAX_SCROLL_DELTA,
        `actions[${index}].deltaX`,
      );
      const deltaY = optionalBoundedNumber(
        value.deltaY,
        -MAX_SCROLL_DELTA,
        MAX_SCROLL_DELTA,
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
      if (!hasOnlyKeys(value, [...commonKeys, 'selector', 'key'])) {
        throw new TypeError(`actions[${index}] contains unsupported key fields`);
      }

      const selector = optionalBoundedString(
        value.selector,
        MAX_SELECTOR_LENGTH,
        `actions[${index}].selector`,
      );
      const key = boundedString(value.key, MAX_KEY_LENGTH, `actions[${index}].key`);
      return {
        ...common,
        type: 'key',
        key,
        ...(selector ? { selector } : {}),
      };
    }
    case 'drag': {
      if (!hasOnlyKeys(value, [...commonKeys, 'selector', 'from', 'to', 'steps'])) {
        throw new TypeError(`actions[${index}] contains unsupported drag fields`);
      }

      return {
        ...common,
        type: 'drag',
        selector: boundedString(value.selector, MAX_SELECTOR_LENGTH, `actions[${index}].selector`),
        from: normalizePoint(value.from, `actions[${index}].from`),
        to: normalizePoint(value.to, `actions[${index}].to`),
        ...(value.steps !== undefined
          ? {
              steps: boundedInteger(value.steps, 1, 100, `actions[${index}].steps`),
            }
          : {}),
      };
    }
    default:
      throw new TypeError(`actions[${index}].type must be click, scroll, key, or drag`);
  }
}

export function normalizeValidationActions(
  values: readonly ValidationAction[] | undefined,
): ValidationAction[] {
  if (values === undefined) {
    return [];
  }

  if (!Array.isArray(values) || values.length > MAX_ACTIONS) {
    throw new TypeError(`actions must contain at most ${MAX_ACTIONS} entries`);
  }

  const actions = values.map((value, index) => normalizeAction(value, index));
  const ids = actions.map((action) => action.id.toLowerCase());

  if (new Set(ids).size !== ids.length) {
    throw new TypeError('actions must use ids that are unique on case-insensitive filesystems');
  }

  return actions;
}

export function validationActionLabel(action: ValidationAction): string {
  return action.label ?? `${action.type}: ${action.id}`;
}

function dragCoordinates(
  action: ValidationDragAction,
  bounds: { x: number; y: number; width: number; height: number },
): { from: ValidationPoint; to: ValidationPoint } {
  for (const [name, point] of [
    ['from', action.from],
    ['to', action.to],
  ] as const) {
    if (point.x > bounds.width || point.y > bounds.height) {
      throw new PublicValidationError(
        `Drag ${name} coordinates are outside the selected element (${Math.round(
          bounds.width,
        )}x${Math.round(bounds.height)})`,
      );
    }
  }

  return {
    from: {
      x: bounds.x + action.from.x,
      y: bounds.y + action.from.y,
    },
    to: {
      x: bounds.x + action.to.x,
      y: bounds.y + action.to.y,
    },
  };
}

export async function executeValidationAction(
  page: Page,
  action: ValidationAction,
  defaultTimeoutMs: number,
): Promise<void> {
  const timeout = action.timeoutMs ?? defaultTimeoutMs;

  switch (action.type) {
    case 'click':
      await page.locator(action.selector).click({
        timeout,
        button: action.button ?? 'left',
        clickCount: action.clickCount ?? 1,
      });
      return;
    case 'scroll':
      if (action.selector) {
        const target = page.locator(action.selector);
        await target.scrollIntoViewIfNeeded({ timeout });
        await target.hover({ timeout });
      }

      await page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 0);
      return;
    case 'key': {
      if (action.selector) {
        await page.locator(action.selector).focus({ timeout });
      }

      const editableControlFocused = await page.evaluate(() => {
        const active = document.activeElement;
        return (
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLSelectElement ||
          (active instanceof HTMLElement && active.isContentEditable)
        );
      });

      if (editableControlFocused) {
        throw new PublicValidationError(
          'Key actions are disabled while an editable form control is focused',
        );
      }

      await page.keyboard.press(action.key);
      return;
    }
    case 'drag': {
      const target = page.locator(action.selector);
      await target.scrollIntoViewIfNeeded({ timeout });
      const bounds = await target.boundingBox({ timeout });

      if (!bounds) {
        throw new PublicValidationError('The drag target is not visible');
      }

      const points = dragCoordinates(action, bounds);
      await page.mouse.move(points.from.x, points.from.y);
      await page.mouse.down();

      try {
        await page.mouse.move(points.to.x, points.to.y, {
          steps: action.steps ?? 10,
        });
      } finally {
        await page.mouse.up();
      }

      return;
    }
  }
}

export function validatePerceptualOptions(
  value: ValidationPerceptualOptions | undefined,
  name = 'perceptual',
): ValidationPerceptualOptions | undefined {
  return normalizePerceptualOptions(value, name);
}
