export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const errorCatalog = {
  UNAUTHORIZED: { status: 401, message: 'Unauthorized' },
  INVALID_REQUEST: { status: 400, message: 'Invalid request payload' },
  NOT_FOUND: { status: 404, message: 'Resource not found' },
  PROVIDER_NOT_READY: { status: 422, message: 'Selected provider not configured' },
  QUEUE_TIMEOUT: { status: 429, message: 'Concurrency queue timed out — too many active calls' },
  INTERNAL_ERROR: { status: 500, message: 'Internal server error' }
};
