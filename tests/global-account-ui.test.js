const test = require('node:test')
const assert = require('node:assert/strict')
const { simulation, dock } = require('./helpers/account-ui-simulation')

test('会话续期遇到微信账号切换时，旧战备操作不能扣除新账号的库存', async t => {
  const sim = await simulation(t, 2)
  const [oldAccount, newAccount] = sim.accounts
  let identity = oldAccount.code
  const player = await sim.mount(0, { loginCode: () => identity })
  await dock(player)
  sim.store.documents.get(oldAccount.id).sessions = []
  identity = newAccount.code

  await player.tap('lobby_single')
  for (const { id } of [oldAccount, newAccount]) {
    const account = await sim.store.get(id)
    assert.equal(Boolean(account.activeGame), false)
    assert.equal(account.quantities.wp_006, 1)
    assert.ok(!account.ledger.some(entry => entry.type === 'DEPLOY'))
  }
  assert.equal(player.requests.filter(req => req.route === '/api/account/start').length, 1)
  player.run('update()')
  assert.equal(player.run('scene'), 'LOGIN')
  assert.match(player.draw().join('\n'), /微信账号已切换/)
  await player.tap('account_retry')
  assert.equal(player.run('accountProfile.accountId'), newAccount.id)
  assert.equal(player.run('scene'), 'HOME')
})
