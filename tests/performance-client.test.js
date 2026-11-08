const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { AccountService } = require('../functions/heisino-account/service')
const { MemoryAccountStore } = require('../functions/heisino-account/store')
const cards = require('../client/data/cards')

async function fixture({ active = false, offscreen = true, slowCatalog = false, remoteCards = cards } = {}) {
  let touchStart, touchEnd, hide, show, releaseHeartbeat, frames = 0, arcs = 0, copies = 0
  const labels = [], clipRects = []
  const gradient = { addColorStop() {} }
  const context = new Proxy({}, { get(target, key) {
    if (key in target) return target[key]
    if (key === 'measureText') return value => ({ width: String(value).length * 7 })
    if (key === 'drawImage') return () => { frames += 1 }
    if (key === 'arc') return () => { arcs += 1 }
    if (key === 'fillText') return value => { labels.push(value) }
    if (key === 'rect') return (...args) => { clipRects.push(args) }
    if (String(key).startsWith('create')) return () => gradient
    return () => {}
  } })
  const wx = {
    createCanvas() { if (this.screenCreated && !offscreen) throw new Error('Offscreen unavailable'); this.screenCreated = true; return { getContext: () => context } },
    getWindowInfo: () => ({ windowWidth: 812, windowHeight: 375, pixelRatio: 3 }),
    createImage: () => ({ width: 1920, height: 1080, set src(_) { queueMicrotask(() => { if (this.onload) this.onload() }) } }),
    onTouchStart(handler) { touchStart = handler }, onTouchMove() {}, onTouchEnd(handler) { touchEnd = handler },
    onHide(handler) { hide = handler }, onShow(handler) { show = handler }
  }
  if (offscreen) wx.createOffscreenCanvas = options => ({ ...options, getContext: () => new Proxy({}, { get(_, key) {
    if (key === 'drawImage') return () => { copies += 1 }
    if (key === 'measureText') return value => ({ width: String(value).length * 7 })
    if (String(key).startsWith('create')) return () => gradient
    return () => {}
  } }) })
  const service = new AccountService({ store: new MemoryAccountStore(), identity: {
    exchange: async () => ({ appId: 'wx-performance', openid: 'performance' }), moderate: async () => true
  } })
  const login = await service.login('test-only')
  let response = await service.execute(login.token, 'profile', { nickname: '性能验收', avatarUrl: '' })
  if (active) response = await service.execute(login.token, 'start', { requestId: 'performance-start', cardIds: [], mode: 'SINGLE_TEST' })
  const calls = []
  const api = {
    async login() { return structuredClone(response) },
    async command(action, data = {}) {
      calls.push(action)
      const result = await service.execute(login.token, action, { ...data, requestId: `performance-request-${calls.length}` })
      if (action === 'heartbeat') return new Promise(resolve => { releaseHeartbeat = () => resolve(result) })
      return result
    }
  }
  const main = path.join(__dirname, '../client/js/main.js'), realRequire = createRequire(main)
  const sandbox = vm.createContext({ wx, console, setTimeout, clearTimeout, requestAnimationFrame() {}, require(name) {
    if (name === './api/account') return api
    if (name === './api/cards') return { fetchCardCatalog: () => slowCatalog ? new Promise(() => {}) : Promise.resolve({ cards: remoteCards }) }
    return realRequire(name)
  } })
  vm.runInContext(fs.readFileSync(main, 'utf8'), sandbox, { filename: main })
  await new Promise(resolve => setImmediate(resolve))
  return { sandbox, calls, run: code => vm.runInContext(code, sandbox), touchStart: event => touchStart(event), touchEnd: event => touchEnd(event),
    hide: () => hide(), show: () => show(), releaseHeartbeat: () => releaseHeartbeat(), counts: () => ({ frames, arcs, copies }), labels, clipRects }
}

test('旧云端目录下守卫圆盾仍可辨认并加入战备', async () => {
  const f = await fixture({ remoteCards: cards.filter(card => card.cardId !== 'ar_013') })
  assert.equal(f.run('cardById("ar_013").rarity'), 'BLUE')
  assert.equal(f.run('new LoadoutSession({ cards, quantities: { ar_013: 1 } }).add("ar_013").ok'), true)
  f.run('drawCardArt(cardById("ar_013"), { x: 0, y: 0, width: 90, height: 120 })')
  assert.ok(f.labels.includes('蓝'))
})

