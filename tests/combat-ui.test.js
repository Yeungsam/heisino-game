const test = require('node:test')
const assert = require('node:assert/strict')
const { simulation, dock, heartbeat, move, center, transferLoadoutCard } = require('./helpers/account-ui-simulation')
const { ASSETS, drawCombatScreen } = require('../client/js/ui/combat-screen')
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
  for (const id of ['wp_006', 'sk_001']) await transferLoadoutCard(app, id)
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

  await app.tap('card_preview', hit => hit.previewCardId === 'wp_006')
  assert.equal(app.run('cardPreviewId'), 'wp_006')
  await app.tap('card_preview_close')
  await app.tap('card_preview', hit => hit.previewCardId === 'sk_001')
  assert.equal(app.run('cardPreviewId'), 'sk_001')
  assert.equal(app.run('combatSkillsOpen'), false)
  await app.tap('card_preview_close')
  await app.tap('combat_skills')
  await app.tap('combat_skill')
  assert.equal(app.run('cardPreviewId'), 'sk_001')
  assert.ok(!app.draw().includes('对子加倍'))
  await app.tap('card_preview_close')
  assert.equal(app.run('combatSkillsOpen'), true)
  const drag = async (hit, end) => {
    app.touch('start', ...center(hit.rect))
    app.touch('move', ...end)
    app.touch('end', ...end)
    await app.idle()
  }
  await drag(app.hits('combat_skill')[0], center(app.read('combatLayout.drop')))
  assert.equal(app.run('cardPreviewId'), null)
  assert.match(app.draw().join(' '), /本期不产生效果/)
  assert.equal(app.hits('combat_skills').length, 0)
  assert.ok(app.draw().includes('技能卡槽'))
  assert.equal(app.run('interactiveBattle.self.dice.length'), 3)
  await app.tap('combat_die', hit => hit.data === 0)
  await app.tap('combat_zone', hit => hit.data === 'DEFENSE')
  assert.equal(app.run('combatDice()[0].zone'), 'DEFENSE')
  await drag(app.hits('combat_die').find(hit => hit.data === 0), center(app.read('combatLayout.zones.TRAY')))
  assert.equal(app.run('combatDice()[0].zone'), 'TRAY')

  await edit(game => {
    game.state.players[1].hp = 1
    game.combat.sides.P1.dice.forEach(die => { die.value = 6 })
    game.combat.sides.P2.dice = [{ value: 1, zone: 'ATTACK' }, { value: 1, zone: 'DEFENSE' }]
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
  sim.tick(2000)
  await heartbeat(app)
  assert.ok(app.draw().includes('战斗胜利'))
  assert.ok(!app.draw().includes('骰子托盘'))
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
  const scores = b.read('[interactiveBattle.self.impact, interactiveBattle.opponent.impact]')
  const labels = b.draw()
  assert.ok(labels.includes('你'))
  for (const score of scores) {
    assert.ok(labels.includes(`攻击 ${score.attack}`))
    assert.ok(labels.includes(`防御 ${score.defense}`))
  }
  assert.ok(['掷骰子', '准备就绪', '骰子托盘', '技能卡槽', '放弃对局'].every(label => !labels.includes(label)))
  assert.ok(b.read('ui.hotspots').every(hit => hit.id === 'card_preview'))
  sim.tick(1999)
  await heartbeat(b)
  assert.equal(b.run('interactiveBattle.stage'), 'IMPACT')
  sim.tick(1)
  await heartbeat(b)
  assert.equal(b.run('interactiveBattle.subRound'), 2)
  assert.equal(b.hits('combat_roll').length, 1)
  await b.tap('combat_roll')
  assert.ok(b.draw().includes('骰子托盘'))
  assert.ok(!b.draw().some(label => /双方.*就绪/.test(label)))
})

test('碰撞动画中双方从两侧靠拢一次再退开，血量在接触时才下降', () => {
  const deadlineAt = 2000
  const self = { name: '甲', hp: 25, maxHp: 30, impact: { attack: 5, defense: 0, loss: 5 } }
  const battle = { turn: 1, subRound: 1, stage: 'IMPACT', impactStartedAt: 0, deadlineAt, self, opponent: { ...self, name: '乙' } }
  const drawAt = now => {
    const offsets = [], labels = []
    const gradient = { addColorStop() {} }
    const context = new Proxy({ translate: x => offsets.push(x), createRadialGradient: () => gradient },
      { get: (target, key) => target[key] ?? (() => {}) })
    drawCombatScreen({ context, width: 956, height: 440, assets: {}, now, battle, roomName: '会客厅',
      panel() {}, text: label => labels.push(label), drawCard() {} })
    return { offsets, labels }
  }
  assert.deepEqual(drawAt(0).offsets, [])
  const approach = drawAt(400)
  const contact = drawAt(720)
  const retreat = drawAt(1200)
  assert.ok(approach.offsets[0] > 0 && approach.offsets[1] < 0)
  assert.ok(contact.offsets[0] > approach.offsets[0] && contact.offsets[1] < approach.offsets[1])
  assert.ok(retreat.offsets[0] < contact.offsets[0] && retreat.offsets[1] > contact.offsets[1])
  assert.deepEqual(drawAt(1999).offsets, [])
  assert.ok(approach.labels.includes('HP 30/30'))
  assert.ok(retreat.labels.includes('HP 25/30'))
})

