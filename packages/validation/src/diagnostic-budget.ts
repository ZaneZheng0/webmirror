import type { ValidationDiagnosticCategory, ValidationDiagnosticsResult } from './types.js';

const MAX_EVENTS_PER_CATEGORY = 64;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const ESTIMATED_JSON_OVERHEAD_BYTES = 24;
const categories = [
  'httpFailures',
  'consoleErrors',
  'pageErrors',
  'remoteDependencies',
] as const satisfies readonly ValidationDiagnosticCategory[];

interface DiagnosticCategoryState {
  recorded: number;
  dropped: number;
  droppedBlocking: number;
}

function incrementSafely(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

export class DiagnosticBudget {
  readonly #states: Record<ValidationDiagnosticCategory, DiagnosticCategoryState> = {
    httpFailures: { recorded: 0, dropped: 0, droppedBlocking: 0 },
    consoleErrors: { recorded: 0, dropped: 0, droppedBlocking: 0 },
    pageErrors: { recorded: 0, dropped: 0, droppedBlocking: 0 },
    remoteDependencies: { recorded: 0, dropped: 0, droppedBlocking: 0 },
  };

  #recordedBytes = 0;
  #droppedEvents = 0;

  record<T>(category: ValidationDiagnosticCategory, createValue: () => T): T | undefined {
    const state = this.#states[category];

    if (state.recorded >= MAX_EVENTS_PER_CATEGORY || this.#recordedBytes >= MAX_DIAGNOSTIC_BYTES) {
      this.#drop(state);
      return undefined;
    }

    const value = createValue();
    const serialized = JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized ?? '', 'utf8') + ESTIMATED_JSON_OVERHEAD_BYTES;

    if (bytes > MAX_DIAGNOSTIC_BYTES - this.#recordedBytes) {
      this.#drop(state);
      return undefined;
    }

    state.recorded += 1;
    this.#recordedBytes += bytes;
    return value;
  }

  droppedEvents(): number {
    return this.#droppedEvents;
  }

  markDroppedBlocking(category: ValidationDiagnosticCategory): void {
    const state = this.#states[category];
    state.droppedBlocking = incrementSafely(state.droppedBlocking);
  }

  result(): ValidationDiagnosticsResult {
    return {
      passed: this.#droppedEvents === 0,
      truncated: this.#droppedEvents > 0,
      estimatedRecordedEventBytes: this.#recordedBytes,
      eventByteBudget: MAX_DIAGNOSTIC_BYTES,
      droppedEvents: this.#droppedEvents,
      categories: Object.fromEntries(
        categories.map((category) => [
          category,
          {
            recorded: this.#states[category].recorded,
            dropped: this.#states[category].dropped,
            droppedBlocking: this.#states[category].droppedBlocking,
            eventLimit: MAX_EVENTS_PER_CATEGORY,
          },
        ]),
      ) as ValidationDiagnosticsResult['categories'],
    };
  }

  #drop(state: DiagnosticCategoryState): void {
    state.dropped = incrementSafely(state.dropped);
    this.#droppedEvents = incrementSafely(this.#droppedEvents);
  }
}
