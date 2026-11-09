const config = require('../config')
const { networkFailure } = require('./connection-diagnostics')
const TOKEN_KEY = 'heisino.account.session.v1'
let session = null
let identityChanged = false
let queue = Promise.resolve()
let heartbeatQueue = Promise.resolve()
let renewingSession = null
const performanceSamples = []
function recordPerformance(action, queuedAt, startedAt, response) {
  const headers = response && response.header || {}
  const timingKey = Object.keys(headers).find(key => key.toLowerCase() === 'server-timing')
  const match = String(timingKey && headers[timingKey] || '').match(/app;dur=([\d.]+)/)
  const publicAction = ['login', 'profile', 'me', 'start', 'game', 'heartbeat', 'suspend', 'resume', 'acknowledge', 'lobby'].includes(action) ? action : 'OTHER'
  const sample = { action: publicAction, queueMs: Math.max(0, startedAt - queuedAt), requestMs: Math.max(0, Date.now() - startedAt),
    serverMs: match ? Number(match[1]) : null, status: response && response.statusCode || 0 }
  performanceSamples.push(sample)
  if (performanceSamples.length > 60) performanceSamples.shift()
  // Public timings only: no payload, URL, login code, identity or bearer token.
  if (sample.requestMs + sample.queueMs >= 800) console.warn('[account-perf]', JSON.stringify(sample))
}
try { session = wx.getStorageSync(TOKEN_KEY) || null } catch (_) {}

function requestId() { return `req-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}` }
function request(action, data, method = 'POST', queuedAt = Date.now()) {
  const startedAt = Date.now()
  const background = action === 'heartbeat' || (action === 'lobby' && data.op === 'list')
  return new Promise((resolve, reject) => wx.request({
    url: `${config.gameApiBaseUrl}/api/account/${action}`, method, data,
    timeout: background ? 4000 : 18000,
    header: { 'Content-Type': 'application/json', Authorization: session ? `Bearer ${session.token}` : '' },
    success(response) {
      recordPerformance(action, queuedAt, startedAt, response)
      if (response.statusCode === 200 && response.data && response.data.ok) return resolve(response.data.data)
      const code = response.statusCode === 404 ? 'ACCOUNT_UNAVAILABLE' : response.data && response.data.error || 'ACCOUNT_UNAVAILABLE'
      reject(Object.assign(new Error(code), { code, statusCode: response.statusCode }))
    },
    fail(result) {
      recordPerformance(action, queuedAt, startedAt)
      const failure = networkFailure(result, config.gameApiBaseUrl)
      reject(Object.assign(new Error(failure.code), failure))
    }
  }))
}

function sessionAccountId() {
  return session?.accountId || (/^[a-f0-9]{64}\./.test(session?.token) ? session.token.split('.')[0] : null)
}

function changedAccountError() {
  return Object.assign(new Error('ACCOUNT_CHANGED'), { code: 'ACCOUNT_CHANGED' })
}

function requireAccount(accountId) {
  if (identityChanged || (accountId && accountId !== sessionAccountId())) throw changedAccountError()
}

async function login(expectedAccountId) {
  // Verify the currently signed-in WeChat identity on every cold launch; a
  // cached game token must not carry an old WeChat user's assets into a new one.
  const code = await new Promise((resolve, reject) => wx.login({
    success(result) { result.code ? resolve(result.code) : reject(Object.assign(new Error('LOGIN_FAILED'), { code: 'LOGIN_FAILED' })) },
    fail() { reject(Object.assign(new Error('LOGIN_FAILED'), { code: 'LOGIN_FAILED' })) }
  }))
  const result = await request('login', { code })
  const accountId = result.profile?.accountId
  if (expectedAccountId && accountId !== expectedAccountId) {
    session = null
    identityChanged = true
    throw changedAccountError()
  }
  session = { token: result.token, expiresAt: result.expiresAt, accountId }
  identityChanged = false
  try { wx.setStorageSync(TOKEN_KEY, session) } catch (_) {}
  return result
}

function command(action, data = {}, { bypassHeartbeat = false } = {}) {
  // Retries reuse the exact payload and id. Only time-sensitive moves and their recovery bypass a heartbeat.
  const input = { ...data, requestId: data.requestId || requestId() }
  const queuedAt = Date.now()
  const accountId = sessionAccountId()
  const background = action === 'heartbeat' || (action === 'lobby' && input.op === 'list')
  const run = async () => {
    requireAccount(accountId)
    const sentSession = session
    let response
    try { response = await request(action, input, 'POST', queuedAt) } catch (error) {
      requireAccount(accountId)
      if (error.statusCode === 401) {
        if (session === sentSession && !renewingSession) {
          renewingSession = login(accountId).finally(() => { renewingSession = null })
        }
        await renewingSession
        requireAccount(accountId)
      } else if (error.code !== 'NETWORK_ERROR' || background) throw error
      response = await request(action, input)
    }
    requireAccount(accountId)
    return response
  }
  const ready = bypassHeartbeat ? queue : Promise.all([queue, heartbeatQueue])
  const next = ready.then(run)
  if (action === 'heartbeat') heartbeatQueue = next.catch(() => {})
  else queue = next.catch(() => {})
  return next
}

module.exports = { login, command, requestId, requiresLogin: () => identityChanged, getPerformanceSamples: () => performanceSamples.map(sample => ({ ...sample })) }
