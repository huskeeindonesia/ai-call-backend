const calls = new Map();
const events = new Map();

export class CallRepository {
  create(call) {
    calls.set(call.call_id, call);
    events.set(call.call_id, []);
    return call;
  }

  update(callId, patch) {
    const existing = calls.get(callId);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updated_at: new Date().toISOString() };
    calls.set(callId, updated);
    return updated;
  }

  get(callId) {
    return calls.get(callId) || null;
  }

  addEvent(callId, event) {
    const list = events.get(callId) || [];
    list.push({ at: new Date().toISOString(), ...event });
    events.set(callId, list);
    return list[list.length - 1];
  }

  getEvents(callId) {
    return events.get(callId) || [];
  }
}

export const callRepository = new CallRepository();
