const assert = require('node:assert/strict')
const { gameApiBaseUrl } = require('../client/js/config')

async function request(pathname, options) {
  return fetch(`${gameApiBaseUrl}/api/account${pathname}`, { signal: AbortSignal.timeout(15000), ...options })
}

async function check(pathname, expectedStatus, expectedError, options) {
  const response = await request(pathname, options)
  const endpoint = `${options?.method || 'GET'} /api/account${pathname}`
  assert.equal(response.status, expectedStatus, `${endpoint} 返回 HTTP ${response.status}，预期 ${expectedStatus}`)
  const payload = await response.json()
  if (expectedError) assert.equal(payload.error, expectedError, `${endpoint} 返回 ${payload.error}，预期 ${expectedError}`)
  return payload
}

async function main() {
  const health = await check('/health', 200)
  assert.equal(health.service, 'heisino-account')
  await check('/me', 401, 'UNAUTHENTICATED')
  await check('/lobby', 401, 'UNAUTHENTICATED', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'list' })
  })
  const preflight = await request('/lobby', {
    method: 'OPTIONS', headers: {
      Origin: 'https://servicewechat.com', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization'
    }
  })
  assert.equal(preflight.status, 204, `OPTIONS /api/account/lobby 返回 HTTP ${preflight.status}，预期 204`)
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /\bPOST\b/i)
  await check('/login', 401, 'LOGIN_CODE_INVALID', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'deployment-smoke-invalid-code' })
  })
  console.log(JSON.stringify({ health: 'passed', authenticationGuard: 'passed', lobbyRoute: 'passed',
    lobbyPreflight: 'passed', wechatConfiguration: 'WECHAT_EXCHANGE_REACHABLE',
    realWechatLoginVerified: false, note: 'Real login and profile moderation require an actual WeChat login and cannot be inferred from health checks.' }, null, 2))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
