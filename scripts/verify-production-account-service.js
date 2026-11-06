const assert = require('node:assert/strict')
const { gameApiBaseUrl } = require('../client/js/config')

async function check(pathname, expectedStatus, expectedError) {
  const response = await fetch(`${gameApiBaseUrl}/api/account${pathname}`, { signal: AbortSignal.timeout(15000) })
  const payload = await response.json()
  assert.equal(response.status, expectedStatus)
  if (expectedError) assert.equal(payload.error, expectedError)
  return payload
}

async function main() {
  const health = await check('/health', 200)
  assert.equal(health.service, 'heisino-account')
  await check('/me', 401, 'UNAUTHENTICATED')
  const response = await fetch(`${gameApiBaseUrl}/api/account/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'deployment-smoke-invalid-code' }), signal: AbortSignal.timeout(15000)
  })
  const payload = await response.json()
  const state = response.status === 503 && payload.error === 'WECHAT_NOT_CONFIGURED' ? 'WX_APPSECRET_REQUIRED'
    : response.status === 401 && payload.error === 'LOGIN_CODE_INVALID' ? 'WECHAT_EXCHANGE_REACHABLE' : 'UNEXPECTED_LOGIN_RESPONSE'
  assert.notEqual(state, 'UNEXPECTED_LOGIN_RESPONSE', `Unexpected login response: ${response.status} ${payload.error || 'unknown'}`)
  console.log(JSON.stringify({ health: 'passed', authenticationGuard: 'passed', wechatConfiguration: state,
    realWechatLoginVerified: false, note: 'Real login and profile moderation require an actual WeChat login and cannot be inferred from health checks.' }, null, 2))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
