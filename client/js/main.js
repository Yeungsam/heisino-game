const cards = require('../data/cards')
const C = require('./core/constants')
const { GameEngine } = require('./core/game-engine')
const { createSeededRng } = require('./core/rng')

const canvas = wx.createCanvas()
const context = canvas.getContext('2d')
const system = wx.getSystemInfoSync()
const pixelRatio = system.pixelRatio || 1
const viewWidth = system.windowWidth
const viewHeight = system.windowHeight
canvas.width = viewWidth * pixelRatio
canvas.height = viewHeight * pixelRatio
context.scale(pixelRatio, pixelRatio)

const engine = new GameEngine({ cards, rng: createSeededRng(Date.now()), localPlayerId: 'P1' })
engine.start()

const ui = {
  cardRects: [],
  inventoryRects: [],
  endTurnRect: null,
  discardRect: null,
  draggingItemId: null,
  message: '点击相邻房间提交移动；倒计时结束时未操作视为停留。'
}

function fillRect(x, y, width, height, color) {
  context.fillStyle = color
  context.fillRect(x, y, width, height)
}

function strokeRect(x, y, width, height, color, lineWidth = 1) {
  context.strokeStyle = color
  context.lineWidth = lineWidth
  context.strokeRect(x, y, width, height)
}

function drawText(text, x, y, size = 14, color = '#efe5ce', align = 'left') {
  context.fillStyle = color
  context.font = `${size}px sans-serif`
  context.textAlign = align
  context.textBaseline = 'middle'
  context.fillText(String(text), x, y)
}

