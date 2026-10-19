const cards = require('../data/cards')
const C = require('./core/constants')
const { GameEngine, positionKey } = require('./core/game-engine')
const { MatchmakingSession } = require('./core/matchmaking')
const { createSeededRng } = require('./core/rng')

const canvas = wx.createCanvas()
const context = canvas.getContext('2d')
const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
const pixelRatio = windowInfo.pixelRatio || 1
const viewWidth = windowInfo.windowWidth
const viewHeight = windowInfo.windowHeight
canvas.width = viewWidth * pixelRatio
canvas.height = viewHeight * pixelRatio
context.scale(pixelRatio, pixelRatio)

const PALETTE = {
  red: '#a51f2d',
  brightRed: '#e23e46',
  purple: '#3d225f',
  gold: '#f7c95c',
  paleGold: '#fff0b0',
  ink: '#17131b',
  cream: '#fff4dc',
  green: '#4fc18b',
  blue: '#56a6db'
}

const assetSources = {
  home: 'assets/home.jpg',
  map: 'assets/map.jpg',
  characters: 'assets/characters.jpg',
  loading: 'assets/loading.jpg'
}
const assets = {}
let assetsLoaded = 0
let scene = 'LOADING'
let sceneEnteredAt = Date.now()
let matchmaking = new MatchmakingSession()
let engine = null
let presentation = 'MAP'
let selectedMove = null
let activeBattle = null
let matchReadyAt = null
let simulatedJoinStep = 0
let toast = ''
let toastUntil = 0
let draggingItemId = null

const ui = {
  hotspots: [],
  inventoryRects: [],
  discardRect: null
}

function setScene(nextScene) {
  scene = nextScene
  sceneEnteredAt = Date.now()
  ui.hotspots = []
}

function loadAssets() {
  Object.keys(assetSources).forEach(key => {
    const image = wx.createImage()
    image.onload = () => {
      assets[key] = image
      assetsLoaded += 1
      if (assetsLoaded === Object.keys(assetSources).length) {
        setTimeout(() => setScene('HOME'), 350)
      }
    }
    image.onerror = () => {
      assetsLoaded += 1
      if (assetsLoaded === Object.keys(assetSources).length) setScene('HOME')
    }
    image.src = assetSources[key]
  })
}

function roundedPath(x, y, width, height, radius = 12) {
  const r = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + r, y)
  context.lineTo(x + width - r, y)
  context.quadraticCurveTo(x + width, y, x + width, y + r)
  context.lineTo(x + width, y + height - r)
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  context.lineTo(x + r, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - r)
  context.lineTo(x, y + r)
  context.quadraticCurveTo(x, y, x + r, y)
  context.closePath()
}

function panel(x, y, width, height, options = {}) {
  context.save()
  roundedPath(x, y, width, height, options.radius || 12)
  context.fillStyle = options.fill || 'rgba(22, 15, 24, 0.88)'
  context.fill()
  context.strokeStyle = options.stroke || 'rgba(247, 201, 92, 0.75)'
  context.lineWidth = options.lineWidth || 1.5
  context.stroke()
  context.restore()
}

function text(value, x, y, size = 14, color = PALETTE.cream, align = 'left', weight = 'normal') {
  context.fillStyle = color
  context.font = `${weight} ${size}px sans-serif`
  context.textAlign = align
  context.textBaseline = 'middle'
  context.fillText(String(value), x, y)
}

function button(id, label, rect, options = {}) {
  context.save()
  const gradient = context.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height)
  gradient.addColorStop(0, options.top || '#d84b4f')
  gradient.addColorStop(1, options.bottom || '#7f1725')
  roundedPath(rect.x, rect.y, rect.width, rect.height, options.radius || 10)
  context.fillStyle = gradient
  context.shadowColor = options.glow || 'rgba(247, 201, 92, 0.28)'
  context.shadowBlur = 12
  context.fill()
  context.shadowBlur = 0
  context.strokeStyle = options.stroke || PALETTE.gold
  context.lineWidth = 2
  context.stroke()
  text(label, rect.x + rect.width / 2, rect.y + rect.height / 2, options.size || 14, options.color || '#fff9e9', 'center', 'bold')
  context.restore()
  ui.hotspots.push({ id, rect, data: options.data })
}

function drawCover(image) {
  if (!image) {
    context.fillStyle = PALETTE.ink
    context.fillRect(0, 0, viewWidth, viewHeight)
    return
  }
  const scale = Math.max(viewWidth / image.width, viewHeight / image.height)
  const width = image.width * scale
  const height = image.height * scale
  context.drawImage(image, (viewWidth - width) / 2, (viewHeight - height) / 2, width, height)
}

function darken(alpha = 0.45, color = '0, 0, 0') {
  context.fillStyle = `rgba(${color}, ${alpha})`
  context.fillRect(0, 0, viewWidth, viewHeight)
}

function hpBar(x, y, width, hp, maxHp, color = PALETTE.brightRed) {
  roundedPath(x, y, width, 10, 5)
  context.fillStyle = 'rgba(0,0,0,.55)'
  context.fill()
  roundedPath(x, y, width * Math.max(0, hp / maxHp), 10, 5)
  context.fillStyle = color
  context.fill()
  context.strokeStyle = 'rgba(255,255,255,.35)'
  context.stroke()
}

function addToast(message, duration = 1800) {
  toast = message
  toastUntil = Date.now() + duration
}

