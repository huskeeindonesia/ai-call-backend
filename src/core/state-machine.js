const allowed = {
  pending_queue: ['queued', 'canceled'],
  queued: ['dialing', 'failed', 'canceled'],
  dialing: ['ringing', 'failed', 'canceled'],
  ringing: ['answered', 'voicemail', 'failed', 'canceled'],
  answered: ['in_progress', 'completed', 'failed', 'canceled'],
  in_progress: ['completed', 'failed', 'canceled'],
  voicemail: ['completed', 'canceled'],
  completed: [],
  failed: [],
  canceled: []
};

export function canTransition(from, to) {
  if (!allowed[from]) return false;
  return allowed[from].includes(to);
}
