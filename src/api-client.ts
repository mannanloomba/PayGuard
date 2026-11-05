function csrfToken(): string | null {
  const entry = document.cookie
    .split('; ')
    .find((value) => value.startsWith('payguard_csrf='))
  return entry ? decodeURIComponent(entry.slice('payguard_csrf='.length)) : null
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const apiBase = (import.meta.env.VITE_PAYGUARD_API_URL ?? '').replace(/\/+$/, '')
  const requestUrl = typeof input === 'string' && input.startsWith('/api') && apiBase
    ? `${apiBase}${input}`
    : input
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = csrfToken()
    if (token) headers.set('X-CSRF-Token', token)
  }
  return fetch(requestUrl, {
    ...init,
    headers,
    credentials: 'include',
  })
}
