export async function api(path: string, body?: any, method?: string, signal?: AbortSignal) {
  // Provider checks can hang on a slow sign-in; give them a deadline the user can act on.
  const deadline = path.startsWith('/providers') ? AbortSignal.timeout(35000) : undefined;
  const requestSignal =
    signal && deadline ? AbortSignal.any([signal, deadline]) : signal || deadline;
  let response: Response;
  try {
    response = await fetch('/api' + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: {
        'x-workspace-request': '1',
        // A body-less request (e.g. DELETE) must not claim JSON, or the server rejects it.
        ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: requestSignal,
    });
  } catch (error) {
    // The caller cancelled: let it see its own abort. Never retry here; a sign-in may not be repeatable.
    if (signal?.aborted) throw error;
    throw Object.assign(
      new Error(
        deadline?.aborted
          ? 'The provider is taking too long to respond. Try checking again, or choose another provider.'
          : 'Cannot reach Abralo. Reopen the Abralo app if it has stopped, then try again.',
      ),
      { code: deadline?.aborted ? 'request_timeout' : 'service_unreachable' },
    );
  }
  const data = await response.json().catch(() => {
    throw Object.assign(
      new Error('Abralo returned an unexpected response. Reopen the app and try again.'),
      { status: response.status },
    );
  });
  if (!response.ok)
    throw Object.assign(
      new Error(
        response.status === 401 && path.startsWith('/providers')
          ? 'Your Abralo session has expired. Reopen Abralo to reconnect to this workspace.'
          : data.error || 'Request failed',
      ),
      { status: response.status },
    );
  return data;
}
