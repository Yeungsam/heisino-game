const test = require('node:test')
const assert = require('node:assert/strict')
const { simulation, dock, heartbeat, move, center } = require('./helpers/account-ui-simulation')
const { ASSETS } = require('../client/js/ui/combat-screen')
const fs = require('node:fs')
const path = require('node:path')

test('对战界面引用的 Figma 图层均已包含在小游戏战斗分包', () => {
  const { subpackages } = require('../client/game.json')
  const root = subpackages.find(pkg => pkg.name === 'combat')?.root
  assert.ok(root)
  for (const asset of ASSETS) {
    const data = fs.readFileSync(path.resolve(__dirname, '../client', root, 'assets', `${asset}.png`))
    assert.equal(data.subarray(1, 4).toString(), 'PNG', asset)
    assert.ok(data.readUInt32BE(16) && data.readUInt32BE(20), asset)
  }
})

test('微信触控完成守卫战掷骰、技能预览拖用、骰子分配和战后窗口切换', async t => {
  const sim = await simulation(t, 1, { combatVersion: 1 })
  const [app] = sim.client
  await app.tap('home_start')
  for (const id of ['wp_006', 'sk_001']) {
    await app.tap('loadout_warehouse_card', hit => hit.data === id)
    await app.tap('loadout_warehouse_card', hit => hit.data === id)
  }
  await app.tap('loadout_match')
  await app.tap('lobby_single')
  const edit = async update => {
    const doc = await sim.store.get(app.account.id)
    update(doc.activeGame)
    assert.ok(await sim.store.replace({ ...doc, version: doc.version + 1 }, doc.version))
  }
  await edit(game => { game.rngState = 0 })
  await move(app, 1, 0)
  assert.equal(app.run('presentation'), 'BATTLE')
  assert.ok(app.draw().includes('赌场守卫'))
  assert.ok(app.draw().includes('会客厅'))
  assert.equal(app.hits('combat_ready').length, 0)
  assert.equal(app.hits('combat_roll').length, 1)
  await app.tap('combat_roll')
  assert.equal(app.hits('combat_roll').length, 0)
  assert.equal(app.hits('combat_die').length, 3)

  await app.tap('combat_skills')
  await app.tap('combat_skill')
  assert.match(app.draw().join(' '), /对子加倍/)
  const drag = async (hit, end) => {
    app.touch('start', ...center(hit.rect))
    app.touch('move', ...end)
    app.touch('end', ...end)
    await app.idle()
  }
  await drag(app.hits('combat_skill')[0], center(app.read('combatLayout.drop')))
  assert.match(app.draw().join(' '), /本期不产生效果/)
  assert.equal(app.hits('combat_skills').length, 0)
  assert.ok(app.draw().includes('技能卡槽'))
  assert.equal(app.run('interactiveBattle.self.dice.length'), 3)
  await app.tap('combat_die', hit => hit.data === 0)
  await app.tap('combat_zone', hit => hit.data === 'DEFENSE')
  assert.equal(app.run('interactiveBattle.self.dice[0].zone'), 'DEFENSE')
  await drag(app.hits('combat_die').find(hit => hit.data === 0), center(app.read('combatLayout.zones.TRAY')))
  assert.equal(app.run('interactiveBattle.self.dice[0].zone'), 'TRAY')

  await edit(game => {
    game.state.players[1].hp = 1
    game.combat.sides.P1.dice.forEach(die => { die.value = 6 })
    game.combat.sides.P2.dice = [{ value: 1, zone: 'ATTACK' }, { value: 1, zone: 'DEFENSE' }, { value: 1, zone: 'DEFENSE' }]
  })
  await heartbeat(app)
  for (let i = 0; i < 3; i++) {
    const die = app.hits('combat_die').find(hit => hit.data === i)
    await drag(die, center(app.read('combatLayout.zones.ATTACK')))
  }
  assert.equal(app.hits('combat_ready').length, 1)
  await app.tap('combat_ready')
  assert.equal(app.hits('combat_ready').length, 0)
  assert.equal(app.run('interactiveBattle.stage'), 'IMPACT')
  sim.tick(1000)
  await heartbeat(app)
  assert.ok(app.draw().includes('战斗胜利'))
  sim.tick(2000)
  await heartbeat(app)
  assert.equal(app.run('presentation'), 'ROOM')
  assert.ok(app.draw().includes('战利品搜索'))
  await app.tap('room_area', hit => hit.data === 'MAIN_TABLE')
  assert.ok(app.draw().includes('战利品立即揭示'))
  assert.ok(app.read('searchVisitState.room.activeArea.visibleItems').some(item => item.cardId === 'ar_013'))
})

test('真人战斗同场就绪、旧快照防回退及第三位玩家搜索并行', async t => {
  const sim = await simulation(t, 3, { combatVersion: 1 })
  const [host, second, third] = sim.client
  for (const player of sim.client) await dock(player)
  await host.tap('lobby_create')
  for (const player of [second, third]) {
    await player.run('refreshLobby()')
    await player.idle()
    await player.tap('lobby_join')
  }
  await host.run('refreshLobby()')
  await host.idle()
  await host.tap('lobby_start')
  const roomId = host.run('accountGame.gameId')
  await sim.store.transactRoom(async tx => {
    const room = await tx.room(roomId)
    for (const player of room.game.state.players) player.position = { x: 1, y: 0 }
    tx.saveRoom(room)
  })
  for (const player of sim.client) {
    if (player.run('scene') === 'LOBBY') { await player.run('refreshLobby()'); await player.idle() }
    await heartbeat(player)
    await move(player, 1, 0)
  }
  for (const player of sim.client) await heartbeat(player)
  assert.ok(sim.client.every(player => player.run('presentation') === 'REPLAY'))
  sim.tick(1800)
  for (const player of sim.client) { player.run('update()'); await heartbeat(player) }
  const fighters = sim.client.filter(player => player.run('presentation') === 'BATTLE')
  const searchers = sim.client.filter(player => player.run('presentation') === 'ROOM')
  assert.equal(fighters.length, 2)
  assert.equal(searchers.length, 1)
  const [a, b] = fighters
  const old = await a.api.command('resume')
  for (const player of fighters) {
    await player.tap('combat_roll')
    for (let i = 0; i < 3; i++) {
      await player.tap('combat_die', hit => hit.data === i)
      await player.tap('combat_zone', hit => hit.data === 'DEFENSE')
    }
    await player.tap('combat_ready')
  }
  a.run(`applyAccountResponse(${JSON.stringify(old)})`)
  assert.equal(a.run('interactiveBattle.self.ready'), true)
  assert.equal(a.run('interactiveBattle.self.dice.length'), 3)
  assert.equal(b.run('interactiveBattle.stage'), 'IMPACT')
  assert.equal(searchers[0].run('presentation'), 'ROOM')
})
