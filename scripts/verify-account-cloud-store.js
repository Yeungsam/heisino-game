// Creates only uniquely named deployment probes; deletes those same probes in
// finally. No real player identity, session or asset is read or modified.
const assert = require('node:assert/strict')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { CloudAccountStore } = require('../functions/heisino-account/store')
const { envId } = require('../cloudbaserc.json')

async function main() {
  let apiKey = ''
  let store
  const probe = `deployment-probe-${crypto.randomUUID()}`
  const entryId = `${probe}-ledger`
  let created = false
  try {
    const raw = execFileSync('tcb', ['fn', 'detail', 'heisino-account', '--json', '-e', envId], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const details = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
    apiKey = details.data.Environment.Variables.find(variable => variable.Key === 'CLOUDBASE_APIKEY')?.Value
    assert.ok(apiKey, 'Account function database configuration is missing')
    const cloudbase = require(require.resolve('@cloudbase/node-sdk', { paths: [
      path.join(__dirname, '../functions/heisino-account'), path.join(__dirname, '../functions/heisino-game')
    ] }))
    store = new CloudAccountStore({ cloudbase, app: cloudbase.init({ env: envId, accessKey: apiKey }) })
    const document = { accountId: probe, version: 1, quantities: {}, sessions: [], createdAt: Date.now(),
      ledger: [{ entryId, accountId: probe, type: 'DEPLOYMENT_PROBE', quantities: {}, at: Date.now() }] }
    assert.equal(await store.create(document), true)
    created = true
    const loaded = await store.get(probe)
    assert.equal(loaded.accountId, probe)
    assert.equal(await store.replace({ ...loaded, version: 2 }, 1), true)
    assert.equal(await store.replace({ ...loaded, version: 2 }, 1), false)
    const ledger = await store.db.collection('heisino_asset_ledger').doc(entryId).get()
    assert.ok(ledger.data)
    console.log('Cloud account store: create, read, transaction, version conflict and asset ledger verified.')
  } catch (error) {
    const message = String(error.message || 'Database probe failed')
    console.error(apiKey ? message.split(apiKey).join('[REDACTED]') : 'Database configuration check failed.')
    process.exitCode = 1
  } finally {
    if (created && store && /^deployment-probe-[a-f0-9-]+$/.test(probe)) {
      try {
        await store.db.collection('heisino_accounts').doc(probe).remove()
        await store.db.collection('heisino_asset_ledger').doc(entryId).remove()
        console.log('The two deployment probe documents were removed; no player assets were changed.')
      } catch (_) { console.error(`Deployment probe cleanup pending: ${probe}`); process.exitCode = 1 }
    }
  }
}
main().catch(() => { console.error('Cloud store probe failed.'); process.exitCode = 1 })
