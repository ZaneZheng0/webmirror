import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition } from './job-state.js';

describe('job state transitions', () => {
  it('allows the primary successful path', () => {
    expect(canTransition('created', 'preflight')).toBe(true);
    expect(canTransition('fast_validating', 'ready')).toBe(true);
    expect(canTransition('deep_validating', 'complete')).toBe(true);
  });

  it('rejects transitions out of terminal states', () => {
    expect(canTransition('complete', 'created')).toBe(false);
    expect(() => assertTransition('failed', 'preflight')).toThrow(
      'Invalid job state transition: failed -> preflight',
    );
  });
});