function drawToast() {
  if (!toast || Date.now() > toastUntil) return
  const width = Math.min(viewWidth * 0.56, 420)
  panel((viewWidth - width) / 2, viewHeight - 54, width, 36, { fill: 'rgba(20,12,18,.94)', stroke: PALETTE.gold, radius: 18 })
  text(toast, viewWidth / 2, viewHeight - 36, 12, PALETTE.paleGold, 'center', 'bold')
}

function drawLoading() {
  drawCover(assets.loading)
  const progress = assetsLoaded / Object.keys(assetSources).length
  const width = viewWidth * 0.46
  const x = (viewWidth - width) / 2
  const y = viewHeight * 0.84
  roundedPath(x, y, width, 9, 5)
  context.fillStyle = 'rgba(30,15,35,.72)'
  context.fill()
  roundedPath(x + 2, y + 2, Math.max(4, (width - 4) * progress), 5, 3)
  const gradient = context.createLinearGradient(x, y, x + width, y)
  gradient.addColorStop(0, '#ffcf62')
  gradient.addColorStop(1, '#ad4ed2')
  context.fillStyle = gradient
  context.fill()
  text(`正在加载赌场资源 ${Math.round(progress * 100)}%`, viewWidth / 2, y + 24, 11, '#fff3d4', 'center')
}

function drawHome() {
  drawCover(assets.home)
  const pulse = 0.55 + Math.sin(Date.now() / 280) * 0.18
  const startRect = { x: viewWidth * 0.625, y: viewHeight * 0.465, width: viewWidth * 0.225, height: viewHeight * 0.11 }
  context.save()
  roundedPath(startRect.x, startRect.y, startRect.width, startRect.height, 12)
  context.strokeStyle = `rgba(255, 239, 142, ${pulse})`
  context.lineWidth = 3
  context.stroke()
  context.restore()
  ui.hotspots.push({ id: 'home_start', rect: startRect })
  ui.hotspots.push({ id: 'home_equipment', rect: { x: viewWidth * 0.625, y: viewHeight * 0.59, width: viewWidth * 0.225, height: viewHeight * 0.11 } })
  ui.hotspots.push({ id: 'home_map', rect: { x: viewWidth * 0.625, y: viewHeight * 0.715, width: viewWidth * 0.225, height: viewHeight * 0.11 } })
  panel(14, 12, 126, 32, { fill: 'rgba(33,17,23,.68)', stroke: 'rgba(255,231,162,.65)', radius: 16 })
  text('♠  离岸码头 · 01', 77, 28, 11, '#fff0be', 'center', 'bold')
  text('MVP TEST BUILD 0.2', viewWidth - 14, viewHeight - 12, 9, 'rgba(255,255,255,.72)', 'right')
}

function beginMatchmaking() {
  matchmaking = new MatchmakingSession()
  matchmaking.start({ id: 'P1', name: '码头新人', isBot: false })
  simulatedJoinStep = 0
  matchReadyAt = null
  setScene('MATCHING')
}

function drawMatchBackground() {
  drawCover(assets.map)
  darken(0.56, '18, 9, 32')
  const topGradient = context.createLinearGradient(0, 0, 0, viewHeight * 0.35)
  topGradient.addColorStop(0, 'rgba(73,20,30,.82)')
  topGradient.addColorStop(1, 'rgba(25,14,35,0)')
  context.fillStyle = topGradient
  context.fillRect(0, 0, viewWidth, viewHeight * 0.4)
}

function drawMatchmaking(found = false) {
  drawMatchBackground()
  const state = matchmaking.snapshot()
  const panelWidth = Math.min(620, viewWidth * 0.72)
  const panelHeight = Math.min(310, viewHeight * 0.76)
  const x = (viewWidth - panelWidth) / 2
  const y = (viewHeight - panelHeight) / 2
  panel(x, y, panelWidth, panelHeight, { fill: 'rgba(28,15,33,.92)', stroke: PALETTE.gold, lineWidth: 2, radius: 20 })
  text(found ? '牌 局 集 结 完 成' : '正 在 寻 找 同 行 者', viewWidth / 2, y + 34, 22, PALETTE.paleGold, 'center', 'bold')
  text(found ? '三名劫匪已登船，准备登陆卡西诺岛' : '白鸽接应队正在为你安排同局玩家', viewWidth / 2, y + 62, 11, '#d8c8dc', 'center')

  const suits = ['♠', '♥', '♣']
  const colors = [PALETTE.gold, '#ef6975', '#9f7ee8']
  const names = ['码头新人', '黑桃客', '红心客']
  for (let index = 0; index < C.PLAYER_LIMIT; index += 1) {
    const centerX = x + panelWidth * (0.22 + index * 0.28)
    const centerY = y + 132
    const joined = index < state.participants.length
    context.beginPath()
    context.arc(centerX, centerY, 31, 0, Math.PI * 2)
    context.fillStyle = joined ? 'rgba(75,43,45,.98)' : 'rgba(255,255,255,.05)'
    context.fill()
    context.strokeStyle = joined ? colors[index] : 'rgba(255,255,255,.18)'
    context.lineWidth = 2
    context.stroke()
    text(joined ? suits[index] : '…', centerX, centerY, 29, joined ? colors[index] : '#766d7d', 'center', 'bold')
    text(joined ? names[index] : '等待加入', centerX, centerY + 48, 11, joined ? '#fff2da' : '#8c8190', 'center')
    if (joined) text(index === 0 ? '真人玩家' : '测试玩家', centerX, centerY + 66, 8, '#a99cad', 'center')
  }

  if (found) {
    const countdown = Math.max(1, 3 - Math.floor((Date.now() - matchReadyAt) / 850))
    text(`${countdown}`, viewWidth / 2, y + panelHeight - 46, 30, PALETTE.gold, 'center', 'bold')
    text('秒后进入赌场', viewWidth / 2 + 42, y + panelHeight - 45, 10, '#d8c8dc')
    return
  }

  const remaining = matchmaking.remainingMs()
  text(`最长等待 05:00 · 剩余 ${String(Math.floor(remaining / 60000)).padStart(2, '0')}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')}`, viewWidth / 2, y + panelHeight - 75, 10, '#bfb1c3', 'center')
  button('match_cancel', '取消匹配', { x: x + 24, y: y + panelHeight - 52, width: 132, height: 34 }, { top: '#594958', bottom: '#2b222d', stroke: '#aa94aa', size: 12 })
  button('match_single', '单人测试 · 立即开始', { x: x + panelWidth - 212, y: y + panelHeight - 52, width: 188, height: 34 }, { top: '#d79c39', bottom: '#8b3b23', stroke: '#ffe19a', size: 12 })
}

