export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BAD_GRID"
  | "ALL_ZERO_WEIGHTS"
  | "ELEMENT_OUT_OF_RANGE"
  | "DUPLICATE_POSITION"
  | "IDEMPOTENCY_MISMATCH"
  | "INVALID_PAGINATION"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly status: number;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.status = errorStatus(code);
  }
}

export function errorStatus(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION_ERROR":
    case "BAD_GRID":
    case "ALL_ZERO_WEIGHTS":
    case "ELEMENT_OUT_OF_RANGE":
    case "DUPLICATE_POSITION":
    case "INVALID_PAGINATION":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "IDEMPOTENCY_MISMATCH":
      return 409;
    default:
      return 500;
  }
}

export interface PageParams {
  limit: number;
  offset: number;
}

export function parsePageParams(query: {
  limit?: string | number;
  offset?: string | number;
}): PageParams {
  const limitRaw = query.limit ?? 50;
  const offsetRaw = query.offset ?? 0;
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || limit > 500 || offset < 0) {
    throw new AppError(
      "INVALID_PAGINATION",
      "limit must be an integer 1..500 and offset a non-negative integer.",
      { limit: limitRaw, offset: offsetRaw },
    );
  }
  return { limit, offset };
}
