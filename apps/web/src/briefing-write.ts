import { api } from './api';

// Only use for idempotent writes (turn ID or action call ID). An acknowledgement
// may be lost after commit; retrying the same payload returns the saved result.
export async function briefingWrite(path: string, body: unknown, beforeSend?: () => void) {
  for (let attempt = 0; ; attempt++) {
    beforeSend?.();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      return await api(path, body, undefined, controller.signal);
    } catch (error: any) {
      if (attempt >= 2 || (error.status && error.status < 500 && error.status !== 429)) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
}