function startGame() {
  engine = new GameEngine({ cards, rng: createSeededRng(Date.now()), localPlayerId: 'P1' })
  engine.start()
  selectedMove = null
  activeBattle = null
  presentation = 'MAP'
  setScene('GAME')
}

function currentState() {
  return engine ? engine.snapshot() : null
}

function drawTopHud(state) {
  const local = state.players.find(player => player.id === 'P1')
  const gradient = context.createLinearGradient(0, 0, viewWidth, 0)
  gradient.addColorStop(0, 'rgba(110,17,31,.96)')
  gradient.addColorStop(0.55, 'rgba(34,20,40,.95)')
  gradient.addColorStop(1, 'rgba(28,19,45,.96)')
  context.fillStyle = gradient
  context.fillRect(0, 0, viewWidth, 48)
  context.strokeStyle = 'rgba(247,201,92,.7)'
  context.beginPath()
  context.moveTo(0, 47)
  context.lineTo(viewWidth, 47)
  context.stroke()
  text('♠ 大劫卡西诺', 16, 23, 17, PALETTE.paleGold, 'left', 'bold')
  text(`回合 ${String(state.turn).padStart(2, '0')}/${C.MAX_TURNS}`, viewWidth * 0.27, 17, 11, '#decdd3')
  const progressWidth = 96
  roundedPath(viewWidth * 0.27, 29, progressWidth, 6, 3)
  context.fillStyle = 'rgba(255,255,255,.13)'
  context.fill()
  roundedPath(viewWidth * 0.27, 29, progressWidth * state.turn / C.MAX_TURNS, 6, 3)
  context.fillStyle = state.turn >= 10 ? '#ee5252' : PALETTE.gold
  context.fill()
  text(`HP ${local.hp}/${local.maxHp}`, viewWidth * 0.48, 15, 11, '#fff5e3', 'center', 'bold')
  hpBar(viewWidth * 0.43, 29, viewWidth * 0.1, local.hp, local.maxHp)
  text(state.turn >= 10 ? '⚠ 警报圈生效' : '警报圈：第10轮', viewWidth * 0.66, 23, 11, state.turn >= 10 ? '#ff6c6c' : '#c7b8cc', 'center', 'bold')
  text(`物资 ${formatGold(engine.inventoryValue('P1'))}`, viewWidth - 18, 23, 12, PALETTE.gold, 'right', 'bold')
}

function formatGold(value) {
  return `${Math.round(value / 1000)}K Gold`
}

function gameLayout() {
  const top = 58
  const bottom = 66
  const gridSize = Math.min(viewHeight - top - bottom, viewWidth * 0.47)
  return {
    gridX: 24,
    gridY: top,
    gridSize,
    cell: gridSize / C.BOARD_SIZE,
    sideX: 42 + gridSize,
    sideWidth: viewWidth - gridSize - 66,
    bottomY: viewHeight - bottom + 7
  }
}

