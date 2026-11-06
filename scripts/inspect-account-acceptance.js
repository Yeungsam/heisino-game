// Read-only acceptance evidence for one explicitly selected account.
// Credentials, OpenID, tokens and full match state are never printed.
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { envId } = require('../cloudbaserc.json')

async function main() {
  const accountId = process.argv[2]
  if (!/^[a-f0-9]{64}$/.test(accountId || '')) throw new Error('Pass the exact game account ID; no accounts are enumerated.')
  let apiKey
  try {
    const raw = execFileSync('tcb', ['fn', 'detail', 'heisino-account', '--json', '-e', envId], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    })
    const details = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).data
    apiKey = details.Environment.Variables.find(variable => variable.Key === 'CLOUDBASE_APIKEY')?.Value
    if (!apiKey) throw new Error('Database credential is not configured.')
    const cloudbase = require(require.resolve('@cloudbase/node-sdk', { paths: [
      path.join(__dirname, '../functions/heisino-account'), path.join(__dirname, '../functions/heisino-game')
    ] }))
    const db = cloudbase.init({ env: envId, accessKey: apiKey }).database()
    const result = await db.collection('heisino_accounts').doc(accountId).get()
    const account = Array.isArray(result.data) ? result.data[0] : result.data
    if (!account) throw new Error('Selected account was not found.')
    const counts = {}
    for (const entry of account.ledger || []) counts[entry.type] = (counts[entry.type] || 0) + 1
    console.log(JSON.stringify({
      environment: envId, account: `${accountId.slice(0, 8)}…`,
      profileComplete: account.profileComplete, nickname: account.nickname,
      avatar: account.avatarUrl ? 'CUSTOM' : 'DEFAULT', quantities: account.quantities, gold: account.gold,
      starterVersion: account.starterVersion, recentLedgerCounts: counts,
      activeGame: account.activeGame ? { gameId: account.activeGame.gameId, turn: account.activeGame.state.turn,
        phase: account.activeGame.state.phase } : null,
      lastSettlement: account.lastSettlement ? { status: account.lastSettlement.status,
        success: account.lastSettlement.success, returned: account.lastSettlement.returned,
        goldDelta: account.lastSettlement.goldDelta } : null
    }, null, 2))
  } catch (_) {
    // SDK/CLI exception messages can contain credentials or identity information.
    throw new Error('Selected account inspection failed; sensitive details were suppressed.')
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
