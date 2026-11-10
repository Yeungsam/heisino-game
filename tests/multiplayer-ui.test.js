const test = require('node:test')
const assert = require('node:assert/strict')
const { simulation, dock, heartbeat, move, center } = require('./helpers/account-ui-simulation')
const { MOVEMENT_REPLAY_LEAD_MS, MOVEMENT_REPLAY_MS } = require('../client/js/core/constants')

async function refresh(app) {
  await app.run('refreshLobby()')
  await app.idle()
}

test('第1轮：大厅满房、释放座位、房主转让、隐藏已开局房间及原子扣仓', async t => {
  const sim = await simulation(t, 4)
  const [host, second, third, spectator] = sim.client
  await Promise.all(sim.client.map(dock))
  await host.tap('lobby_create')
  const roomId = host.run('lobbyRoom.roomId')
  assert.equal(host.hits('lobby_start').length, 0)
  await refresh(second)
  await second.tap('lobby_join', hit => hit.data.roomId === roomId)
  await refresh(third)
  await third.tap('lobby_join', hit => hit.data.roomId === roomId)
  await refresh(spectator)
  assert.match(spectator.draw().join('\n'), /3\/3.*待开始/)
  await spectator.tap('lobby_join', hit => hit.data.roomId === roomId)
  assert.match(spectator.draw().join('\n'), /房间人数已满/)
  assert.equal(spectator.run('lobbyRoom'), null)

  await host.tap('lobby_leave')
  assert.equal(host.run('accountProfile.quantities.wp_006'), 1)
  assert.equal(spectator.hits('lobby_join')[0].data.playerCount, 3, '保留上一帧房间列表以模拟网络延迟')
  await spectator.tap('lobby_join', hit => hit.data.roomId === roomId)
  assert.equal(spectator.run('lobbyRoom?.roomId'), roomId, '显示过期的满房人数时由服务端核准当前座位')

  await refresh(second)
  assert.equal(second.run('lobbyRoom.isHost'), true)
  assert.equal(third.hits('lobby_start').length, 0)
  await second.tap('lobby_start')
  await Promise.all([third, spectator, host].map(refresh))
  assert.ok([second, third, spectator].every(app => app.run('accountGame.gameId') === roomId))
  assert.equal(host.run('scene'), 'LOBBY')
  assert.ok(!host.draw().includes('测试玩家2的房间'))
  await host.tap('lobby_toggle_playing')
  assert.ok(host.draw().includes('测试玩家2的房间'))
  assert.equal(host.hits('lobby_join').length, 0)
  const deployed = [...sim.store.ledger.values()].filter(entry => entry.gameId === roomId && entry.type === 'DEPLOY')
  assert.equal(deployed.length, 3)
  assert.ok([second, third, spectator].every(app => app.run('accountProfile.quantities.wp_006') === 0))
})

async function startTogether(apps) {
  const [host, ...guests] = apps
  await Promise.all(apps.map(dock))
  await host.tap('lobby_create')
  const roomId = host.run('lobbyRoom.roomId')
  for (const app of guests) {
    await refresh(app)
    await app.tap('lobby_join', hit => hit.data.roomId === roomId)
  }
  await refresh(host)
  await host.tap('lobby_start')
  await Promise.all(guests.map(refresh))
  assert.ok(apps.every(app => app.run('accountGame.gameId') === roomId))
  return roomId
}

async function finishReplay(sim, apps) {
  sim.tick(MOVEMENT_REPLAY_LEAD_MS + MOVEMENT_REPLAY_MS)
  apps.forEach(app => app.run('update()'))
  await Promise.all(apps.map(app => app.idle()))
}