function drawMapGrid(state, layout) {
  const local = state.players.find(player => player.id === 'P1')
  const legal = engine.legalMoves('P1').map(position => `${position.x},${position.y}`)
  const selecting = state.phase === 'MOVE_SELECTION'
  panel(layout.gridX - 8, layout.gridY - 8, layout.gridSize + 16, layout.gridSize + 16, { fill: 'rgba(13,26,39,.53)', stroke: 'rgba(255,224,135,.72)', radius: 15 })

  for (let y = 0; y < C.BOARD_SIZE; y += 1) {
    for (let x = 0; x < C.BOARD_SIZE; x += 1) {
      const px = layout.gridX + x * layout.cell
      const py = layout.gridY + y * layout.cell
      const key = `${x},${y}`
      const exit = x === 4 && y === 4
      const center = x === 2 && y === 2
      const locked = center && state.turn < 6
      const isLegal = selecting && legal.includes(key) && !locked
      const selected = selectedMove && selectedMove.x === x && selectedMove.y === y
      roundedPath(px + 2, py + 2, layout.cell - 4, layout.cell - 4, 7)
      context.fillStyle = exit ? 'rgba(28,100,73,.83)' : center ? 'rgba(128,28,44,.82)' : 'rgba(24,30,42,.66)'
      context.fill()
      context.strokeStyle = selected ? '#fff1a4' : isLegal ? PALETTE.gold : 'rgba(255,255,255,.2)'
      context.lineWidth = selected ? 3 : isLegal ? 2 : 1
      context.stroke()
      if (exit) text('撤', px + layout.cell / 2, py + layout.cell / 2, 15, '#c9ffe5', 'center', 'bold')
      if (center) text(locked ? '锁' : '金', px + layout.cell / 2, py + layout.cell / 2, 15, locked ? '#9a8890' : '#ffd56c', 'center', 'bold')
    }
  }

  if (!selecting) {
    state.players.forEach(player => {
      if (!['ACTIVE', 'EXTRACTED'].includes(player.status)) return
      const fromX = layout.gridX + (player.previousPosition.x + 0.5) * layout.cell
      const fromY = layout.gridY + (player.previousPosition.y + 0.5) * layout.cell
      const toX = layout.gridX + (player.position.x + 0.5) * layout.cell
      const toY = layout.gridY + (player.position.y + 0.5) * layout.cell
      context.strokeStyle = player.id === 'P1' ? '#ffe476' : player.id === 'P2' ? '#ff6b74' : '#a989ff'
      context.lineWidth = 3
      context.beginPath()
      context.moveTo(fromX, fromY)
      context.lineTo(toX, toY)
      context.stroke()
    })
  }

  state.players.forEach((player, index) => {
    if (player.status !== 'ACTIVE') return
    if (selecting && player.id !== 'P1') return
    const cx = layout.gridX + (player.position.x + 0.5) * layout.cell + (index - 1) * 6
    const cy = layout.gridY + (player.position.y + 0.5) * layout.cell
    context.beginPath()
    context.arc(cx, cy, 9, 0, Math.PI * 2)
    context.fillStyle = player.id === 'P1' ? '#ffe476' : player.id === 'P2' ? '#ff6670' : '#9b7af0'
    context.fill()
    context.strokeStyle = '#2a1722'
    context.lineWidth = 2
    context.stroke()
    text(player.id.slice(-1), cx, cy, 9, '#24151b', 'center', 'bold')
  })

  if (selecting) {
    engine.legalMoves('P1').forEach(position => {
      if (position.x === 2 && position.y === 2 && state.turn < 6) return
      ui.hotspots.push({ id: 'map_node', rect: { x: layout.gridX + position.x * layout.cell, y: layout.gridY + position.y * layout.cell, width: layout.cell, height: layout.cell }, data: position })
    })
  }
  text(selecting ? '敌方位置已隐藏 · 锁定后统一公布' : '本回合移动轨迹', layout.gridX + layout.gridSize / 2, layout.gridY + layout.gridSize + 18, 10, '#fff0c4', 'center')
  if (local.extractionRequestedTurn !== null) text('白鸽接应中', layout.gridX + layout.gridSize / 2, layout.gridY - 18, 10, '#a7f4d1', 'center', 'bold')
}

function drawInventory(state, x, y, width, interactive = true) {
  const local = state.players.find(player => player.id === 'P1')
  panel(x, y, width, viewHeight - y - 70, { fill: 'rgba(28,17,30,.9)', stroke: 'rgba(247,201,92,.66)', radius: 13 })
  text('装备与背包', x + 14, y + 20, 14, PALETTE.paleGold, 'left', 'bold')
  const weapon = state.items.find(item => item.instanceId === local.equippedWeaponId)
  const weaponCard = weapon && cards.find(card => card.cardId === weapon.cardId)
  panel(x + 10, y + 38, width - 20, 46, { fill: 'rgba(98,30,40,.55)', stroke: '#b57962', radius: 8 })
  text(weaponCard ? weaponCard.name : '徒手', x + 20, y + 54, 12, '#fff2d5', 'left', 'bold')
  text(weapon ? `耐久 ${'■'.repeat(weapon.durability)}${'□'.repeat(Math.max(0, 2 - weapon.durability))}` : '攻击倍率 0.3', x + 20, y + 72, 9, '#d7bca9')
  text(`背包 ${local.inventory.length}/${C.BACKPACK_SLOTS}`, x + 14, y + 103, 11, '#d8cbd7', 'left', 'bold')
  ui.inventoryRects = []
  const columns = 4
  const gap = 5
  const slot = (width - 25 - gap * (columns - 1)) / columns
  for (let index = 0; index < C.BACKPACK_SLOTS; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const rect = { x: x + 10 + column * (slot + gap), y: y + 117 + row * (slot + gap), width: slot, height: slot }
    roundedPath(rect.x, rect.y, rect.width, rect.height, 6)
    context.fillStyle = 'rgba(255,255,255,.055)'
    context.fill()
    context.strokeStyle = 'rgba(230,198,125,.35)'
    context.stroke()
    const instanceId = local.inventory[index]
    if (instanceId) {
      const item = state.items.find(candidate => candidate.instanceId === instanceId)
      const card = item && cards.find(candidate => candidate.cardId === item.cardId)
      text(card ? card.name.slice(0, 2) : '?', rect.x + rect.width / 2, rect.y + rect.height / 2 - 4, 9, '#fff0cb', 'center', 'bold')
      text(item && item.state === 'EQUIPPED' ? '装备' : '物资', rect.x + rect.width / 2, rect.y + rect.height - 8, 7, '#c19b63', 'center')
      if (interactive) ui.inventoryRects.push({ ...rect, instanceId })
    }
  }
}

