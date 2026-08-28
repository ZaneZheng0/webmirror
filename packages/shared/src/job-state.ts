export const jobStates = [
  'created',
  'preflight',
  'attaching',
  'discovering',
  'downloading',
  'localizing',
  'starting_preview',
  'fast_validating',
  'ready',
  'deep_validating',
  'complete',
  'partial',
  'cancelling',
  'cancelled',
  'failed',
] as const;

export type JobState = (typeof jobStates)[number];

const transitions: Readonly<Record<JobState, readonly JobState[]>> = {
  created: ['preflight', 'cancelling', 'failed'],
  preflight: ['attaching', 'cancelling', 'failed'],
  attaching: ['discovering', 'cancelling', 'failed'],
  discovering: ['downloading', 'cancelling', 'failed'],
  downloading: ['localizing', 'cancelling', 'failed'],
  localizing: ['starting_preview', 'cancelling', 'failed'],
  starting_preview: ['fast_validating', 'cancelling', 'failed'],
  fast_validating: ['ready', 'partial', 'cancelling', 'failed'],
  ready: ['deep_validating', 'complete', 'partial', 'cancelling', 'failed'],
  deep_validating: ['complete', 'partial', 'cancelling', 'failed'],
  complete: ['downloading', 'fast_validating'],
  partial: ['downloading', 'fast_validating'],
  cancelling: ['complete', 'partial', 'cancelled', 'failed'],
  cancelled: [],
  failed: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job state transition: ${from} -> ${to}`);
  }
}