test('第2轮：三端移动截止、等待界面与回合超时', async t => {
  const sim = await simulation(t)
  const [host, late, third] = sim.client
  const roomId = await startTogether(sim.client)
  await move(host, 1, 0)
  await third.tap('confirm_move')
  assert.match(host.draw().join('\n'), /等待其他玩家/)
  assert.equal(host.hits('confirm_move').length, 0)
  assert.ok(late.read('accountGame.state.players').filter(player => player.id !== 'P1').every(player => !player.position))
  await late.tap('map_node', hit => hit.data.x === 1 && hit.data.y === 4)
  assert.match(late.draw().join('\n'), /目标：仓库/)
  const oldConfirm = late.hits('confirm_move')[0].rect
  late.touch('start', ...center(oldConfirm))

  sim.tick(15000)
  late.touch('end', oldConfirm.x + oldConfirm.width / 2, oldConfirm.y + oldConfirm.height / 2)
  await late.idle()
  assert.equal(late.requests.filter(req => req.input?.action === 'move').length, 0)
  assert.equal(late.hits('confirm_move').length, 0, '倒计时归零后不可提交移动')
  assert.equal(late.hits('map_node').length, 0)
  assert.match(late.draw().join('\n'), /同步回合/)

  await Promise.all(sim.client.map(heartbeat))
  assert.ok(sim.client.every(app => app.run('presentation') === 'REPLAY'))
  assert.equal(late.read('movementReplay.tracks').filter(track => track.isSelf)[0].to.y, 4)
  await finishReplay(sim, sim.client)
  assert.ok(sim.client.every(app => app.run('presentation') === 'ROOM'))
  assert.deepEqual(late.read('engine.getPlayer("P1").position'), { x: 0, y: 4 })
  assert.equal(host.run('searchVisitState.visit.roomNodeId'), 'n_1_0')
  await host.tap('room_leave')
  await third.tap('room_leave')
  assert.match(host.draw().join('\n'), /等待其他玩家/)
  assert.equal(sim.store.rooms.get(roomId).game.state.turn, 1)
  sim.tick(50000)
  await Promise.all(sim.client.map(heartbeat))
  assert.ok(sim.client.every(app => app.run('engine.turn === 2 && presentation === "MAP"')))
  assert.ok(sim.client.every(app => app.draw().includes('第 2 回合开始')))
  assert.ok(sim.client.every(app => app.hits('confirm_move').length === 1))
})

test('多人移动优先于慢心跳，重按只提交一次且旧回包不能覆盖新位置', async t => {
  const sim = await simulation(t, 2)
  const [host] = sim.client
  const heartbeatArrived = Promise.withResolvers()
  const releaseHeartbeat = Promise.withResolvers()
  const releaseMove = Promise.withResolvers()
  let delayHeartbeat = false
  const guest = await sim.mount(1, { blockResponse(req) {
    if (delayHeartbeat && req.route.endsWith('/heartbeat')) {
      heartbeatArrived.resolve()
      return releaseHeartbeat.promise
    }
    if (req.input?.action === 'move') return releaseMove.promise
  } })
  await startTogether([host, guest])
  await move(host, 1, 0)
  await guest.tap('map_node', hit => hit.data.x === 1 && hit.data.y === 4)
  sim.tick(14500)
  delayHeartbeat = true
  const pendingHeartbeat = guest.run('heartbeatAccount()')
  try {
    await heartbeatArrived.promise
    const confirm = guest.hits('confirm_move')[0]
    await guest.tap('confirm_move', () => true, false)
    assert.ok(guest.draw().includes('正在提交移动…'))
    assert.equal(guest.hits('confirm_move').length, 0)
    guest.run(`handleAction(${JSON.stringify(confirm)})`)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(guest.requests.filter(req => req.input?.action === 'move').length, 1, '不能等心跳结束再发送移动')
    releaseMove.resolve()
    for (let attempt = 0; attempt < 50 && guest.run('accountBusy'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    assert.equal(guest.run('accountBusy'), false)
    assert.equal(guest.run('searchVisitState.visit.roomNodeId'), 'n_1_4')
    sim.tick(600)
  } finally {
    delayHeartbeat = false
    releaseMove.resolve()
    releaseHeartbeat.resolve()
    await pendingHeartbeat
  }
  assert.equal(guest.run('presentation'), 'REPLAY')
  assert.equal(guest.run('searchVisitState.visit.roomNodeId'), 'n_1_4')
  await heartbeat(host)
  await finishReplay(sim, [host, guest])
  await host.tap('room_leave')
  await guest.tap('room_leave')
  assert.equal(guest.run('engine.turn'), 2)
  assert.deepEqual(guest.read('movementPinPosition'), { x: 1, y: 4 })
})

test('多人移动晚到明确提示原地停留，成功回包丢失则原请求重试', async t => {
  const sim = await simulation(t, 2)
  const [host] = sim.client
  let delayClock = false
  let loseMoveReply = false
  const guest = await sim.mount(1, { blockResponse(req) {
    if (delayClock && req.route.endsWith('/heartbeat')) sim.tick(600)
    if (loseMoveReply && req.input?.action === 'move') {
      loseMoveReply = false
      throw new Error('request:fail timeout')
    }
  } })
  await startTogether([host, guest])
  await move(host, 1, 0)
  sim.tick(14500)
  delayClock = true
  await heartbeat(guest)
  delayClock = false
  await move(guest, 1, 4)
  assert.match(guest.run('toast'), /移动超时，本回合原地停留/)
  assert.equal(guest.run('searchVisitState.visit.roomNodeId'), 'n_0_4')
  await heartbeat(host)
  await finishReplay(sim, [host, guest])
  await host.tap('room_leave')
  await guest.tap('room_leave')
  assert.equal(guest.run('engine.turn'), 2)
  assert.deepEqual(guest.read('movementPinPosition'), { x: 0, y: 4 })

  await heartbeat(host)
  loseMoveReply = true
  await move(guest, 1, 4)
  const attempts = guest.requests.filter(req => req.input?.action === 'move' && req.input.turn === 2)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].input.requestId, attempts[1].input.requestId)
  assert.equal(attempts[1].status, 200)
  assert.equal(guest.run('accountGame.waiting'), 'MOVES')
  await move(host, 1, 1)
  await heartbeat(guest)
  assert.equal(guest.run('searchVisitState.visit.roomNodeId'), 'n_1_4')
})