function drawMapScene(state) {
  drawCover(assets.map)
  darken(0.23, '5, 13, 24')
  drawTopHud(state)
  const layout = gameLayout()
  drawMapGrid(state, layout)
  drawInventory(state, layout.sideX, layout.gridY, layout.sideWidth)
  const local = state.players.find(player => player.id === 'P1')
  const deadline = state.phase === 'MOVE_SELECTION' ? state.moveDeadlineAt : state.turnDeadlineAt
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
  panel(layout.sideX, viewHeight - 61, layout.sideWidth, 48, { fill: 'rgba(25,16,29,.93)', stroke: 'rgba(247,201,92,.55)', radius: 10 })
  text(state.phase === 'MOVE_SELECTION' ? '移动回合' : '行动结算', layout.sideX + 12, viewHeight - 45, 11, PALETTE.gold, 'left', 'bold')
  text(`${seconds}s`, layout.sideX + layout.sideWidth - 12, viewHeight - 45, 11, state.turn >= 10 ? '#ff6c6c' : '#d9cbd6', 'right', 'bold')
  if (state.phase === 'MOVE_SELECTION') {
    text(selectedMove ? `目标节点 (${selectedMove.x},${selectedMove.y})` : '选择高亮相邻节点', layout.sideX + 12, viewHeight - 27, 9, '#c9bcc8')
    button('confirm_move', '锁定移动', { x: layout.sideX + layout.sideWidth - 112, y: viewHeight - 54, width: 102, height: 32 }, { size: 11 })
  } else {
    text(`当前位置 ${positionKey(local.position).replace('n_', '(').replace('_', ',')})`, layout.sideX + 12, viewHeight - 27, 9, '#c9bcc8')
  }
  ui.discardRect = { x: viewWidth - 118, y: 7, width: 104, height: 31 }
  roundedPath(ui.discardRect.x, ui.discardRect.y, ui.discardRect.width, ui.discardRect.height, 8)
  context.fillStyle = draggingItemId ? 'rgba(180,50,55,.92)' : 'rgba(45,27,36,.88)'
  context.fill()
  context.strokeStyle = draggingItemId ? '#ff9b7e' : 'rgba(255,255,255,.2)'
  context.stroke()
  text('拖到此处丢弃', ui.discardRect.x + ui.discardRect.width / 2, ui.discardRect.y + 16, 9, '#efd8d3', 'center')
}

function decidePostMove() {
  const state = currentState()
  const local = state.players.find(player => player.id === 'P1')
  const battle = state.encounters.find(encounter => encounter.type === 'BATTLE' && encounter.playerIds.includes('P1'))
  if (battle) {
    activeBattle = battle
    presentation = 'BATTLE'
    return
  }
  if (local.status !== 'ACTIVE') {
    presentation = 'SETTLEMENT'
    return
  }
  if (engine.searchItemsFor('P1').some(item => ['HIDDEN', 'REVEALED', 'DROPPED'].includes(item.state))) {
    presentation = 'SEARCH'
  } else {
    presentation = 'ROUND_RESULT'
  }
}

function drawBattle(state) {
  drawCover(assets.characters)
  darken(0.5, '14, 5, 22')
  drawTopHud(state)
  const local = state.players.find(player => player.id === 'P1')
  const opponentId = activeBattle.playerIds.find(id => id !== 'P1')
  const opponent = state.players.find(player => player.id === opponentId)
  panel(18, 63, viewWidth * 0.27, 82, { fill: 'rgba(120,22,34,.84)', stroke: '#ffb878' })
  text(local.name, 32, 82, 17, '#fff0ce', 'left', 'bold')
  text(`HP ${activeBattle.leftHp !== undefined && activeBattle.playerIds[0] === 'P1' ? activeBattle.leftHp : activeBattle.rightHp}`, 32, 108, 12, '#fff')
  hpBar(32, 124, viewWidth * 0.21, local.hp, local.maxHp, '#e54b53')
  panel(viewWidth - viewWidth * 0.27 - 18, 63, viewWidth * 0.27, 82, { fill: 'rgba(52,30,99,.86)', stroke: '#c7a1ff' })
  text(opponent ? opponent.name : '神秘对手', viewWidth - 32, 82, 17, '#f5e9ff', 'right', 'bold')
  text(`HP ${opponent ? opponent.hp : 0}`, viewWidth - 32, 108, 12, '#fff', 'right')
  hpBar(viewWidth - viewWidth * 0.21 - 32, 124, viewWidth * 0.21, opponent ? opponent.hp : 0, opponent ? opponent.maxHp : 30, '#835de2')
  text('VS', viewWidth / 2, 104, 34, PALETTE.gold, 'center', 'bold')

  const rounds = activeBattle.rounds || []
  const boxWidth = Math.min(150, viewWidth * 0.2)
  rounds.forEach((round, index) => {
    const x = viewWidth / 2 - (rounds.length * boxWidth + (rounds.length - 1) * 10) / 2 + index * (boxWidth + 10)
    const y = viewHeight * 0.48
    panel(x, y, boxWidth, 88, { fill: 'rgba(22,15,29,.9)', stroke: index === rounds.length - 1 ? PALETTE.gold : 'rgba(255,255,255,.25)', radius: 10 })
    text(`第 ${round.round} 轮`, x + boxWidth / 2, y + 16, 11, PALETTE.paleGold, 'center', 'bold')
    text(`我方骰 ${round.leftRoll.join(' · ')}`, x + boxWidth / 2, y + 38, 10, '#ffbbb0', 'center')
    text(`敌方骰 ${round.rightRoll.join(' · ')}`, x + boxWidth / 2, y + 56, 10, '#c8b2ff', 'center')
    text(`伤害 ${round.damageToRight} / ${round.damageToLeft}`, x + boxWidth / 2, y + 74, 9, '#d6cbd7', 'center')
  })

  const won = activeBattle.winnerId === 'P1'
  const draw = activeBattle.winnerId === null
  panel(viewWidth * 0.27, viewHeight - 72, viewWidth * 0.46, 54, { fill: 'rgba(24,14,28,.95)', stroke: won ? '#ffd56a' : draw ? '#b8acbd' : '#e0656b', radius: 13 })
  text(draw ? '完全平局 · 双方撤出战斗' : won ? '战斗胜利 · 战利品已开放搜索' : '战斗失败 · 白鸽接应队已出动', viewWidth / 2, viewHeight - 53, 13, won ? '#ffe28b' : '#ffd8d8', 'center', 'bold')
  button('battle_continue', won ? '查看战利品' : '进入结算', { x: viewWidth / 2 - 70, y: viewHeight - 39, width: 140, height: 30 }, { size: 10, top: won ? '#cc8b2f' : '#8b3546', bottom: won ? '#87421f' : '#4d2335' })
}

