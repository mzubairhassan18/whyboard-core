/**
 * The AI SDK's `fullStream` reports provider failures as `error` parts, then
 * rejects the result promises with a generic `NoOutputGeneratedError`. Surfacing
 * the original message is the difference between "No output generated" and
 * "AI Gateway requires a valid credit card on file".
 */
export function streamError(error: unknown): Error {
  if (error instanceof Error) {
    const body = (error as { responseBody?: unknown }).responseBody;
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body) as {
          error?: { message?: unknown };
          message?: unknown;
        };
        const message = parsed.error?.message ?? parsed.message;
        if (typeof message === 'string' && message.trim()) return new Error(message);
      } catch {
        // Not JSON; fall through to the error itself.
      }
    }
    return error;
  }

  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return new Error(message);
  }

  return new Error(String(error));
}