test('所有玩家同屏回放，较晚恢复只播放剩余时间，结束时同步开放房间', async t => {
  const sim = await simulation(t, 2)
  const [host, guest] = sim.client
  await startTogether(sim.client)
  await move(host, 1, 0)
  assert.equal(host.run('movementReplay'), null)
  await guest.tap('confirm_move')
  await heartbeat(host)
  const end = host.run('movementReplay.endsAt')
  assert.equal(guest.run('movementReplay.endsAt'), end)
  assert.ok(host.draw().includes('玩家移动轨迹'))
  assert.ok(host.draw().includes('1  你 · 测试玩家1'))
  assert.ok(host.draw().includes('2  测试玩家2'))
  assert.equal(host.hits('room_area').length, 0)
  assert.equal(host.hits('confirm_move').length, 0)

  sim.tick(MOVEMENT_REPLAY_LEAD_MS + MOVEMENT_REPLAY_MS / 2)
  const recovered = await sim.mount(1)
  await recovered.idle()
  assert.equal(recovered.run('presentation'), 'REPLAY')
  assert.equal(recovered.run('movementReplay.endsAt'), end)
  const replaySnapshot = host.read('accountGame')
  sim.tick(MOVEMENT_REPLAY_MS / 2 - 1)
  host.run('update()')
  recovered.run('update()')
  assert.equal(host.run('presentation'), 'REPLAY')
  assert.equal(recovered.run('presentation'), 'REPLAY')
  host.touch('start', 400, 230)
  sim.tick(1)
  host.run('update()')
  recovered.run('update()')
  assert.equal(host.run('presentation'), 'ROOM')
  assert.equal(recovered.run('presentation'), 'ROOM')
  assert.equal(host.run('searchVisitState.visit.deadlineAt - Date.now()'), 50000)
  assert.equal(recovered.run('searchVisitState.visit.deadlineAt - Date.now()'), 50000)
  host.touch('end', ...center(host.hits('room_leave')[0].rect))
  await host.idle()
  assert.equal(host.requests.some(req => req.input?.action === 'leave'), false, '回放期间开始的触控不能误触离开房间')
  host.run(`applyAccountResponse({activeGame:${JSON.stringify(replaySnapshot)}, profile:accountProfile, revision:accountRevision, serverNow:Date.now()})`)
  assert.equal(host.run('presentation'), 'ROOM', '迟到的回放数据不能重复播放')
  await Promise.all([host.idle(), recovered.idle()])
})