function drawSearch(state) {
  drawCover(assets.map)
  darken(0.62, '12, 5, 24')
  drawTopHud(state)
  const layout = gameLayout()
  const roomX = 24
  const roomWidth = viewWidth - layout.sideWidth - 66
  panel(roomX, 61, roomWidth, viewHeight - 78, { fill: 'rgba(46,22,25,.9)', stroke: '#d9a443', lineWidth: 2, radius: 17 })
  const glow = context.createRadialGradient(roomX + roomWidth / 2, viewHeight * 0.52, 10, roomX + roomWidth / 2, viewHeight * 0.52, roomWidth * 0.45)
  glow.addColorStop(0, 'rgba(255,202,89,.28)')
  glow.addColorStop(1, 'rgba(79,22,36,0)')
  context.fillStyle = glow
  context.fillRect(roomX, 61, roomWidth, viewHeight - 78)
  text('房 间 搜 索', roomX + 18, 83, 18, PALETTE.paleGold, 'left', 'bold')
  text('点击显示物资 · 再次点击拾取', roomX + 18, 106, 10, '#d6bdaf')

  const available = engine.searchItemsFor('P1').filter(item => ['HIDDEN', 'REVEALED', 'DROPPED'].includes(item.state))
  const cardWidth = Math.min(112, (roomWidth - 64) / Math.max(3, Math.min(available.length, 4)))
  available.slice(0, 4).forEach((item, index) => {
    const totalWidth = Math.min(4, available.length) * cardWidth + (Math.min(4, available.length) - 1) * 12
    const x = roomX + (roomWidth - totalWidth) / 2 + index * (cardWidth + 12)
    const y = viewHeight * 0.39
    const rect = { x, y, width: cardWidth, height: Math.min(142, viewHeight * 0.38) }
    roundedPath(rect.x, rect.y, rect.width, rect.height, 11)
    const gradient = context.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height)
    if (item.state === 'HIDDEN') {
      gradient.addColorStop(0, '#941f32')
      gradient.addColorStop(1, '#34162d')
    } else {
      gradient.addColorStop(0, '#f2d089')
      gradient.addColorStop(1, '#8f492a')
    }
    context.fillStyle = gradient
    context.fill()
    context.strokeStyle = item.state === 'HIDDEN' ? '#ffc45c' : '#fff0ac'
    context.lineWidth = 2
    context.stroke()
    if (item.state === 'HIDDEN') {
      text('♠', rect.x + rect.width / 2, rect.y + rect.height * 0.43, 34, '#f6c967', 'center', 'bold')
      text('点击搜索', rect.x + rect.width / 2, rect.y + rect.height - 20, 10, '#ffe8b2', 'center')
    } else {
      const card = cards.find(candidate => candidate.cardId === item.cardId)
      text(card ? card.name : '未知物资', rect.x + rect.width / 2, rect.y + 28, 13, '#351521', 'center', 'bold')
      text('◆', rect.x + rect.width / 2, rect.y + rect.height * 0.48, 28, '#6d2530', 'center')
      text(card && card.value ? formatGold(card.value) : '装备物资', rect.x + rect.width / 2, rect.y + rect.height - 33, 10, '#3d1b21', 'center', 'bold')
      text(item.state === 'DROPPED' ? '战败掉落 · 点击拾取' : '再次点击拾取', rect.x + rect.width / 2, rect.y + rect.height - 15, 8, '#5c3030', 'center')
    }
    ui.hotspots.push({ id: 'search_item', rect, data: item.instanceId })
  })
  if (available.length === 0) text('房间已搜索完毕', roomX + roomWidth / 2, viewHeight * 0.55, 16, '#cbb9b8', 'center', 'bold')
  drawInventory(state, layout.sideX, 61, layout.sideWidth)
  button('search_end', '结束搜索', { x: roomX + roomWidth - 128, y: viewHeight - 52, width: 110, height: 32 }, { size: 11 })
  ui.discardRect = { x: layout.sideX + 10, y: viewHeight - 57, width: layout.sideWidth - 20, height: 34 }
  roundedPath(ui.discardRect.x, ui.discardRect.y, ui.discardRect.width, ui.discardRect.height, 8)
  context.fillStyle = draggingItemId ? 'rgba(168,47,52,.92)' : 'rgba(55,31,42,.9)'
  context.fill()
  context.strokeStyle = '#9b5b61'
  context.stroke()
  text('拖到此处丢弃', ui.discardRect.x + ui.discardRect.width / 2, ui.discardRect.y + 17, 9, '#ead2d0', 'center')
}