test('静态页不重复绘制，触控立即反馈且不污染下一帧缓存，DPR上限为2', async () => {
  const f = await fixture({ slowCatalog: true })
  assert.equal(f.run('scene'), 'HOME', 'Slow catalog must not delay account login')
  assert.equal(f.run('pixelRatio'), 2)
  f.run('const testStartedAt = Date.now() + 1000; Date.now = () => testStartedAt; renderFrame(testStartedAt)')
  const initial = f.counts()
  f.run('renderFrame(testStartedAt + 40)')
  assert.deepEqual(f.counts(), initial)
  f.touchStart({ touches: [{ clientX: 200, clientY: 80 }] })
  assert.equal(f.run('tapFeedback.sample(Date.now()).length'), 1)
  f.run('renderFrame(testStartedAt + 80)')
  const pressed = f.counts()
  assert.ok(pressed.arcs > initial.arcs)
  f.run('renderFrame(testStartedAt + 120)')
  assert.equal(f.counts().copies, pressed.copies, 'Effect-only frames reuse the cached scene')
})

test('无离屏Canvas时正确回退，所有页面及空白位置都有点击反馈', async () => {
  const f = await fixture({ offscreen: false })
  for (const scene of ['HOME', 'WAREHOUSE', 'LOADOUT']) {
    f.run(`setScene('${scene}'); draw()`)
    f.touchStart({ touches: [{ clientX: 1, clientY: 1 }] })
  }
  assert.equal(f.run('tapFeedback.sample(Date.now()).length'), 3)
  f.run('renderFrame(Date.now() + 100)')
  assert.equal(f.run('cachedFrameReady'), false)
  f.hide()
  assert.equal(f.run('tapFeedback.sample(Date.now()).length'), 0)
})

test('后台同步进行时玩家操作不再被忽略，绘制不深拷贝对局', async () => {
  const f = await fixture({ active: true })
  const heartbeat = f.run('heartbeatAccount()')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.run('heartbeatInFlight'), true)
  assert.equal(f.run('accountBusy'), false)
  assert.equal(await f.run('accountAction("move", { target: { x: 0, y: 0 } })'), true)
  assert.ok(f.calls.includes('game'))
  f.releaseHeartbeat()
  await heartbeat
  assert.equal(f.run('engine.phase'), 'SEARCH', 'Older heartbeat response must not overwrite newer gameplay')
  f.run('engine.snapshot = () => { throw new Error("per-frame snapshot prohibited") }; draw()')
  assert.equal(f.run('!!roomArtworkCache'), true)
  assert.equal(f.run('context === canvas.getContext("2d")'), true, 'Offscreen painting restores the main context')
  const painted = f.counts().copies
  f.run('draw()')
  assert.equal(f.counts().copies, painted, 'Static room layers are not recomposed for each timer frame')
})

test('房间实际绘制100%、50%、0%的金色填充，标题与地图一致且两个计时条都无文字', async () => {
  const f = await fixture({ active: true })
  assert.equal(await f.run('accountAction("move", { target: { x: 0, y: 0 } })'), true)
  f.run('searchVisitState.room.nodeId = "n_1_1"; let frameNow = searchVisitState.visit.deadlineAt - C.SEARCH_DURATION_MS; Date.now = () => frameNow')
  const width = f.run('createRoomLayout(viewWidth, viewHeight).timerFill.width')
  f.labels.length = 0
  f.run('drawRoom(engine)')
  assert.ok(f.labels.includes('医疗室'))
  assert.equal(f.clipRects.at(-1)[2], width)
  f.run('frameNow += C.SEARCH_DURATION_MS / 2; drawRoom(engine)')
  assert.equal(f.clipRects.at(-1)[2], width / 2)
  const clips = f.clipRects.length
  f.run('frameNow += C.SEARCH_DURATION_MS / 2; drawRoom(engine)')
  assert.equal(f.clipRects.length, clips, 'Zero remaining time does not draw a fill')
  f.run('drawSearch(engine)')
  assert.ok(f.labels.every(label => !/倒计时|搜索轮/.test(label)))
})

