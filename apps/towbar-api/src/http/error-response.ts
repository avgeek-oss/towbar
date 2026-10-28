import { APIError } from "better-auth/api";
import { ZodError } from "zod";
import { ManifestValidationError } from "@workspace/towbar-core";
import { HttpError } from "./errors.js";
import type { HttpErrorStatus } from "./errors.js";
export function normalizeError(error: Error): {
  code: string;
  headers?: Record<string, string>;
  message: string;
  status: HttpErrorStatus;
} {
  if (error instanceof HttpError) {
    return {
      code: error.code,
      headers: error.responseHeaders,
      message: error.publicMessage,
      status: error.status,
    };
  }
  if (
    error instanceof APIError &&
    [400, 401, 403, 404, 409, 422, 429].includes(error.statusCode)
  ) {
    return {
      code: String(error.body?.code ?? "AUTH_ERROR"),
      message: String(error.body?.message ?? "Authentication request failed"),
      status: error.statusCode as HttpErrorStatus,
    };
  }
  if (error instanceof ZodError) {
    return {
      code: "INVALID_REQUEST",
      message: error.issues[0]?.message ?? "Request is invalid",
      status: 400,
    };
  }
  if (error instanceof ManifestValidationError) {
    return {
      code: "INVALID_MANIFEST",
      message: error.issues[0]?.message ?? error.message,
      status: 422,
    };
  }
  return { code: "INTERNAL_ERROR", message: "Towbar API error", status: 500 };
}