function drawRoundResult(state) {
  drawMapScene(state)
  darken(0.42, '10, 5, 18')
  const local = state.players.find(player => player.id === 'P1')
  const width = Math.min(470, viewWidth * 0.57)
  const height = Math.min(250, viewHeight * 0.64)
  const x = (viewWidth - width) / 2
  const y = (viewHeight - height) / 2
  panel(x, y, width, height, { fill: 'rgba(31,18,34,.97)', stroke: PALETTE.gold, lineWidth: 2, radius: 18 })
  text(`第 ${state.turn} 回合结算`, viewWidth / 2, y + 32, 20, PALETTE.paleGold, 'center', 'bold')
  state.log.slice(0, 4).forEach((entry, index) => text(`• ${entry}`, x + 28, y + 68 + index * 24, 10, index === 0 ? '#fff2d3' : '#bfb2c1'))
  const atExit = positionKey(local.position) === C.EXTRACTION_NODE_ID
  if (atExit) {
    text('已到达白鸽撤离点，撤离将消耗 1 个回合', viewWidth / 2, y + height - 62, 10, '#9ce8c5', 'center', 'bold')
    button('request_extraction', '呼叫白鸽 · 撤离', { x: viewWidth / 2 - 92, y: y + height - 47, width: 184, height: 34 }, { top: '#2d9c71', bottom: '#175842', stroke: '#b5ffe0', size: 12 })
  } else {
    button('next_turn', '进入下一回合', { x: viewWidth / 2 - 82, y: y + height - 50, width: 164, height: 35 }, { size: 12 })
  }
}

function drawSettlement(state) {
  drawCover(assets.loading)
  darken(0.58, '15, 6, 25')
  const settlement = engine.settlementFor('P1')
  const width = Math.min(520, viewWidth * 0.62)
  const height = Math.min(310, viewHeight * 0.78)
  const x = (viewWidth - width) / 2
  const y = (viewHeight - height) / 2
  panel(x, y, width, height, { fill: 'rgba(27,15,34,.96)', stroke: settlement.success ? '#ffe078' : '#dc6a70', lineWidth: 2.5, radius: 22 })
  text(settlement.success ? '撤 离 成 功' : '本 次 大 劫 失 败', viewWidth / 2, y + 42, 26, settlement.success ? '#ffe68d' : '#ff9a9f', 'center', 'bold')
  text(settlement.reason, viewWidth / 2, y + 75, 11, '#cdbed0', 'center')
  context.strokeStyle = 'rgba(247,201,92,.3)'
  context.beginPath()
  context.moveTo(x + 40, y + 95)
  context.lineTo(x + width - 40, y + 95)
  context.stroke()
  const metrics = [
    ['撤离回合', `${settlement.turn}/${C.MAX_TURNS}`],
    ['剩余生命', `${settlement.hp}/30`],
    ['携带物资', `${settlement.itemCount} 件`],
    ['结算价值', settlement.success ? formatGold(settlement.lootValue) : '0 Gold']
  ]
  metrics.forEach((metric, index) => {
    const cx = x + width * (0.15 + index * 0.235)
    text(metric[0], cx, y + 128, 9, '#ad9eb2', 'center')
    text(metric[1], cx, y + 154, 15, index === 3 ? PALETTE.gold : '#fff0dc', 'center', 'bold')
  })
  panel(x + 34, y + 178, width - 68, 50, { fill: 'rgba(255,255,255,.04)', stroke: 'rgba(255,255,255,.14)', radius: 9 })
  text(settlement.success ? '物资已送回离岸码头仓库。本次收益将在正式服务端接入后持久化。' : '未撤离资产进入损失区。点击再来一局可重新参加匹配。', viewWidth / 2, y + 203, 10, '#c9bccb', 'center')
  button('settlement_home', '返回码头', { x: x + 48, y: y + height - 54, width: 128, height: 36 }, { top: '#514455', bottom: '#2c2330', stroke: '#a995a9', size: 11 })
  button('settlement_replay', '再来一局', { x: x + width - 176, y: y + height - 54, width: 128, height: 36 }, { top: '#d49635', bottom: '#81351f', stroke: '#ffe095', size: 11 })
}

function drawGame() {
  const state = currentState()
  if (!state) return
  if (state.phase === 'GAME_OVER') presentation = 'SETTLEMENT'
  if (presentation === 'MAP') drawMapScene(state)
  if (presentation === 'BATTLE') drawBattle(state)
  if (presentation === 'SEARCH') drawSearch(state)
  if (presentation === 'ROUND_RESULT') drawRoundResult(state)
  if (presentation === 'SETTLEMENT') drawSettlement(state)
}

