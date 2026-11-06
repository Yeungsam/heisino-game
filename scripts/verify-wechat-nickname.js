// Checks the real WeChat moderation API for one already-authenticated account.
// Runs from this machine, not from the deployed function: cloud profile saving
// and device interaction must still be verified separately.
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { WechatIdentity, validateNickname } = require('../functions/heisino-account/wechat')
const { envId } = require('../cloudbaserc.json')

async function main() {
  const [accountId, input] = process.argv.slice(2)
  if (!/^[a-f0-9]{64}$/.test(accountId || '')) throw new Error('Pass the exact already-authenticated game account ID and proposed nickname.')
  const nickname = validateNickname(input)
  const steps = []
  try {
    const raw = execFileSync('tcb', ['fn', 'detail', 'heisino-account', '--json', '-e', envId], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const details = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).data
    const variables = Object.fromEntries(details.Environment.Variables.map(variable => [variable.Key, variable.Value]))
    if (!variables.WX_APPSECRET || !variables.CLOUDBASE_APIKEY) throw new Error('Missing configuration')
    const cloudbase = require(require.resolve('@cloudbase/node-sdk', { paths: [
      path.join(__dirname, '../functions/heisino-account'), path.join(__dirname, '../functions/heisino-game')
    ] }))
    const result = await cloudbase.init({ env: envId, accessKey: variables.CLOUDBASE_APIKEY }).database()
      .collection('heisino_accounts').doc(accountId).get()
    const account = Array.isArray(result.data) ? result.data[0] : result.data
    if (!account || account.appId !== variables.WX_APPID || !account.openid) throw new Error('Identity mismatch')
    const identity = new WechatIdentity({ appId: variables.WX_APPID, secret: variables.WX_APPSECRET,
      async fetch(url, options) {
        const response = await fetch(url, options)
        const payload = await response.clone().json()
        steps.push({ endpoint: url.pathname, status: response.status,
          code: typeof payload.errcode === 'number' ? payload.errcode : null,
          suggest: payload.result && payload.result.suggest || null })
        return response
      }
    })
    await identity.moderate(nickname, account.openid)
    console.log(JSON.stringify({ origin: 'LOCAL_DIAGNOSTIC', moderation: 'passed', steps,
      profileSaved: false, note: 'This does not save a nickname or verify the cloud function egress or device UI.' }, null, 2))
  } catch (_) {
    console.error(JSON.stringify({ origin: 'LOCAL_DIAGNOSTIC', moderation: 'not_verified', steps,
      note: 'Only endpoint names and numeric upstream codes are shown. Credentials and player identity are suppressed.' }, null, 2))
    process.exitCode = 1
  }
}
main().catch(() => { console.error('Invalid diagnostic input; no identity or credentials were printed.'); process.exitCode = 1 })
