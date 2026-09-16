/**
 * An error whose message is written for the caller and is safe to return.
 * Kept free of Next.js imports so the worker process can throw it too.
 */
export class ApiError extends Error {
  status: number;
  field?: string;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.field = field;
  }
}