function pointInRect(point, rect) {
  return rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

function cardForItem(item) {
  return cards.find(card => card.cardId === item.cardId)
}

function formatGold(value) {
  return `${Math.round(value / 1000)}K`
}

function layout() {
  const margin = 18
  const headerHeight = 54
  const footerHeight = 82
  const gridSize = Math.min(viewHeight - headerHeight - footerHeight - margin * 2, viewWidth * 0.52)
  const cellSize = gridSize / C.BOARD_SIZE
  return {
    margin,
    headerHeight,
    footerHeight,
    gridX: margin,
    gridY: headerHeight + margin,
    gridSize,
    cellSize,
    panelX: margin * 2 + gridSize,
    panelY: headerHeight + margin,
    panelWidth: viewWidth - gridSize - margin * 3,
    panelHeight: viewHeight - headerHeight - margin * 2
  }
}

function drawHeader(state) {
  fillRect(0, 0, viewWidth, 54, '#17120f')
  drawText('大劫卡西诺 · 规则原型', 18, 27, 20, '#f4c96b')
  drawText(`回合 ${state.turn}/${C.MAX_TURNS}`, viewWidth * 0.48, 27, 16, '#ffffff', 'center')
  const deadline = state.phase === 'MOVE_SELECTION' ? state.moveDeadlineAt : state.turnDeadlineAt
  const seconds = deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0
  drawText(`${state.phase}  ${seconds}s`, viewWidth - 18, 27, 14, state.turn >= 10 ? '#ff695e' : '#d9cfbd', 'right')
}

function drawBoard(state, box) {
  const local = state.players.find(player => player.id === 'P1')
  const legalKeys = engine.legalMoves('P1').map(position => `${position.x},${position.y}`)
  const canMove = state.phase === 'MOVE_SELECTION' && local.status === 'ACTIVE'

  for (let y = 0; y < C.BOARD_SIZE; y += 1) {
    for (let x = 0; x < C.BOARD_SIZE; x += 1) {
      const px = box.gridX + x * box.cellSize
      const py = box.gridY + y * box.cellSize
      const isExtraction = x === 4 && y === 4
      const isLegal = canMove && legalKeys.includes(`${x},${y}`)
      fillRect(px + 2, py + 2, box.cellSize - 4, box.cellSize - 4, isExtraction ? '#3b594b' : '#29211b')
      strokeRect(px + 2, py + 2, box.cellSize - 4, box.cellSize - 4, isLegal ? '#f4c96b' : '#4a3c2f', isLegal ? 3 : 1)
      if (isExtraction) drawText('撤', px + box.cellSize / 2, py + box.cellSize / 2, 18, '#c4f2dc', 'center')
    }
  }

  if (state.phase !== 'MOVE_SELECTION') {
    state.players.forEach(player => {
      if (player.status !== 'ACTIVE') return
      const fromX = box.gridX + (player.previousPosition.x + 0.5) * box.cellSize
      const fromY = box.gridY + (player.previousPosition.y + 0.5) * box.cellSize
      const toX = box.gridX + (player.position.x + 0.5) * box.cellSize
      const toY = box.gridY + (player.position.y + 0.5) * box.cellSize
      context.strokeStyle = player.id === 'P1' ? '#f4c96b' : '#d16969'
      context.lineWidth = 3
      context.beginPath()
      context.moveTo(fromX, fromY)
      context.lineTo(toX, toY)
      context.stroke()
    })
  }

  state.players.forEach((player, index) => {
    if (player.status !== 'ACTIVE') return
    const centerX = box.gridX + (player.position.x + 0.5) * box.cellSize + (index - 1) * 8
    const centerY = box.gridY + (player.position.y + 0.5) * box.cellSize
    context.beginPath()
    context.arc(centerX, centerY, 10, 0, Math.PI * 2)
    context.fillStyle = player.id === 'P1' ? '#f4c96b' : (player.id === 'P2' ? '#c96767' : '#6a93d4')
    context.fill()
    drawText(player.id.slice(-1), centerX, centerY, 10, '#17120f', 'center')
  })
}

function drawPlayerSummary(state, box) {
  const local = state.players.find(player => player.id === 'P1')
  drawText(`${local.name}  HP ${local.hp}/${local.maxHp}`, box.panelX, box.panelY + 8, 18, local.hp <= 10 ? '#ff695e' : '#efe5ce')
  drawText(`背包 ${local.inventory.length}/${C.BACKPACK_SLOTS} · 物资 ${formatGold(engine.inventoryValue('P1'))}`, box.panelX, box.panelY + 36, 14, '#cbbda7')

  ui.inventoryRects = []
  const slotWidth = Math.max(42, (box.panelWidth - 14) / C.BACKPACK_SLOTS)
  local.inventory.forEach((instanceId, index) => {
    const item = state.items.find(candidate => candidate.instanceId === instanceId)
    const card = item && cardForItem(item)
    const rect = { x: box.panelX + index * slotWidth, y: box.panelY + 54, width: slotWidth - 4, height: 42, instanceId }
    fillRect(rect.x, rect.y, rect.width, rect.height, '#352b22')
    strokeRect(rect.x, rect.y, rect.width, rect.height, '#8d7046')
    drawText(card ? card.name.slice(0, 2) : '?', rect.x + rect.width / 2, rect.y + 18, 11, '#efe5ce', 'center')
    drawText(item && item.state === 'EQUIPPED' ? `耐${item.durability}` : '物资', rect.x + rect.width / 2, rect.y + 32, 9, '#cbbda7', 'center')
    ui.inventoryRects.push(rect)
  })
}

function drawSearch(state, box) {
  ui.cardRects = []
  const available = engine.searchItemsFor('P1').filter(item => ['HIDDEN', 'REVEALED', 'DROPPED'].includes(item.state))
  drawText('房间物资（点击显示，再次点击拾取）', box.panelX, box.panelY + 120, 14, '#f4c96b')
  const cardWidth = Math.min(112, (box.panelWidth - 12) / 3)
  available.slice(0, 6).forEach((item, index) => {
    const column = index % 3
    const row = Math.floor(index / 3)
    const rect = {
      x: box.panelX + column * (cardWidth + 6),
      y: box.panelY + 140 + row * 92,
      width: cardWidth,
      height: 82,
      instanceId: item.instanceId
    }
    fillRect(rect.x, rect.y, rect.width, rect.height, item.state === 'HIDDEN' ? '#201b19' : '#493827')
    strokeRect(rect.x, rect.y, rect.width, rect.height, item.state === 'HIDDEN' ? '#685a50' : '#f4c96b', 2)
    if (item.state === 'HIDDEN') {
      drawText('未搜索', rect.x + rect.width / 2, rect.y + 34, 15, '#93877e', 'center')
      drawText('点击显示', rect.x + rect.width / 2, rect.y + 58, 11, '#c4b8af', 'center')
    } else {
      const card = cardForItem(item)
      drawText(card.name, rect.x + rect.width / 2, rect.y + 28, 14, '#fff2d3', 'center')
      drawText(card.value ? formatGold(card.value) : '装备', rect.x + rect.width / 2, rect.y + 52, 12, '#f4c96b', 'center')
      drawText('再次点击拾取', rect.x + rect.width / 2, rect.y + 70, 9, '#cbbda7', 'center')
    }
    ui.cardRects.push(rect)
  })
  if (available.length === 0) drawText('本轮没有可搜索物资。', box.panelX, box.panelY + 164, 14, '#8e8277')
}

function drawActions(state, box) {
  const buttonY = viewHeight - 58
  ui.endTurnRect = { x: box.panelX, y: buttonY, width: Math.min(150, box.panelWidth * 0.45), height: 40 }
  ui.discardRect = { x: viewWidth - box.margin - 150, y: buttonY, width: 150, height: 40 }
  if (['SEARCH', 'ROUND_RESULT'].includes(state.phase)) {
    fillRect(ui.endTurnRect.x, ui.endTurnRect.y, ui.endTurnRect.width, ui.endTurnRect.height, '#8c5d2f')
    drawText('结束本回合', ui.endTurnRect.x + ui.endTurnRect.width / 2, ui.endTurnRect.y + 20, 14, '#fff6e5', 'center')
  }
  fillRect(ui.discardRect.x, ui.discardRect.y, ui.discardRect.width, ui.discardRect.height, ui.draggingItemId ? '#983f37' : '#392725')
  strokeRect(ui.discardRect.x, ui.discardRect.y, ui.discardRect.width, ui.discardRect.height, '#a55b52')
  drawText('拖背包物品到此丢弃', ui.discardRect.x + ui.discardRect.width / 2, ui.discardRect.y + 20, 12, '#e9c4be', 'center')
}

function drawLog(state, box) {
  const startY = Math.min(box.panelY + 344, viewHeight - 120)
  state.log.slice(0, 3).forEach((entry, index) => drawText(entry, box.panelX, startY + index * 20, 11, '#ad9f8b'))
  drawText(ui.message, box.margin, viewHeight - 22, 12, '#d9cfbd')
}

function draw() {
  const state = engine.snapshot()
  const box = layout()
  fillRect(0, 0, viewWidth, viewHeight, '#100d0b')
  drawHeader(state)
  drawBoard(state, box)
  drawPlayerSummary(state, box)
  if (state.phase === 'SEARCH') drawSearch(state, box)
  drawActions(state, box)
  drawLog(state, box)
}

function boardPosition(point) {
  const box = layout()
  if (point.x < box.gridX || point.y < box.gridY || point.x > box.gridX + box.gridSize || point.y > box.gridY + box.gridSize) return null
  return {
    x: Math.min(C.BOARD_SIZE - 1, Math.floor((point.x - box.gridX) / box.cellSize)),
    y: Math.min(C.BOARD_SIZE - 1, Math.floor((point.y - box.gridY) / box.cellSize))
  }
}

function touchPoint(event) {
  const touch = event.changedTouches[0]
  return { x: touch.clientX, y: touch.clientY }
}

wx.onTouchStart(event => {
  const point = touchPoint(event)
  const slot = ui.inventoryRects.find(rect => pointInRect(point, rect))
  ui.draggingItemId = slot ? slot.instanceId : null
})

wx.onTouchEnd(event => {
  const point = touchPoint(event)
  const state = engine.snapshot()

  if (ui.draggingItemId && pointInRect(point, ui.discardRect)) {
    const result = engine.dropItem('P1', ui.draggingItemId)
    ui.message = result.ok ? '物品已丢弃并保留在当前房间。' : `无法丢弃：${result.reason}`
    ui.draggingItemId = null
    return
  }
  ui.draggingItemId = null

  if (state.phase === 'MOVE_SELECTION') {
    const position = boardPosition(point)
    if (!position) return
    const result = engine.submitMove('P1', position)
    if (!result.ok) {
      ui.message = '只能选择相邻节点或停留原地。'
      return
    }
    ui.message = '移动已锁定，其他玩家的选择在统一结算前不可见。'
    engine.submitBotMoves()
    engine.resolveMoves()
    return
  }

  const cardRect = ui.cardRects.find(rect => pointInRect(point, rect))
  if (cardRect) {
    const result = engine.interactWithItem('P1', cardRect.instanceId)
    if (result.ok) ui.message = result.action === 'REVEALED' ? '物资已显示，再点击一次拾取。' : '物资已放入背包。'
    else ui.message = result.reason === 'BACKPACK_FULL' ? '背包已满，物资仍保留在房间。' : `无法操作：${result.reason}`
    return
  }

  if (pointInRect(point, ui.endTurnRect) && ['SEARCH', 'ROUND_RESULT'].includes(state.phase)) {
    engine.finishTurn()
    ui.message = '已进入下一回合。'
  }
})

function loop() {
  engine.tick(Date.now())
  draw()
  requestAnimationFrame(loop)
}

loop()
