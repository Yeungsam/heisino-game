const { fault } = require('./wechat')

function send(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Request-Id'
  })
  response.end(status === 204 ? '' : JSON.stringify(payload))
}
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    chunks.push(chunk)
    size += chunk.length
    if (size > 8192) throw fault('PAYLOAD_TOO_LARGE', 413)
  }
  try {
    const data = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fault('INVALID_JSON')
    return data
  } catch (_) { throw fault('INVALID_JSON') }
}
function createAccountHandler(service) {
  const limits = new Map()
  return async function handleAccount(request, response) {
    const startedAt = Date.now()
    const url = new URL(request.url, 'http://localhost')
    const path = url.pathname.replace(/^\/api\/account(?=\/|$)/, '') || '/'
    if (!url.pathname.startsWith('/api/account') && !['/login', '/health', '/me', '/profile', '/start', '/game', '/resume', '/heartbeat', '/suspend', '/acknowledge', '/lobby'].includes(path)) return false
    if (request.method === 'OPTIONS') { send(response, 204, {}); return true }
    if (request.method === 'GET' && path === '/health') { send(response, 200, { ok: true, service: 'heisino-account', schemaVersion: '1.0.0' }); return true }
    try {
      const action = path.slice(1)
      if (!(request.method === 'GET' && action === 'me') && request.method !== 'POST') throw fault('NOT_FOUND', 404)
      // Best-effort abuse protection; upstream gateway limits should also be set.
      if (['login', 'profile'].includes(action)) {
        const now = Date.now()
        const key = `${request.socket.remoteAddress}:${action}`
        const entry = limits.get(key)
        const next = !entry || now - entry.at > 60000 ? { at: now, count: 1 } : { at: entry.at, count: entry.count + 1 }
        limits.set(key, next)
        if (limits.size > 10000) for (const [id, value] of limits) if (now - value.at > 60000) limits.delete(id)
        if (next.count > 30) throw fault('TOO_MANY_REQUESTS', 429)
      }
      const body = request.method === 'POST' ? await readBody(request) : {}
      const token = String(request.headers.authorization || '').replace(/^Bearer /, '')
      const data = action === 'login' ? await service.login(body.code) : await service.execute(token, action, body)
      response.setHeader('Server-Timing', `app;dur=${Date.now() - startedAt}`)
      response.setHeader('Access-Control-Expose-Headers', 'Server-Timing')
      send(response, 200, { ok: true, data })
    } catch (error) {
      send(response, error.statusCode || 500, { ok: false, error: error.code && error.statusCode ? error.code : 'INTERNAL_ERROR' })
    }
    return true
  }
}

module.exports = { createAccountHandler }
