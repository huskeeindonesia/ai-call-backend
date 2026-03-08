import { AppError } from '../core/errors.js';

export function errorHandler(err, req, res, _next) {
  const requestId = req.id;
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
      request_id: requestId
    });
  }

  req.log.error({ err }, 'Unhandled error');
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    request_id: requestId
  });
}
