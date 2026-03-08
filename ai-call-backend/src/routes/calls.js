import { Router } from 'express';
import { callService } from '../services/call-service.js';

const router = Router();

router.post('/v1/calls/outbound', async (req, res, next) => {
  try {
    const data = await callService.createOutboundCall(req.body);
    res.status(202).json(data);
  } catch (e) {
    next(e);
  }
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
