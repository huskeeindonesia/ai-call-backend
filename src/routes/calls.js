import { Router } from 'express';
import { callService } from '../services/call-service.js';
import { callQueueService } from '../services/call-queue-service.js';

const router = Router();

router.post('/v1/calls/outbound', async (req, res, next) => {
  try {
    const data = await callService.createOutboundCall(req.body);
    res.status(202).json(data);
  } catch (e) {
    next(e);
  }
});

// ─── Queue status endpoints ─────────────────────────────────────────────────

/** Get queue status for a specific user */
router.get('/v1/queue/status/:userId', (req, res) => {
  res.json(callQueueService.getStatus(req.params.userId));
});

/** Get queue status for all users */
router.get('/v1/queue/status', (_req, res) => {
  res.json(callQueueService.getAllStatus());
});

/** Update concurrency limit for a user */
router.put('/v1/queue/limit/:userId', (req, res) => {
  const { max_concurrent } = req.body;
  if (!max_concurrent || typeof max_concurrent !== 'number' || max_concurrent < 1) {
    return res.status(400).json({ error: 'max_concurrent must be a positive integer' });
  }
  callQueueService.setUserLimit(req.params.userId, max_concurrent);
  res.json(callQueueService.getStatus(req.params.userId));
});

router.get('/v1/calls/:callId', (req, res, next) => {
  try {
    const data = callService.getCall(req.params.callId);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.get('/v1/calls/:callId/details', (req, res, next) => {
  try {
    const data = callService.getCallDetails(req.params.callId);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.post('/v1/calls/:callId/hangup', async (req, res, next) => {
  try {
    const data = await callService.hangup(req.params.callId);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

export default router;