function update() {
  if (scene === 'MATCHING') {
    const elapsed = Date.now() - sceneEnteredAt
    if (elapsed > 1800 && simulatedJoinStep === 0) {
      matchmaking.addParticipant({ id: 'P2', name: '黑桃客', isBot: true })
      simulatedJoinStep = 1
    }
    if (elapsed > 3600 && simulatedJoinStep === 1) {
      matchmaking.addParticipant({ id: 'P3', name: '红心客', isBot: true })
      simulatedJoinStep = 2
    }
    matchmaking.tick()
    if (matchmaking.state === 'READY') {
      matchReadyAt = Date.now()
      setScene('MATCH_FOUND')
    }
    if (matchmaking.state === 'TIMED_OUT') {
      addToast('匹配超时，房间已解散。')
      setScene('HOME')
    }
  }
  if (scene === 'MATCH_FOUND' && Date.now() - matchReadyAt > 2550) startGame()
  if (scene === 'GAME' && engine && presentation !== 'SETTLEMENT') {
    const before = engine.phase
    const result = engine.tick(Date.now())
    if (result && before === 'MOVE_SELECTION') decidePostMove()
    if (engine.phase === 'GAME_OVER') presentation = 'SETTLEMENT'
  }
}

function draw() {
  ui.hotspots = []
  ui.inventoryRects = []
  if (scene === 'LOADING') drawLoading()
  if (scene === 'HOME') drawHome()
  if (scene === 'MATCHING') drawMatchmaking(false)
  if (scene === 'MATCH_FOUND') drawMatchmaking(true)
  if (scene === 'GAME') drawGame()
  drawToast()
}

function pointInRect(point, rect) {
  return rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

function touchPoint(event, changed = true) {
  const list = changed ? event.changedTouches : event.touches
  const touch = list && list[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : { x: 0, y: 0 }
}

function nextTurn() {
  const result = engine.finishTurn()
  selectedMove = null
  activeBattle = null
  presentation = result.gameOver || engine.phase === 'GAME_OVER' ? 'SETTLEMENT' : 'MAP'
}

function handleAction(action) {
  if (!action) return
  if (action.id === 'home_start') beginMatchmaking()
  if (action.id === 'home_equipment') addToast('装备商店将在后续内容闭环开放。')
  if (action.id === 'home_map') addToast('当前测试地图：卡西诺主岛。')
  if (action.id === 'match_cancel') {
    matchmaking.cancel('P1')
    addToast('已取消匹配，空房间已销毁。')
    setScene('HOME')
  }
  if (action.id === 'match_single') {
    matchmaking.startSingleTest()
    matchReadyAt = Date.now()
    setScene('MATCH_FOUND')
  }
  if (action.id === 'map_node') selectedMove = { ...action.data }
  if (action.id === 'confirm_move') {
    const local = engine.getPlayer('P1')
    const target = selectedMove || { ...local.position }
    const result = engine.submitMove('P1', target)
    if (!result.ok) {
      addToast('该节点当前不可到达。')
      return
    }
    engine.submitBotMoves()
    engine.resolveMoves()
    decidePostMove()
  }
  if (action.id === 'battle_continue') {
    const local = engine.getPlayer('P1')
    if (local.status !== 'ACTIVE') presentation = 'SETTLEMENT'
    else if (engine.searchItemsFor('P1').some(item => ['HIDDEN', 'REVEALED', 'DROPPED'].includes(item.state))) presentation = 'SEARCH'
    else presentation = 'ROUND_RESULT'
  }
  if (action.id === 'search_item') {
    const result = engine.interactWithItem('P1', action.data)
    if (result.ok) addToast(result.action === 'REVEALED' ? '物资已显示，再点击一次拾取。' : '物资已收入背包。')
    else addToast(result.reason === 'BACKPACK_FULL' ? '背包已满，物资保留在房间。' : '当前无法拾取。')
  }
  if (action.id === 'search_end') presentation = 'ROUND_RESULT'
  if (action.id === 'next_turn') nextTurn()
  if (action.id === 'request_extraction') {
    const result = engine.requestExtraction('P1')
    if (!result.ok) {
      addToast('当前无法撤离。')
      return
    }
    addToast('白鸽接应中，正在消耗 1 个回合。')
    nextTurn()
  }
  if (action.id === 'settlement_home') {
    engine = null
    setScene('HOME')
  }
  if (action.id === 'settlement_replay') beginMatchmaking()
}

wx.onTouchStart(event => {
  const point = touchPoint(event, false)
  const inventory = ui.inventoryRects.find(rect => pointInRect(point, rect))
  draggingItemId = inventory ? inventory.instanceId : null
})

wx.onTouchEnd(event => {
  const point = touchPoint(event)
  if (draggingItemId && ui.discardRect && pointInRect(point, ui.discardRect) && engine) {
    const result = engine.dropItem('P1', draggingItemId)
    addToast(result.ok ? '物品已丢弃并保留在当前房间。' : '无法丢弃该物品。')
    draggingItemId = null
    return
  }
  draggingItemId = null
  const action = ui.hotspots.slice().reverse().find(candidate => pointInRect(point, candidate.rect))
  handleAction(action)
})

function loop() {
  update()
  draw()
  requestAnimationFrame(loop)
}

loadAssets()
loop()
