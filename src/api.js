let csrfToken = null;

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.fields = options.fields || [];
    this.code = options.code;
  }
}

export function setCsrfToken(value) {
  csrfToken = value || null;
}

async function readJsonResponse(response) {
  let payload = null;
  if (response.status !== 204) {
    try { payload = await response.json(); } catch { payload = null; }
  }
  if (!response.ok) {
    throw new ApiError(payload?.error || 'The console could not complete that request.', {
      status: response.status,
      fields: payload?.fields,
      code: payload?.code,
    });
  }
  if (payload?.csrfToken) setCsrfToken(payload.csrfToken);
  return payload;
}

export async function api(path, options = {}) {
  const method = options.method || 'GET';
  const response = await fetch(`/api/console${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken && method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  return readJsonResponse(response);
}

export async function apiForm(path, formData, options = {}) {
  const method = options.method || 'POST';
  const response = await fetch(`/api/console${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...options.headers,
    },
    body: formData,
    signal: options.signal,
  });
  return readJsonResponse(response);
}

export async function downloadFile(path, fileName) {
  const response = await fetch(`/api/console${path}`, { credentials: 'same-origin' });
  if (!response.ok) return readJsonResponse(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName || 'contract.pdf';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