async function enterGuardRoom(sim, seed = 0) {
  const [app] = sim.client
  await dock(app)
  await app.tap('lobby_single')
  const doc = await sim.store.get(app.account.id)
  doc.activeGame.rngState = seed
  assert.ok(await sim.store.replace({ ...doc, version: doc.version + 1 }, doc.version))
  await move(app, 1, 0)
  return app
}

test('守卫首回合两颗骰子都为 1 时仍各有 1 点攻防，结算面板与扣血一致', async t => {
  const sim = await simulation(t, 1, { combatVersion: 1 })
  const app = await enterGuardRoom(sim, 31)
  assert.equal(app.run('interactiveBattle.subRound'), 1)
  sim.tick(15000)
  await heartbeat(app)
  const battle = app.read('interactiveBattle')
  assert.deepEqual(battle.opponent.dice.map(({ value, zone }) => [value, zone]).sort(), [[1, 'ATTACK'], [1, 'DEFENSE']])
  assert.deepEqual(battle.opponent.impact, { attack: 1, defense: 1, loss: 0 })
  assert.equal(battle.self.impact.loss, 1)
  assert.equal(battle.self.hp, 29)
  assert.deepEqual(battle.self.dice, [])
  const labels = app.draw()
  assert.ok(labels.includes('攻击 1'))
  assert.ok(labels.includes('防御 1'))
})

test('第一小回合按下掷骰后跨阶段抬手，下一小回合不会误掷', async t => {
  const sim = await simulation(t, 1, { combatVersion: 1 })
  const app = await enterGuardRoom(sim)
  sim.tick(14900)
  const roll = center(app.hits('combat_roll')[0].rect)
  app.touch('start', ...roll)
  sim.tick(2100)
  await heartbeat(app)
  assert.equal(app.run('interactiveBattle.subRound'), 2)
  assert.equal(app.hits('combat_roll').length, 1)
  app.touch('end', ...roll)
  await app.idle()
  assert.ok(app.requests.every(request => request.input?.action !== 'combat-roll'))
  assert.deepEqual(app.read('interactiveBattle.self.dice'), [])
  await app.tap('combat_roll')
  assert.equal(app.read('interactiveBattle.self.dice').length, 3)
})

test('慢心跳和慢摆放回包不会阻塞后续拖动及就绪', { timeout: 3000 }, async t => {
  const sim = await simulation(t, 1, { combatVersion: 1 })
  await enterGuardRoom(sim)
  let unblock, markHeartbeat, markReady, markLatest
  const blocked = new Promise(resolve => { unblock = resolve })
  const heartbeatReceived = new Promise(resolve => { markHeartbeat = resolve })
  const readyReceived = new Promise(resolve => { markReady = resolve })
  const latestReceived = new Promise(resolve => { markLatest = resolve })
  const app = await sim.mount(0, { blockResponse: async request => {
    if (request.route.endsWith('/heartbeat')) { markHeartbeat(); await blocked }
    if (request.input?.action === 'combat-place' && request.input.placementRevision === 1) await blocked
    if (request.input?.action === 'combat-place' && request.input.placementRevision === 3) markLatest(request)
    if (request.input?.action === 'combat-ready') markReady(request)
  } })
  try {
    await app.tap('combat_roll')
    const delayedHeartbeat = app.run('heartbeatAccount()')
    await heartbeatReceived
    const zones = ['ATTACK', 'DEFENSE', 'DEFENSE']
    for (let i = 0; i < 3; i++) {
      const hit = app.hits('combat_die').find(candidate => candidate.data === i)
      const zone = center(app.read('combatLayout.zones')[zones[i]])
      app.touch('start', ...center(hit.rect))
      app.touch('move', ...zone)
      app.touch('end', ...zone)
    }
    assert.deepEqual(app.read('combatDice().map(die => die.zone)'), zones)
    assert.deepEqual(app.read('interactiveBattle.self.dice.map(die => die.zone)'), ['TRAY', 'TRAY', 'TRAY'])
    assert.deepEqual((await latestReceived).input.zones, zones)
    await app.tap('combat_ready', undefined, false)
    assert.deepEqual((await readyReceived).input.zones, zones)
    unblock()
    await delayedHeartbeat
    await app.idle()
    assert.equal(app.run('interactiveBattle.stage'), 'IMPACT')
    assert.deepEqual(app.read('interactiveBattle.self.dice.map(die => die.zone)'), zones)
  } finally { unblock() }
})

test('未点就绪也同步摆放，重进后按已放进攻防区的骰子结算', async t => {
  const sim = await simulation(t, 1, { combatVersion: 1 })
  const app = await enterGuardRoom(sim)
  await app.tap('combat_roll')
  await app.tap('combat_die', hit => hit.data === 0)
  await app.tap('combat_zone', hit => hit.data === 'DEFENSE')
  const reopened = await sim.mount(0)
  assert.equal(reopened.read('interactiveBattle.self.dice')[0].zone, 'DEFENSE')
  assert.equal(reopened.run('interactiveBattle.self.ready'), false)
  sim.tick(15000)
  await heartbeat(reopened)
  assert.equal(reopened.run('interactiveBattle.stage'), 'IMPACT')
  assert.deepEqual(reopened.read('combatDice().map(die => die.zone)'), ['DEFENSE', 'TRAY', 'TRAY'])
})
