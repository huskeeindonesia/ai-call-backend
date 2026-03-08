import { Router } from 'express';
import { adapterReadiness } from '../providers/index.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ai-call-backend', readiness: adapterReadiness() });
});

export default router;
