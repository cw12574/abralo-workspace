export async function api(path: string, body?: any, method?: string, signal?: AbortSignal) {
  const response = await fetch('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      'x-workspace-request': '1',
      // A body-less request (e.g. DELETE) must not claim JSON, or the server rejects it.
      ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error || 'Request failed'), { status: response.status });
  return data;
}