test('搜索卡槽实际绘制水波纹，搜索到期后停止', async () => {
  const f = await fixture({ active: true })
  assert.equal(await f.run('accountAction("move", { target: { x: 0, y: 0 } })'), true)
  await f.run('openSearchObservation("MAIN_TABLE")')
  f.run(`
    searchVisitState.room.activeArea = { visibleItems: [], itemCount: 1 }
    let rippleNow = searchVisitState.visit.observation.startedAt
    Date.now = () => rippleNow
    const searchPanelRect = createSearchLayout(viewWidth, viewHeight).search
  `)
  const initial = f.counts().arcs
  f.run('drawSearchRoomPanel(searchPanelRect)')
  assert.equal(f.counts().arcs, initial + 1)
  f.run('rippleNow += 600; drawSearchRoomPanel(searchPanelRect)')
  assert.equal(f.counts().arcs, initial + 3)
  f.run('rippleNow = searchVisitState.visit.deadlineAt; drawSearchRoomPanel(searchPanelRect)')
  assert.equal(f.counts().arcs, initial + 3)
})

test('超宽屏只绘制一次完整房间底图，不绘制拉伸的边缘补条', async () => {
  const f = await fixture({ active: true })
  const calls = f.run(`
    const backgroundDraws = []
    context.drawImage = (image, ...args) => {
      if (image === assets.searchRoomBackground) backgroundDraws.push(args)
    }
    paintRoomArtwork()
    backgroundDraws
  `)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 4)
  const [x, y, width, height] = calls[0]
  assert.equal(x, 0)
  assert.equal(width, 812)
  assert.ok(y < 0 && y + height > 375)
})

test('右桌搜索热区与离开房间重叠时，真实触控优先离开，按钮外仍可搜索', async () => {
  const f = await fixture({ active: true })
  assert.equal(await f.run('accountAction("move", { target: { x: 0, y: 0 } })'), true)
  const { table, overlap } = f.run(`
    draw()
    const area = ui.roomAreaRects.find(rect => rect.areaId === 'RIGHT_TABLE')
    const leave = ui.hotspots.find(hotspot => hotspot.id === 'room_leave').rect
    const overlap = {
      x: (Math.max(area.x, leave.x) + Math.min(area.x + area.width, leave.x + leave.width)) / 2,
      y: (Math.max(area.y, leave.y) + Math.min(area.y + area.height, leave.y + leave.height)) / 2
    }
    if (!pointInRect(overlap, area) || !pointInRect(overlap, leave)) throw new Error('Fixture must overlap')
    const table = { x: area.x + area.width / 2, y: area.y + 4 }
    if (pointInRect(table, leave)) throw new Error('Table point must be outside the button')
    ;({ table, overlap })
  `)
  async function tap({ x, y }) {
    const touches = [{ clientX: x, clientY: y }]
    f.touchStart({ touches })
    f.touchEnd({ changedTouches: touches })
    await new Promise(resolve => setImmediate(resolve))
  }
  await tap(table)
  assert.equal(f.run('presentation'), 'SEARCH')
  assert.equal(f.run('searchVisitState.room.activeAreaId'), 'RIGHT_TABLE')
  await f.run('finishSearchOverlay()')
  const turn = f.run('engine.turn')
  f.run('draw()')
  await tap(overlap)
  assert.equal(f.run('presentation'), 'MAP')
  assert.equal(f.run('engine.turn'), turn + 1)
})

test('移动页绘制25格新名称和七种图例，移动目标与进房标题一致', async () => {
  const f = await fixture({ active: true })
  f.labels.length = 0
  f.run('selectMovementTarget({ x: 1, y: 0 }); draw()')
  const roomNames = ['出生点', '会客厅', '监控室', '仓库', '医疗室', '中央金库', '撤离点']
  assert.equal(f.labels.filter(label => roomNames.includes(label)).length, 25 + roomNames.length)
  assert.ok(f.labels.includes('目标：会客厅'))
  assert.equal(await f.run('accountAction("move", { target: { x: 1, y: 0 } })'), true)
  f.labels.length = 0
  f.run('drawRoom(engine)')
  assert.ok(f.labels.includes('会客厅'))
})
