import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';

export function authMiddleware(req, _res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  if (!token || token !== env.apiAuthToken) {
    return next(new AppError('UNAUTHORIZED', 'Unauthorized', 401));
  }
  next();
}