test('第3轮：三人同房分流、真实拖拽拾取与搜索换轮', async t => {
  const sim = await simulation(t)
  const roomId = await startTogether(sim.client)
  const routes = [
    [[1, 0], [1, 1], [1, 1], [1, 1]],
    [[1, 4], [1, 3], [1, 2], [1, 1]],
    [[3, 0], [2, 0], [2, 1], [1, 1]]
  ]
  for (let step = 0; step < routes[0].length; step += 1) {
    await Promise.all(sim.client.map((app, index) => move(app, ...routes[index][step])))
    await Promise.all(sim.client.map(heartbeat))
    assert.ok(sim.client.every(app => app.run('presentation') === 'REPLAY'))
    assert.ok(sim.client.every(app => app.run('movementReplay.tracks.length') === 3))
    await finishReplay(sim, sim.client)
    if (step < routes[0].length - 1) {
      await Promise.all(sim.client.map(app => app.tap('room_leave')))
      await Promise.all(sim.client.map(heartbeat))
    }
  }
  const winner = sim.client.find(app => app.run('presentation') === 'BATTLE')
  const searcher = sim.client.find(app => app.run('presentation') === 'ROOM')
  const loser = sim.client.find(app => app.run('presentation') === 'SETTLEMENT')
  assert.ok(winner && searcher && loser)
  assert.match(winner.draw().join('\n'), /战斗胜利/)
  assert.equal(loser.run('accountSettlement.status'), 'DEFEATED')
  assert.match(loser.draw().join('\n'), /失\s*败/)
  await winner.tap('battle_continue')
  await winner.tap('room_area', hit => hit.data === 'MAIN_TABLE')
  await searcher.tap('room_area', hit => hit.data === 'MAIN_TABLE')
  const dropped = sim.store.rooms.get(roomId).game.state.items.find(item => item.state === 'DROPPED' && item.cardId === 'wp_006')
  assert.ok(dropped)
  winner.draw()
  const roomCard = winner.read('ui.searchItemRects').find(rect => rect.instanceId === dropped.instanceId)
  assert.ok(roomCard)
  searcher.draw()
  assert.ok(searcher.read('ui.searchItemRects').every(rect => rect.instanceId !== dropped.instanceId))
  await assert.rejects(searcher.api.command('game', { gameId: roomId, turn: 4, action: 'pickup', instanceId: dropped.instanceId }), { code: 'ITEM_NOT_VISIBLE' })
  const [startX, startY] = center(roomCard)
  const [bagX, bagY] = center(winner.read('ui.searchBackpackRect'))
  winner.touch('start', startX, startY)
  winner.touch('move', bagX, startY)
  winner.touch('end', bagX, bagY)
  await winner.idle()
  assert.match(winner.draw().join('\n'), /物资已收入背包/)
  const duplicateSlots = winner.read('ui.searchInventoryRects').filter(slot => slot.cardId === 'wp_006')
  assert.equal(duplicateSlots.length, 2)
  assert.notEqual(duplicateSlots[0].x, duplicateSlots[1].x)
  assert.notEqual(duplicateSlots[0].instanceId, duplicateSlots[1].instanceId)

  const [x, y] = center(winner.read('ui.searchInventoryRects')[0])
  winner.touch('start', x, y)
  winner.touch('move', x + 25, y)
  assert.ok(winner.run('searchDragging'))
  sim.tick(50000)
  await Promise.all([winner, searcher].map(heartbeat))
  assert.equal(winner.run('engine.turn'), 5)
  assert.equal(winner.run('presentation'), 'MAP')
  const confirm = winner.hits('confirm_move')[0]
  assert.ok(confirm)
  winner.touch('end', ...center(confirm.rect))
  await winner.idle()
  assert.equal(winner.requests.filter(req => req.input?.action === 'move' && req.input.turn === 5).length, 0,
    '上轮搜索拖拽的抬手不能触发新一轮的确认移动')
  assert.equal(winner.run('searchDragging'), null)
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('第4轮：断线恢复与迟到响应不会把玩家拉回已离开的结算', { timeout: 8000 }, async t => {
  const sim = await simulation(t, 2)
  const host = sim.client[0]
  const received = deferred()
  const release = deferred()
  let resumeToDelay = 0
  const guest = await sim.mount(1, { blockResponse: async req => {
    if (req.route === '/api/account/resume' && resumeToDelay > 0 && --resumeToDelay === 0) {
      received.resolve()
      await release.promise
    }
  } })
  const roomId = await startTogether([host, guest])
  guest.events.hide()
  await guest.idle()
  await move(host, 1, 0)
  sim.tick(15000)
  await heartbeat(host)
  guest.events.show()
  await guest.idle()
  assert.equal(guest.run('accountGame.gameId'), roomId)
  await finishReplay(sim, [host, guest])
  assert.equal(guest.run('presentation'), 'ROOM')
  assert.ok(guest.draw().includes('出生点'))
  await heartbeat(host)

  guest.events.hide()
  await guest.idle()
  sim.tick(599999)
  await heartbeat(host)
  assert.equal(host.run('accountGame.gameId'), roomId)
  assert.ok(host.run('engine.turn') > 1)
  sim.tick(1)
  resumeToDelay = 2
  guest.events.show()
  guest.events.hide()
  guest.events.show()
  try {
    await received.promise
    assert.equal(guest.run('presentation'), 'SETTLEMENT')
    assert.equal(guest.run('accountSettlement.status'), 'DISCONNECTED')
    assert.match(guest.draw().join('\n'), /中断超过 10 分钟/)
    await guest.tap('settlement_home', () => true, false)
    assert.equal(guest.run('scene'), 'HOME')
  } finally { release.resolve() }
  await guest.idle()
  assert.equal(guest.run('scene'), 'HOME', '迟到的前台恢复响应不能覆盖玩家已选择的首页')
  assert.ok(guest.hits('home_start').length)
  assert.equal((await sim.store.get(guest.account.id)).quantities.wp_006, 0)
  await heartbeat(host)
  assert.equal(host.run('accountGame.gameId'), roomId)
})

test('第5轮：独立撤离返仓、连续开局与结算确认防串局', async t => {
  const sim = await simulation(t, 2)
  const [host, guest] = sim.client
  const roomId = await startTogether(sim.client)
  sim.store.rooms.get(roomId).game.state.roomStock.seed = 0
  const route = [[1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2], [4, 3], [4, 4]]
  let lootCardId
  for (const [step, target] of route.entries()) {
    await Promise.all([move(host, ...target), guest.tap('confirm_move')])
    await Promise.all(sim.client.map(heartbeat))
    await finishReplay(sim, sim.client)
    if (step === 0) {
      const areaId = host.read('searchVisitState.room.areas').find(area => area.itemCount > 0).areaId
      await host.tap('room_area', hit => hit.data === areaId)
      sim.tick(2000)
      await heartbeat(host)
      host.draw()
      const [loot] = host.read('ui.searchItemRects')
      assert.ok(loot)
      lootCardId = loot.cardId
      const [x, y] = center(loot)
      const [bagX, bagY] = center(host.read('ui.searchBackpackRect'))
      host.touch('start', x, y)
      host.touch('move', bagX, y)
      host.touch('end', bagX, bagY)
      await host.idle()
      await host.tap('search_finish')
    }
    if (step < route.length - 1) {
      await Promise.all(sim.client.map(app => app.tap('room_leave')))
      await Promise.all(sim.client.map(heartbeat))
    }
  }
  assert.ok(host.draw().includes('撤离点'))
  await host.tap('request_extraction')
  assert.equal(host.run('accountGame.waiting'), 'ROUND')
  await guest.tap('room_leave')
  await heartbeat(host)
  assert.match(host.draw().join('\n'), /撤\s*离\s*成\s*功/)
  assert.equal(host.run('accountSettlement.returned.wp_006'), 1)
  assert.equal(host.read('accountSettlement.returned')[lootCardId], 1)
  assert.equal(host.run('accountProfile.gold'), 0)
  assert.equal(guest.run('accountGame.gameId'), roomId)
  assert.equal(guest.run('engine.turn'), 9)
  const priorSettlement = host.run('accountSettlement.settlementId')
  const originalExtract = host.requests.find(req => req.input?.action === 'extract').input
  await host.api.command('game', originalExtract)
  assert.equal([...sim.store.ledger.values()].filter(entry => entry.accountId === host.account.id && entry.type === 'SETTLEMENT').length, 1)

  await host.tap('settlement_replay')
  assert.equal(host.run('scene'), 'LOADOUT')
  assert.ok(host.hits('loadout_warehouse_card').some(hit => hit.data === 'wp_006'))
  await host.tap('loadout_match')
  await host.tap('lobby_single')
  assert.equal(host.run('accountGame.mode'), 'SINGLE')
  assert.equal(host.read('accountGame.state.players').length, 1)
  await host.tap('account_abandon')
  assert.equal(host.run('accountSettlement.status'), 'ABANDONED')
  const newestSettlement = host.run('accountSettlement.settlementId')
  assert.notEqual(newestSettlement, priorSettlement)
  await host.api.command('acknowledge', { settlementId: priorSettlement, requestId: 'late-settlement-ack' })
  await host.api.command('acknowledge')
  const restarted = await sim.mount(0)
  assert.equal(restarted.run('scene'), 'GAME', '旧对局的确认重发不能跳过新对局的结算界面')
  assert.equal(restarted.run('accountSettlement.settlementId'), newestSettlement)
  assert.match(restarted.draw().join('\n'), /已放弃对局/)
  assert.equal(host.requests.find(req => req.route === '/api/account/acknowledge').input.settlementId, priorSettlement)
  assert.equal((await sim.store.get(host.account.id)).quantities[lootCardId], 1)
  await restarted.tap('settlement_home')
  assert.equal((await sim.mount(0)).run('scene'), 'HOME')
})
