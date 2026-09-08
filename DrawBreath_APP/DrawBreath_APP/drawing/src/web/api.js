import { withBase } from './base';

export async function api(path, options = {}, token = '') {
  const isForm = options.body instanceof FormData;
  let response;
  try {
    response = await fetch(withBase(`/api${path}`), { ...options, headers: { ...(options.body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  } catch {
    throw new Error('The application server is unavailable. Start all services and try again.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent('task-platform:unauthorized', { detail: { token } }));
    const fallback = response.status >= 500
      ? 'The application server is unavailable. Start all services and try again.'
      : 'The request could not be completed.';
    throw new Error(payload.error || fallback);
  }
  return payload;
}
export async function download(path, filename, token = '') {
  const response = await fetch(withBase(`/api${path}`), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (response.status === 401) window.dispatchEvent(new CustomEvent('task-platform:unauthorized', { detail: { token } }));
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || 'The download could not be completed.'); }
  const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function downloadZip(path, filename, token = '') {
  const response = await fetch(withBase(`/api${path}`), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (response.status === 401) window.dispatchEvent(new CustomEvent('task-platform:unauthorized', { detail: { token } }));
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || 'The image archive could not be downloaded.'); }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length <= 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('The downloaded image archive is invalid or empty. Refresh the task and try again.');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export const post = (path, body, token = '') => api(path, { method: 'POST', body: JSON.stringify(body) }, token);
export const put = (path, body, token = '') => api(path, { method: 'PUT', body: JSON.stringify(body) }, token);
export const patch = (path, body, token = '') => api(path, { method: 'PATCH', body: JSON.stringify(body) }, token);
