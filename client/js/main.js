const bundledCards = require('../data/cards')
const C = require('./core/constants')
const { GameEngine, positionKey } = require('./core/game-engine')
const { MatchmakingSession } = require('./core/matchmaking')
const { LoadoutSession } = require('./core/loadout')
const { createSeededRng } = require('./core/rng')
const { fetchCardCatalog } = require('./api/cards')
const { cardAssetBaseUrl } = require('./config')
const { createCardCatalogIndex, resolveCardAssetUrl } = require('./ui/card-art')
const {
  ROOM_MASK_ALPHA,
  PIN_TRANSITION_MS,
  LANDMARK_ROOMS,
  createMovementLayout,
  landmarkIconRect,
  roomRect,
  roomHighlightStyle,
  roomTypeAt,
  pinTransitionOpacity
} = require('./ui/movement-map')

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
  homeMenu: 'assets/home-menu.jpg',
  home: 'assets/home.jpg',
  movementMap: 'assets/movement-map.jpg',
  map: 'assets/map.jpg',
  characters: 'assets/characters.jpg',
  loading: 'assets/loading.jpg'
}
const assets = {}
const cardImages = {}
const PLAYER_ACCOUNT_GOLD = 12000
const CARD_PAGE_SIZE = 10
let assetsLoaded = 0
let baseAssetsReady = false
let cardCatalogReady = false
let cardCatalogSource = 'LOADING'
let scene = 'LOADING'
let sceneEnteredAt = Date.now()
let matchmaking = new MatchmakingSession()
let cards = bundledCards
let cardsById = createCardCatalogIndex(cards)
let loadout = new LoadoutSession({ cards })
let engine = null
let presentation = 'MAP'
let selectedMove = null
let movementPinPosition = null
let movementPinTransition = null
let activeBattle = null
let matchReadyAt = null
let simulatedJoinStep = 0
let toast = ''
let toastUntil = 0
let draggingItemId = null
let loadoutSelection = null
let loadoutDragging = null
let warehouseFilter = 'ALL'
let warehousePage = 0
let warehouseSelection = null
let loadoutPage = 0

const ui = {
  hotspots: [],
  inventoryRects: [],
  discardRect: null,
  loadoutWarehouseRects: [],
  loadoutBackpackRects: [],
  loadoutWarehouseDropRect: null,
  loadoutBackpackDropRect: null
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
        baseAssetsReady = true
        finishBoot()
      }
    }
    image.onerror = () => {
      assetsLoaded += 1
      if (assetsLoaded === Object.keys(assetSources).length) {
        baseAssetsReady = true
        finishBoot()
      }
    }
    image.src = assetSources[key]
  })
}

function finishBoot() {
  if (scene !== 'LOADING' || !baseAssetsReady || !cardCatalogReady) return
  setTimeout(() => setScene('HOME'), 350)
}

function beginCardImageLoad(card, record) {
  const image = wx.createImage()
  record.image = image
  record.status = 'LOADING'
  record.ready = false
  record.failed = false
  record.attempts += 1
  image.onload = () => {
    record.status = 'READY'
    record.ready = true
    record.failed = false
  }
  image.onerror = error => {
    record.status = 'FAILED'
    record.ready = false
    record.failed = true
    record.error = error
    record.retryAt = Date.now() + 2000 * record.attempts
    console.error(`[card-art] failed to load ${card.cardId}: ${record.url}`)
  }
  image.src = record.url
}

function cardImage(card) {
  if (!card) return null
  const url = resolveCardAssetUrl(card, cardAssetBaseUrl)
  if (!url) return { status: 'FAILED', ready: false, failed: true, url: null }
  if (!cardImages[url]) {
    const record = { image: null, status: 'IDLE', ready: false, failed: false, url, attempts: 0, retryAt: 0 }
    cardImages[url] = record
    beginCardImageLoad(card, record)
  }
  const record = cardImages[url]
  if (record.failed && record.attempts < 3 && Date.now() >= record.retryAt) beginCardImageLoad(card, record)
  return record
}

function cardById(cardId) {
  return cardId ? cardsById[cardId] || null : null
}

function applyCardCatalog(nextCards, source) {
  cards = nextCards
  cardsById = createCardCatalogIndex(cards)
  loadout = new LoadoutSession({ cards })
  cardCatalogSource = source
  cardCatalogReady = true
  finishBoot()
}

function loadCardCatalog() {
  fetchCardCatalog()
    .then(catalog => applyCardCatalog(catalog.cards, 'SERVER'))
    .catch(() => applyCardCatalog(bundledCards, 'LOCAL_CACHE'))
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

function drawContained(image) {
  if (!image) return
  const scale = Math.min(viewWidth / image.width, viewHeight / image.height)
  const width = image.width * scale
  const height = image.height * scale
  context.drawImage(image, (viewWidth - width) / 2, (viewHeight - height) / 2, width, height)
}

function drawContainedBackdrop(image, color = '#110a12') {
  context.fillStyle = color
  context.fillRect(0, 0, viewWidth, viewHeight)
  drawContained(image)
}

function containedSourceRect(image, sourceRect) {
  if (!image) return sourceRect
  const scale = Math.min(viewWidth / image.width, viewHeight / image.height)
  const offsetX = (viewWidth - image.width * scale) / 2
  const offsetY = (viewHeight - image.height * scale) / 2
  return {
    x: offsetX + sourceRect.x * scale,
    y: offsetY + sourceRect.y * scale,
    width: sourceRect.width * scale,
    height: sourceRect.height * scale
  }
}

function drawImageCoverInRect(image, rect, source = null) {
  if (!image) return
  const sx = source ? source.x : 0
  const sy = source ? source.y : 0
  const sw = source ? source.width : image.width
  const sh = source ? source.height : image.height
  const scale = Math.max(rect.width / sw, rect.height / sh)
  const width = sw * scale
  const height = sh * scale
  context.save()
  roundedPath(rect.x, rect.y, rect.width, rect.height, 14)
  context.clip()
  context.drawImage(image, sx, sy, sw, sh, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height)
  context.restore()
}

function drawImageContainInRect(image, rect, radius = 7) {
  if (!image) return
  const scale = Math.min(rect.width / image.width, rect.height / image.height)
  const width = image.width * scale
  const height = image.height * scale
  context.save()
  roundedPath(rect.x, rect.y, rect.width, rect.height, radius)
  context.clip()
  context.drawImage(image, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height)
  context.restore()
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
  const centerY = scene === 'HOME' ? viewHeight * 0.73 : viewHeight - 36
  panel((viewWidth - width) / 2, centerY - 18, width, 36, { fill: 'rgba(20,12,18,.94)', stroke: PALETTE.gold, radius: 18 })
  text(toast, viewWidth / 2, centerY, 12, PALETTE.paleGold, 'center', 'bold')
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
  drawContainedBackdrop(assets.homeMenu, '#120b16')
  const shopRect = containedSourceRect(assets.homeMenu, { x: 382, y: 590, width: 246, height: 112 })
  const warehouseRect = containedSourceRect(assets.homeMenu, { x: 630, y: 590, width: 266, height: 112 })
  const startRect = containedSourceRect(assets.homeMenu, { x: 900, y: 580, width: 356, height: 126 })
  ui.hotspots.push({ id: 'home_shop', rect: shopRect })
  ui.hotspots.push({ id: 'home_warehouse', rect: warehouseRect })
  ui.hotspots.push({ id: 'home_start', rect: startRect })
}

function enterLoadout() {
  loadoutSelection = null
  loadoutDragging = null
  loadoutPage = 0
  setScene('LOADOUT')
}

function enterWarehouse() {
  warehouseFilter = 'ALL'
  warehousePage = 0
  warehouseSelection = null
  setScene('WAREHOUSE')
}

function cardColor(card) {
  const colors = {
    RED: '#df4854',
    PURPLE: '#9d6ae5',
    BLUE: '#4e9bd8',
    GREEN: '#55b985',
    SPECIAL: '#d9a43e'
  }
  return colors[card.rarity] || '#9b8d99'
}

function cardMeta(card) {
  if (card.category === 'WEAPON') return `武器卡 · 攻击倍率 ${Math.round((card.attackMultiplier || 0) * 100)}% · 耐久 ${card.maxDurability}/${card.maxDurability}`
  if (card.category === 'ARMOR') return `防具卡 · 耐久 ${card.maxDurability}/${card.maxDurability}`
  if (card.category === 'SKILL') return `技能卡 · ${card.description}`
  return `物资卡 · ${card.value !== null ? formatGold(card.value) : '价值待定'}`
}

function drawCardArt(card, rect, options = {}) {
  const color = card ? cardColor(card) : '#776979'
  const radius = options.radius || 7
  const inset = options.inset ?? 2
  const art = cardImage(card)
  context.save()
  roundedPath(rect.x, rect.y, rect.width, rect.height, radius)
  context.fillStyle = 'rgba(12,9,14,.98)'
  context.fill()
  if (art && art.ready) {
    drawImageContainInRect(art.image, {
      x: rect.x + inset,
      y: rect.y + inset,
      width: rect.width - inset * 2,
      height: rect.height - inset * 2
    }, Math.max(2, radius - 2))
  } else {
    const gradient = context.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height)
    gradient.addColorStop(0, 'rgba(70,48,72,.96)')
    gradient.addColorStop(1, 'rgba(20,14,24,.98)')
    context.fillStyle = gradient
    context.fill()
    const failed = !art || art.failed
    text(failed ? '卡面加载失败' : '卡面加载中', rect.x + rect.width / 2, rect.y + rect.height / 2 - 5, Math.max(7, Math.min(10, rect.width * 0.11)), failed ? '#ff9b9b' : '#ddcfdb', 'center', 'bold')
    if (failed && card) text(card.name, rect.x + rect.width / 2, rect.y + rect.height / 2 + 11, Math.max(6, Math.min(8, rect.width * 0.09)), '#d2bdca', 'center')
  }
  roundedPath(rect.x, rect.y, rect.width, rect.height, radius)
  context.strokeStyle = options.stroke || color
  context.lineWidth = options.lineWidth || 1.2
  context.stroke()
  context.restore()
  return art
}

function drawCasinoCardBack(rect) {
  context.save()
  roundedPath(rect.x, rect.y, rect.width, rect.height, 10)
  const gradient = context.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height)
  gradient.addColorStop(0, '#b32638')
  gradient.addColorStop(0.5, '#70172c')
  gradient.addColorStop(1, '#271329')
  context.fillStyle = gradient
  context.fill()
  context.strokeStyle = '#ffd26a'
  context.lineWidth = 2
  context.stroke()
  roundedPath(rect.x + 6, rect.y + 6, rect.width - 12, rect.height - 12, 7)
  context.strokeStyle = 'rgba(255,220,135,.65)'
  context.lineWidth = 1
  context.stroke()
  text('♠', rect.x + rect.width / 2, rect.y + rect.height * 0.38, Math.max(24, rect.width * 0.34), '#f7c95c', 'center', 'bold')
  text('HEISINO', rect.x + rect.width / 2, rect.y + rect.height * 0.62, Math.max(7, rect.width * 0.09), '#fff0b0', 'center', 'bold')
  text('点击搜索', rect.x + rect.width / 2, rect.y + rect.height - 18, Math.max(8, rect.width * 0.09), '#ffe8b2', 'center')
  context.restore()
}

function drawLoadoutCard(card, rect, selected, location) {
  const color = cardColor(card)
  drawCardArt(card, rect, { stroke: selected ? PALETTE.paleGold : color, lineWidth: selected ? 2.5 : 1.2 })
  context.save()
  if (selected) {
    roundedPath(rect.x, rect.y, rect.width, rect.height, 7)
    context.strokeStyle = PALETTE.paleGold
    context.lineWidth = 2.5
    context.shadowColor = PALETTE.gold
    context.shadowBlur = 12
    context.stroke()
  }
  if (location === 'BACKPACK') {
    context.fillStyle = 'rgba(13,8,16,.78)'
    context.fillRect(rect.x + 3, rect.y + rect.height - 16, rect.width - 6, 13)
    text('已携带', rect.x + rect.width / 2, rect.y + rect.height - 9, 7, '#9ff0c5', 'center', 'bold')
  }
  context.restore()
}

function addLoadoutCard(cardId) {
  const result = loadout.add(cardId)
  if (result.ok) {
    loadoutSelection = null
    addToast('卡牌已放入行动背包。')
    return true
  }
  addToast(result.reason === 'LOADOUT_FULL' ? '本次行动最多携带 4 张卡牌。' : '该卡牌无法放入背包。')
  return false
}

function removeLoadoutCard(cardId) {
  const result = loadout.remove(cardId)
  if (result.ok) {
    loadoutSelection = null
    addToast('卡牌已放回仓库。')
    return true
  }
  return false
}

function warehouseCards() {
  const ownedCardIds = loadout.snapshot().ownedCardIds
  return cards.filter(card => {
    if (!ownedCardIds.includes(card.cardId)) return false
    if (warehouseFilter !== 'ALL') return card.category === warehouseFilter
    return true
  })
}

function warehouseFilterButton(id, label, filter, rect) {
  const active = warehouseFilter === filter
  button(id, label, rect, {
    top: active ? '#c3872d' : '#554457',
    bottom: active ? '#7a351f' : '#29212e',
    stroke: active ? '#ffe08d' : '#8f7a92',
    color: active ? '#fff4ca' : '#c9bacb',
    size: 9,
    radius: 8
  })
}

function drawWarehouse() {
  drawCover(assets.homeMenu)
  darken(0.72, '13, 7, 24')

  const margin = Math.max(12, viewWidth * 0.055)
  const top = 50
  const bottom = 54
  const panelRect = { x: margin, y: top, width: viewWidth - margin * 2, height: viewHeight - top - bottom }
  panel(panelRect.x, panelRect.y, panelRect.width, panelRect.height, { fill: 'rgba(27,18,34,.96)', stroke: '#d8a84b', lineWidth: 2, radius: 17 })

  const headerGradient = context.createLinearGradient(0, 0, viewWidth, 0)
  headerGradient.addColorStop(0, 'rgba(92,22,43,.98)')
  headerGradient.addColorStop(0.55, 'rgba(43,23,52,.98)')
  headerGradient.addColorStop(1, 'rgba(25,25,55,.98)')
  context.fillStyle = headerGradient
  context.fillRect(0, 0, viewWidth, 42)
  context.strokeStyle = 'rgba(247,201,92,.72)'
  context.beginPath()
  context.moveTo(0, 41)
  context.lineTo(viewWidth, 41)
  context.stroke()
  text('玩 家 仓 库', 16, 21, 18, PALETTE.paleGold, 'left', 'bold')
  text('查看当前账号持有的全部卡牌', viewWidth / 2, 21, 10, '#d6c7d8', 'center')
  text(`拥有 ${loadout.snapshot().ownedCardIds.length}/${cards.length} · ${cardCatalogSource === 'SERVER' ? '云端卡库' : '本地缓存'}`, viewWidth - 16, 21, 9, cardCatalogSource === 'SERVER' ? '#9fe5c2' : '#ffd47d', 'right', 'bold')

  const filterY = panelRect.y + 11
  const filterGap = 4
  const pagerWidth = 82
  const filterWidth = (panelRect.width - 24 - pagerWidth - filterGap * 4) / 5
  const filters = [
    ['warehouse_filter_all', '全部', 'ALL'],
    ['warehouse_filter_weapon', '武器', 'WEAPON'],
    ['warehouse_filter_armor', '防具', 'ARMOR'],
    ['warehouse_filter_skill', '技能', 'SKILL'],
    ['warehouse_filter_loot', '物资', 'LOOT']
  ]
  filters.forEach((filter, index) => {
    warehouseFilterButton(filter[0], filter[1], filter[2], {
      x: panelRect.x + 12 + index * (filterWidth + filterGap),
      y: filterY,
      width: filterWidth,
      height: 27
    })
  })

  const filteredCards = warehouseCards()
  const totalPages = Math.max(1, Math.ceil(filteredCards.length / CARD_PAGE_SIZE))
  warehousePage = Math.min(warehousePage, totalPages - 1)
  const visibleCards = filteredCards.slice(warehousePage * CARD_PAGE_SIZE, (warehousePage + 1) * CARD_PAGE_SIZE)
  const pagerX = panelRect.x + panelRect.width - pagerWidth - 10
  button('warehouse_page_prev', '‹', { x: pagerX, y: filterY, width: 25, height: 27 }, { top: '#554457', bottom: '#29212e', stroke: '#8f7a92', size: 16, radius: 7 })
  text(`${warehousePage + 1}/${totalPages}`, pagerX + 41, filterY + 14, 8, '#d4c5d1', 'center', 'bold')
  button('warehouse_page_next', '›', { x: pagerX + 57, y: filterY, width: 25, height: 27 }, { top: '#554457', bottom: '#29212e', stroke: '#8f7a92', size: 16, radius: 7 })
  const gridTop = panelRect.y + 48
  const detailHeight = 45
  const gridBottom = panelRect.y + panelRect.height - detailHeight - 8
  const columns = 5
  const rows = 2
  const gap = 8
  const cardWidth = (panelRect.width - 24 - gap * (columns - 1)) / columns
  const cardHeight = Math.max(56, (gridBottom - gridTop - gap) / rows)
  visibleCards.forEach((card, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const rect = {
      x: panelRect.x + 12 + column * (cardWidth + gap),
      y: gridTop + row * (cardHeight + gap),
      width: cardWidth,
      height: cardHeight
    }
    drawLoadoutCard(card, rect, warehouseSelection === card.cardId, 'WAREHOUSE')
    ui.hotspots.push({ id: 'warehouse_card', rect, data: card.cardId })
  })

  const selectedCard = cardById(warehouseSelection)
  const detailY = panelRect.y + panelRect.height - detailHeight
  context.fillStyle = 'rgba(255,255,255,.04)'
  context.fillRect(panelRect.x + 1, detailY, panelRect.width - 2, detailHeight - 1)
  text(selectedCard ? selectedCard.name : '卡牌详情', panelRect.x + 14, detailY + 14, 11, selectedCard ? cardColor(selectedCard) : '#b9a9b7', 'left', 'bold')
  text(selectedCard ? cardMeta(selectedCard) : '点击真实卡面查看详情；仓库中的卡牌不会自动带入对局。', panelRect.x + 14, detailY + 31, 9, '#d4c5d1')

  button('warehouse_home', '返回首页', { x: 14, y: viewHeight - 43, width: 124, height: 31 }, { top: '#554653', bottom: '#2a222c', stroke: '#a692a4', size: 11 })
  text(`当前分类 ${filteredCards.length} 张 · 第 ${warehousePage + 1}/${totalPages} 页`, viewWidth / 2, viewHeight - 28, 9, '#c6b8c8', 'center')
}

function drawLoadout() {
  drawCover(assets.home)
  darken(0.68, '20, 8, 26')
  const top = 48
  const bottom = 58
  const gap = 10
  const contentHeight = viewHeight - top - bottom
  const npcWidth = viewWidth * 0.22
  const backpackWidth = viewWidth * 0.245
  const warehouseWidth = viewWidth - npcWidth - backpackWidth - gap * 4
  const npcRect = { x: gap, y: top, width: npcWidth, height: contentHeight }
  const warehouseRect = { x: npcRect.x + npcRect.width + gap, y: top, width: warehouseWidth, height: contentHeight }
  const backpackRect = { x: warehouseRect.x + warehouseRect.width + gap, y: top, width: backpackWidth, height: contentHeight }
  const state = loadout.snapshot()

  const headerGradient = context.createLinearGradient(0, 0, viewWidth, 0)
  headerGradient.addColorStop(0, 'rgba(126,24,38,.97)')
  headerGradient.addColorStop(0.55, 'rgba(47,23,48,.97)')
  headerGradient.addColorStop(1, 'rgba(31,20,46,.97)')
  context.fillStyle = headerGradient
  context.fillRect(0, 0, viewWidth, 42)
  context.strokeStyle = 'rgba(247,201,92,.75)'
  context.beginPath()
  context.moveTo(0, 41)
  context.lineTo(viewWidth, 41)
  context.stroke()
  text('行 动 战 备', 16, 21, 18, PALETTE.paleGold, 'left', 'bold')
  text('卡西诺主岛 · 进入匹配前配置本次携带物资', viewWidth / 2, 21, 10, '#d9c9d6', 'center')
  text(`已携带 ${state.selectedCardIds.length}/${C.LOADOUT_CARD_LIMIT}`, viewWidth - 16, 21, 11, state.selectedCardIds.length === C.LOADOUT_CARD_LIMIT ? '#ffcf68' : '#9fe5c2', 'right', 'bold')

  panel(npcRect.x, npcRect.y, npcRect.width, npcRect.height, { fill: 'rgba(39,20,33,.93)', stroke: '#bd785d', radius: 15 })
  const npcImageRect = { x: npcRect.x + 6, y: npcRect.y + 6, width: npcRect.width - 12, height: npcRect.height * 0.65 }
  drawImageCoverInRect(assets.home, npcImageRect, assets.home ? { x: 0, y: 0, width: assets.home.width * 0.58, height: assets.home.height } : null)
  const speechRect = { x: npcRect.x + 9, y: npcRect.y + npcRect.height * 0.61, width: npcRect.width - 18, height: npcRect.height * 0.34 }
  panel(speechRect.x, speechRect.y, speechRect.width, speechRect.height, { fill: 'rgba(255,244,220,.96)', stroke: '#d59d54', radius: 10 })
  text('白鸽接应员', speechRect.x + 10, speechRect.y + 15, 10, '#9d2e38', 'left', 'bold')
  text('行动前准备好武器、', speechRect.x + 10, speechRect.y + 36, 9, '#3a2830')
  text('防具或者技能。', speechRect.x + 10, speechRect.y + 51, 9, '#3a2830')
  text('准备好了再出发。', speechRect.x + 10, speechRect.y + 66, 9, '#3a2830', 'left', 'bold')

  panel(warehouseRect.x, warehouseRect.y, warehouseRect.width, warehouseRect.height, { fill: 'rgba(31,20,35,.94)', stroke: 'rgba(247,201,92,.74)', radius: 15 })
  text('玩家仓库', warehouseRect.x + 14, warehouseRect.y + 18, 14, PALETTE.paleGold, 'left', 'bold')
  const loadoutPages = Math.max(1, Math.ceil(state.warehouseCardIds.length / CARD_PAGE_SIZE))
  loadoutPage = Math.min(loadoutPage, loadoutPages - 1)
  const loadoutPagerX = warehouseRect.x + warehouseRect.width - 88
  button('loadout_page_prev', '‹', { x: loadoutPagerX, y: warehouseRect.y + 5, width: 23, height: 24 }, { top: '#554457', bottom: '#29212e', stroke: '#8f7a92', size: 15, radius: 6 })
  text(`${loadoutPage + 1}/${loadoutPages}`, loadoutPagerX + 44, warehouseRect.y + 17, 8, '#d9cad8', 'center', 'bold')
  button('loadout_page_next', '›', { x: loadoutPagerX + 65, y: warehouseRect.y + 5, width: 23, height: 24 }, { top: '#554457', bottom: '#29212e', stroke: '#8f7a92', size: 15, radius: 6 })
  ui.loadoutWarehouseDropRect = warehouseRect
  const detailHeight = 36
  const gridTop = warehouseRect.y + 34
  const gridHeight = warehouseRect.height - 42 - detailHeight
  const columns = 5
  const rows = 2
  const cardGap = 6
  const cardWidth = (warehouseRect.width - 20 - cardGap * (columns - 1)) / columns
  const cardHeight = (gridHeight - cardGap) / rows
  const visibleWarehouseIds = state.warehouseCardIds.slice(loadoutPage * CARD_PAGE_SIZE, (loadoutPage + 1) * CARD_PAGE_SIZE)
  visibleWarehouseIds.forEach((cardId, index) => {
    const card = cardById(cardId)
    const column = index % columns
    const row = Math.floor(index / columns)
    const rect = { x: warehouseRect.x + 10 + column * (cardWidth + cardGap), y: gridTop + row * (cardHeight + cardGap), width: cardWidth, height: cardHeight }
    const selected = loadoutSelection && loadoutSelection.cardId === cardId && loadoutSelection.source === 'WAREHOUSE'
    drawLoadoutCard(card, rect, selected, 'WAREHOUSE')
    ui.loadoutWarehouseRects.push({ ...rect, cardId })
    ui.hotspots.push({ id: 'loadout_warehouse_card', rect, data: cardId })
  })
  if (state.warehouseCardIds.length === 0) text('仓库中暂无可选卡牌', warehouseRect.x + warehouseRect.width / 2, warehouseRect.y + warehouseRect.height / 2, 11, '#8e7e8c', 'center')

  const selectedCard = loadoutSelection && cardById(loadoutSelection.cardId)
  const detailY = warehouseRect.y + warehouseRect.height - detailHeight
  context.fillStyle = 'rgba(255,255,255,.035)'
  context.fillRect(warehouseRect.x + 1, detailY, warehouseRect.width - 2, detailHeight - 1)
  text(selectedCard ? selectedCard.name : '操作提示', warehouseRect.x + 13, detailY + 12, 10, selectedCard ? cardColor(selectedCard) : '#b9a9b7', 'left', 'bold')
  text(selectedCard ? `${cardMeta(selectedCard)} · 再次点击${loadoutSelection.source === 'WAREHOUSE' ? '放入背包' : '放回仓库'}` : '拖拽卡牌，或点开后再次点击', warehouseRect.x + 13, detailY + 27, 8, '#d4c5d1')

  panel(backpackRect.x, backpackRect.y, backpackRect.width, backpackRect.height, { fill: 'rgba(27,19,34,.96)', stroke: 'rgba(154,112,208,.82)', radius: 15 })
  text('行动背包', backpackRect.x + 12, backpackRect.y + 18, 14, '#e9d7ff', 'left', 'bold')
  text('10 格 · 最多带 4 张', backpackRect.x + backpackRect.width - 10, backpackRect.y + 18, 8, '#ae9aba', 'right')
  ui.loadoutBackpackDropRect = backpackRect
  const bagColumns = 2
  const bagRows = 5
  const bagGap = 5
  const bagTop = backpackRect.y + 34
  const slotWidth = (backpackRect.width - 20 - bagGap) / bagColumns
  const slotHeight = (backpackRect.height - 44 - bagGap * (bagRows - 1)) / bagRows
  for (let index = 0; index < C.BACKPACK_SLOTS; index += 1) {
    const column = index % bagColumns
    const row = Math.floor(index / bagColumns)
    const rect = { x: backpackRect.x + 10 + column * (slotWidth + bagGap), y: bagTop + row * (slotHeight + bagGap), width: slotWidth, height: slotHeight }
    roundedPath(rect.x, rect.y, rect.width, rect.height, 6)
    context.fillStyle = index < C.LOADOUT_CARD_LIMIT ? 'rgba(103,61,113,.22)' : 'rgba(255,255,255,.035)'
    context.fill()
    context.strokeStyle = index < C.LOADOUT_CARD_LIMIT ? 'rgba(205,161,241,.45)' : 'rgba(255,255,255,.13)'
    context.stroke()
    const cardId = state.selectedCardIds[index]
    if (cardId) {
      const card = cardById(cardId)
      const selected = loadoutSelection && loadoutSelection.cardId === cardId && loadoutSelection.source === 'BACKPACK'
      drawLoadoutCard(card, rect, selected, 'BACKPACK')
      ui.loadoutBackpackRects.push({ ...rect, cardId })
      ui.hotspots.push({ id: 'loadout_backpack_card', rect, data: cardId })
    } else if (index < C.LOADOUT_CARD_LIMIT) {
      text(`携带位 ${index + 1}`, rect.x + rect.width / 2, rect.y + rect.height / 2, 8, '#8f7899', 'center')
    } else {
      text(`${index + 1}`, rect.x + rect.width / 2, rect.y + rect.height / 2, 8, '#5d5361', 'center')
    }
  }
  if (loadoutDragging) {
    const target = loadoutDragging.source === 'WAREHOUSE' ? backpackRect : warehouseRect
    context.save()
    roundedPath(target.x + 3, target.y + 3, target.width - 6, target.height - 6, 12)
    context.strokeStyle = '#ffe18b'
    context.lineWidth = 3
    context.setLineDash([8, 5])
    context.stroke()
    context.restore()
  }

  context.fillStyle = 'rgba(22,13,25,.96)'
  context.fillRect(0, viewHeight - bottom + 4, viewWidth, bottom - 4)
  context.strokeStyle = 'rgba(247,201,92,.45)'
  context.beginPath()
  context.moveTo(0, viewHeight - bottom + 4)
  context.lineTo(viewWidth, viewHeight - bottom + 4)
  context.stroke()
  button('loadout_home', '返回首页', { x: 14, y: viewHeight - 45, width: 124, height: 32 }, { top: '#554653', bottom: '#2a222c', stroke: '#a692a4', size: 11 })
  text('可空手出发 · 推荐至少携带 1 张武器卡', viewWidth / 2, viewHeight - 28, 9, '#b9a9b8', 'center')
  button('loadout_match', '开始匹配', { x: viewWidth - 154, y: viewHeight - 47, width: 140, height: 35 }, { top: '#dc9f3a', bottom: '#882e25', stroke: '#ffe19a', size: 12 })
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
  text(`本次战备 ${loadout.snapshot().selectedCardIds.length}/${C.LOADOUT_CARD_LIMIT}`, x + panelWidth - 18, y + 34, 9, '#bcaac2', 'right', 'bold')

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
  engine = new GameEngine({
    cards,
    rng: createSeededRng(Date.now()),
    localPlayerId: 'P1',
    localLoadoutCardIds: loadout.snapshot().selectedCardIds
  })
  engine.start()
  selectedMove = null
  movementPinPosition = { ...engine.getPlayer('P1').position }
  movementPinTransition = null
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
  const weaponCard = weapon && cardById(weapon.cardId)
  panel(x + 10, y + 38, width - 20, 46, { fill: 'rgba(98,30,40,.55)', stroke: '#b57962', radius: 8 })
  const equippedArtRect = { x: x + 14, y: y + 42, width: 30, height: 38 }
  if (weaponCard) drawCardArt(weaponCard, equippedArtRect, { radius: 5, inset: 1, lineWidth: 1 })
  const weaponTextX = weaponCard ? x + 51 : x + 20
  text(weaponCard ? weaponCard.name : '徒手', weaponTextX, y + 54, 12, '#fff2d5', 'left', 'bold')
  const weaponMaxDurability = weaponCard && weaponCard.maxDurability ? weaponCard.maxDurability : 2
  text(weapon ? `耐久 ${'■'.repeat(weapon.durability)}${'□'.repeat(Math.max(0, weaponMaxDurability - weapon.durability))}` : '攻击倍率 0.3', weaponTextX, y + 72, 9, '#d7bca9')
  text(`背包 ${local.inventory.length}/${C.BACKPACK_SLOTS}`, x + 14, y + 103, 11, '#d8cbd7', 'left', 'bold')
  ui.inventoryRects = []
  const columns = 5
  const rows = Math.ceil(C.BACKPACK_SLOTS / columns)
  const gap = 5
  const slotByWidth = (width - 20 - gap * (columns - 1)) / columns
  const availableGridHeight = Math.max(60, viewHeight - 70 - (y + 117) - 8)
  const slotByHeight = (availableGridHeight - gap * (rows - 1)) / rows
  const slot = Math.min(slotByWidth, slotByHeight)
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
      const card = item && cardById(item.cardId)
      drawCardArt(card, rect, { radius: 6, inset: 2, stroke: 'rgba(230,198,125,.55)', lineWidth: 1 })
      if (item && item.state === 'EQUIPPED') {
        context.fillStyle = 'rgba(74,18,25,.84)'
        context.fillRect(rect.x + 2, rect.y + rect.height - 14, rect.width - 4, 12)
        text('装备', rect.x + rect.width / 2, rect.y + rect.height - 8, 7, '#ffe0a0', 'center', 'bold')
      }
      if (interactive) ui.inventoryRects.push({ ...rect, instanceId })
    }
  }
}

function drawHudPlate(rect, options = {}) {
  context.save()
  roundedPath(rect.x, rect.y, rect.width, rect.height, Math.max(6, rect.height * 0.2))
  const gradient = context.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height)
  gradient.addColorStop(0, options.top || 'rgba(34,17,22,.98)')
  gradient.addColorStop(1, options.bottom || 'rgba(9,7,12,.98)')
  context.fillStyle = gradient
  context.fill()
  context.strokeStyle = options.stroke || '#f2c14e'
  context.lineWidth = Math.max(1.5, rect.height * 0.045)
  context.stroke()
  roundedPath(rect.x + 3, rect.y + 3, rect.width - 6, rect.height - 6, Math.max(4, rect.height * 0.16))
  context.strokeStyle = options.inner || 'rgba(170,36,37,.9)'
  context.lineWidth = Math.max(1, rect.height * 0.02)
  context.stroke()
  context.restore()
}

function drawMovementRooms(state, layout) {
  const local = state.players.find(player => player.id === 'P1')
  const selecting = state.phase === 'MOVE_SELECTION'
  const legalKeys = new Set(selecting ? engine.legalMoves('P1').map(position => `${position.x},${position.y}`) : [])
  const scale = layout.transform.scale

  for (let y = 0; y < C.BOARD_SIZE; y += 1) {
    for (let x = 0; x < C.BOARD_SIZE; x += 1) {
      const key = `${x},${y}`
      const current = local.position.x === x && local.position.y === y
      const reachable = legalKeys.has(key) && !current
      const selected = selectedMove && selectedMove.x === x && selectedMove.y === y
      const highlightState = current ? 'CURRENT' : selected ? 'SELECTED' : reachable ? 'REACHABLE' : null
      const highlight = roomHighlightStyle(highlightState)
      const rect = roomRect(layout, x, y, Math.max(1, scale * 1.5))

      context.save()
      roundedPath(rect.x, rect.y, rect.width, rect.height, Math.max(3, scale * 7))
      if (!highlight) {
        context.fillStyle = `rgba(0,0,0,${ROOM_MASK_ALPHA})`
        context.fill()
        context.strokeStyle = 'rgba(196,205,210,.34)'
        context.lineWidth = Math.max(1, scale * 1.2)
        context.stroke()
      } else {
        context.fillStyle = `rgba(36,255,137,${highlight.fillAlpha})`
        context.fill()
        context.shadowColor = '#41ff9a'
        context.shadowBlur = Math.max(4, highlight.glow * scale)
        context.strokeStyle = `rgba(75,255,159,${highlight.strokeAlpha})`
        context.lineWidth = Math.max(1.5, highlight.lineWidth * scale)
        context.stroke()

        if (current) {
          roundedPath(rect.x + 4 * scale, rect.y + 4 * scale, rect.width - 8 * scale, rect.height - 8 * scale, Math.max(2, scale * 5))
          context.strokeStyle = 'rgba(214,255,232,.9)'
          context.lineWidth = Math.max(1, 1.7 * scale)
          context.stroke()
        }
      }
      context.restore()

      if (selecting && (current || reachable)) ui.hotspots.push({ id: 'map_node', rect, data: { x, y } })
    }
  }
}

function drawLandmarkBadge(rect, colors) {
  context.save()
  context.shadowColor = colors.glow
  context.shadowBlur = Math.max(7, rect.width * 0.36)
  context.beginPath()
  context.arc(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width * 0.48, 0, Math.PI * 2)
  context.fillStyle = colors.fill
  context.fill()
  context.strokeStyle = colors.stroke
  context.lineWidth = Math.max(1.4, rect.width * 0.07)
  context.stroke()
  context.shadowBlur = 0
  return () => context.restore()
}

function drawVaultChestIcon(rect) {
  const restore = drawLandmarkBadge(rect, { fill: 'rgba(92,31,25,.96)', stroke: '#ffd971', glow: '#ffb13c' })
  const x = rect.x + rect.width * 0.2
  const y = rect.y + rect.height * 0.29
  const width = rect.width * 0.6
  const height = rect.height * 0.48
  context.beginPath()
  context.moveTo(x, y + height * 0.32)
  context.quadraticCurveTo(x, y, x + width * 0.22, y)
  context.lineTo(x + width * 0.78, y)
  context.quadraticCurveTo(x + width, y, x + width, y + height * 0.32)
  context.lineTo(x, y + height * 0.32)
  context.fillStyle = '#d7862f'
  context.fill()
  context.strokeStyle = '#fff0a3'
  context.lineWidth = Math.max(1, rect.width * 0.055)
  context.stroke()
  context.fillStyle = '#a94526'
  context.fillRect(x, y + height * 0.32, width, height * 0.68)
  context.strokeRect(x, y + height * 0.32, width, height * 0.68)
  context.fillStyle = '#ffe37f'
  context.fillRect(rect.x + rect.width * 0.46, rect.y + rect.height * 0.48, rect.width * 0.08, rect.height * 0.2)
  restore()
}

function drawExitIcon(rect) {
  const restore = drawLandmarkBadge(rect, { fill: 'rgba(20,74,57,.96)', stroke: '#b9ffd8', glow: '#4dffae' })
  const left = rect.x + rect.width * 0.23
  const top = rect.y + rect.height * 0.22
  const doorWidth = rect.width * 0.32
  const doorHeight = rect.height * 0.58
  context.strokeStyle = '#e9fff2'
  context.lineWidth = Math.max(1.2, rect.width * 0.065)
  context.strokeRect(left, top, doorWidth, doorHeight)
  context.beginPath()
  context.moveTo(rect.x + rect.width * 0.43, rect.y + rect.height * 0.51)
  context.lineTo(rect.x + rect.width * 0.77, rect.y + rect.height * 0.51)
  context.moveTo(rect.x + rect.width * 0.64, rect.y + rect.height * 0.37)
  context.lineTo(rect.x + rect.width * 0.78, rect.y + rect.height * 0.51)
  context.lineTo(rect.x + rect.width * 0.64, rect.y + rect.height * 0.65)
  context.stroke()
  restore()
}

function drawMovementLandmarks(layout) {
  drawVaultChestIcon(landmarkIconRect(layout, LANDMARK_ROOMS.VAULT.x, LANDMARK_ROOMS.VAULT.y))
  drawExitIcon(landmarkIconRect(layout, LANDMARK_ROOMS.EXIT.x, LANDMARK_ROOMS.EXIT.y))
}

function drawMapPin(rect, scale, alpha) {
  if (!rect || alpha <= 0) return
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2 - Math.max(4, 7 * scale)
  const radius = Math.max(7, 13 * scale)

  context.save()
  context.globalAlpha = Math.max(0, Math.min(1, alpha))
  context.shadowColor = '#ff493f'
  context.shadowBlur = Math.max(10, 20 * scale)
  context.beginPath()
  context.moveTo(centerX - radius * 0.58, centerY + radius * 0.38)
  context.quadraticCurveTo(centerX - radius * 0.2, centerY + radius * 1.16, centerX, centerY + radius * 1.7)
  context.quadraticCurveTo(centerX + radius * 0.2, centerY + radius * 1.16, centerX + radius * 0.58, centerY + radius * 0.38)
  context.closePath()
  context.fillStyle = '#b51f2f'
  context.fill()
  context.strokeStyle = '#ffd36a'
  context.lineWidth = Math.max(1.5, 2.4 * scale)
  context.stroke()

  context.beginPath()
  context.arc(centerX, centerY, radius, 0, Math.PI * 2)
  context.fillStyle = '#d52b37'
  context.fill()
  context.strokeStyle = '#ffe090'
  context.lineWidth = Math.max(1.5, 2.4 * scale)
  context.stroke()

  context.shadowBlur = 0
  context.beginPath()
  context.arc(centerX, centerY, radius * 0.35, 0, Math.PI * 2)
  context.fillStyle = '#fff1c3'
  context.fill()
  context.restore()
}

function drawMovementPin(state, layout) {
  const local = state.players.find(player => player.id === 'P1')
  if (!local) return
  if (!movementPinPosition) movementPinPosition = { ...local.position }

  const scale = layout.transform.scale
  if (movementPinTransition) {
    const transition = movementPinTransition
    const opacity = pinTransitionOpacity(Date.now() - transition.startedAt, transition.duration)
    drawMapPin(roomRect(layout, transition.from.x, transition.from.y), scale, opacity.from)
    drawMapPin(roomRect(layout, transition.to.x, transition.to.y), scale, opacity.to)
    if (opacity.done) {
      movementPinPosition = { ...transition.to }
      movementPinTransition = null
    }
    return
  }

  drawMapPin(roomRect(layout, movementPinPosition.x, movementPinPosition.y), scale, 1)
}

function selectMovementTarget(target) {
  const local = engine && engine.getPlayer('P1')
  if (!local) return
  const destination = { x: target.x, y: target.y }
  const source = movementPinTransition
    ? { ...movementPinTransition.to }
    : { ...(movementPinPosition || local.position) }

  selectedMove = destination
  if (source.x === destination.x && source.y === destination.y) {
    movementPinPosition = destination
    movementPinTransition = null
    return
  }

  movementPinTransition = {
    from: source,
    to: destination,
    startedAt: Date.now(),
    duration: PIN_TRANSITION_MS
  }
}

function drawMovementHud(state, layout) {
  const local = state.players.find(player => player.id === 'P1')
  const scale = layout.transform.scale
  const headlineSize = Math.max(10, 23 * scale)
  const mediumSize = Math.max(9, 19 * scale)

  drawHudPlate(layout.round, { stroke: '#f3c350', inner: '#a9272c' })
  text('♦ ♠', layout.round.x + 30 * scale, layout.round.y + layout.round.height / 2, Math.max(9, 18 * scale), '#fff1c2', 'center', 'bold')
  text(`回 合  ${String(state.turn).padStart(2, '0')}/${C.MAX_TURNS}`, layout.round.x + layout.round.width / 2, layout.round.y + layout.round.height / 2, headlineSize, '#fff3d2', 'center', 'bold')
  text('♠', layout.round.x + layout.round.width - 28 * scale, layout.round.y + layout.round.height / 2, Math.max(10, 21 * scale), '#fff1c2', 'center', 'bold')

  const vaultOpen = state.turn >= C.VAULT_OPEN_TURN
  drawHudPlate(layout.vault, {
    top: vaultOpen ? 'rgba(73,61,16,.99)' : 'rgba(144,17,27,.99)',
    bottom: vaultOpen ? 'rgba(38,33,10,.99)' : 'rgba(72,8,17,.99)',
    stroke: vaultOpen ? '#ffe36e' : '#ffbd39',
    inner: vaultOpen ? '#a57a24' : '#b22929'
  })
  text(vaultOpen ? '◆  中央金库  已开放' : `▣  中央金库  第${C.VAULT_OPEN_TURN}回合开启`, layout.vault.x + layout.vault.width / 2, layout.vault.y + layout.vault.height / 2, mediumSize, '#fff0ba', 'center', 'bold')

  drawHudPlate(layout.alert, { top: '#3b0d78', bottom: '#1f0747', stroke: '#df56ff', inner: '#7750ff' })
  const alertActive = state.turn >= C.ALERT_START_TURN
  context.beginPath()
  context.arc(layout.alert.x + 30 * scale, layout.alert.y + layout.alert.height / 2, Math.max(11, 23 * scale), 0, Math.PI * 2)
  context.fillStyle = '#190e49'
  context.fill()
  context.strokeStyle = '#aa6cff'
  context.lineWidth = Math.max(1.5, 3 * scale)
  context.stroke()
  text('☣', layout.alert.x + 30 * scale, layout.alert.y + layout.alert.height / 2, Math.max(12, 25 * scale), alertActive ? '#ff5f76' : '#5cd6ff', 'center', 'bold')
  text(alertActive ? '毒圈：生效中' : `毒圈：第${C.ALERT_START_TURN}轮`, layout.alert.x + layout.alert.width * 0.63, layout.alert.y + layout.alert.height / 2, mediumSize, '#eee7ff', 'center', 'bold')

  drawHudPlate(layout.gold, { stroke: '#ef8c38', inner: '#b84023' })
  context.beginPath()
  context.arc(layout.gold.x + 29 * scale, layout.gold.y + layout.gold.height / 2, Math.max(11, 23 * scale), 0, Math.PI * 2)
  context.fillStyle = '#e84a21'
  context.fill()
  context.strokeStyle = '#ffe077'
  context.lineWidth = Math.max(1.5, 3 * scale)
  context.stroke()
  text('♦', layout.gold.x + 29 * scale, layout.gold.y + layout.gold.height / 2, Math.max(10, 21 * scale), '#fff2b0', 'center', 'bold')
  text(`${PLAYER_ACCOUNT_GOLD}g`, layout.gold.x + layout.gold.width * 0.64, layout.gold.y + layout.gold.height / 2, headlineSize, '#fff2d6', 'center', 'bold')

  const target = selectedMove || local.position
  const deadline = state.phase === 'MOVE_SELECTION' ? state.moveDeadlineAt : state.turnDeadlineAt
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
  if (state.phase === 'MOVE_SELECTION') {
    button('confirm_move', selectedMove ? `确认移动  ${seconds}s` : `原地停留  ${seconds}s`, layout.action, {
      top: selectedMove ? '#c43b32' : '#78552e',
      bottom: selectedMove ? '#6d1423' : '#372519',
      stroke: '#ffe17d',
      size: Math.max(9, 17 * scale),
      radius: Math.max(7, 12 * scale)
    })
  } else {
    drawHudPlate(layout.action, { stroke: '#a99470', inner: '#584332' })
    text('行动结算中', layout.action.x + layout.action.width / 2, layout.action.y + layout.action.height / 2, Math.max(9, 17 * scale), '#eadfc9', 'center', 'bold')
  }
  text(`目标：${roomTypeAt(target.x, target.y)}`, layout.action.x + layout.action.width / 2, layout.action.y + layout.action.height + 17 * scale, Math.max(8, 12 * scale), '#fff0c8', 'center', 'bold')
}

function drawMapScene(state) {
  const image = assets.movementMap || assets.map
  drawContainedBackdrop(image, '#09080b')
  const layout = createMovementLayout(viewWidth, viewHeight, image ? image.width : 1280, image ? image.height : 722)
  drawMovementRooms(state, layout)
  drawMovementPin(state, layout)
  drawMovementLandmarks(layout)
  drawMovementHud(state, layout)
  ui.discardRect = null
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
    if (item.state === 'HIDDEN') {
      drawCasinoCardBack(rect)
    } else {
      const card = cardById(item.cardId)
      drawCardArt(card, rect, { radius: 10, inset: 3, stroke: '#fff0ac', lineWidth: 2 })
      context.fillStyle = 'rgba(18,9,14,.76)'
      context.fillRect(rect.x + 4, rect.y + rect.height - 22, rect.width - 8, 17)
      text(item.state === 'DROPPED' ? '战败掉落 · 点击拾取' : '再次点击拾取', rect.x + rect.width / 2, rect.y + rect.height - 13, 8, '#ffe5b7', 'center', 'bold')
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
  ui.loadoutWarehouseRects = []
  ui.loadoutBackpackRects = []
  ui.loadoutWarehouseDropRect = null
  ui.loadoutBackpackDropRect = null
  ui.discardRect = null
  if (scene === 'LOADING') drawLoading()
  if (scene === 'HOME') drawHome()
  if (scene === 'WAREHOUSE') drawWarehouse()
  if (scene === 'LOADOUT') drawLoadout()
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
  movementPinPosition = { ...engine.getPlayer('P1').position }
  movementPinTransition = null
  activeBattle = null
  presentation = result.gameOver || engine.phase === 'GAME_OVER' ? 'SETTLEMENT' : 'MAP'
}

function handleAction(action) {
  if (!action) return
  if (action.id === 'home_start') enterLoadout()
  if (action.id === 'home_shop') addToast('商店暂未开放。')
  if (action.id === 'home_warehouse') enterWarehouse()
  if (action.id === 'warehouse_home') setScene('HOME')
  if (action.id === 'warehouse_filter_all') {
    warehouseFilter = 'ALL'
    warehousePage = 0
    warehouseSelection = null
  }
  if (action.id === 'warehouse_filter_weapon') {
    warehouseFilter = 'WEAPON'
    warehousePage = 0
    warehouseSelection = null
  }
  if (action.id === 'warehouse_filter_armor') {
    warehouseFilter = 'ARMOR'
    warehousePage = 0
    warehouseSelection = null
  }
  if (action.id === 'warehouse_filter_skill') {
    warehouseFilter = 'SKILL'
    warehousePage = 0
    warehouseSelection = null
  }
  if (action.id === 'warehouse_filter_loot') {
    warehouseFilter = 'LOOT'
    warehousePage = 0
    warehouseSelection = null
  }
  if (action.id === 'warehouse_page_prev') warehousePage = Math.max(0, warehousePage - 1)
  if (action.id === 'warehouse_page_next') warehousePage = Math.min(Math.max(0, Math.ceil(warehouseCards().length / CARD_PAGE_SIZE) - 1), warehousePage + 1)
  if (action.id === 'warehouse_card') warehouseSelection = action.data
  if (action.id === 'loadout_home') setScene('HOME')
  if (action.id === 'loadout_match') beginMatchmaking()
  if (action.id === 'loadout_page_prev') loadoutPage = Math.max(0, loadoutPage - 1)
  if (action.id === 'loadout_page_next') loadoutPage = Math.min(Math.max(0, Math.ceil(loadout.snapshot().warehouseCardIds.length / CARD_PAGE_SIZE) - 1), loadoutPage + 1)
  if (action.id === 'loadout_warehouse_card') {
    if (loadoutSelection && loadoutSelection.cardId === action.data && loadoutSelection.source === 'WAREHOUSE') addLoadoutCard(action.data)
    else loadoutSelection = { cardId: action.data, source: 'WAREHOUSE' }
  }
  if (action.id === 'loadout_backpack_card') {
    if (loadoutSelection && loadoutSelection.cardId === action.data && loadoutSelection.source === 'BACKPACK') removeLoadoutCard(action.data)
    else loadoutSelection = { cardId: action.data, source: 'BACKPACK' }
  }
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
  if (action.id === 'map_node') selectMovementTarget(action.data)
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
  if (action.id === 'settlement_replay') enterLoadout()
}

wx.onTouchStart(event => {
  const point = touchPoint(event, false)
  if (scene === 'LOADOUT') {
    const warehouseCard = ui.loadoutWarehouseRects.find(rect => pointInRect(point, rect))
    const backpackCard = ui.loadoutBackpackRects.find(rect => pointInRect(point, rect))
    if (warehouseCard) loadoutDragging = { cardId: warehouseCard.cardId, source: 'WAREHOUSE' }
    else if (backpackCard) loadoutDragging = { cardId: backpackCard.cardId, source: 'BACKPACK' }
    return
  }
  const inventory = ui.inventoryRects.find(rect => pointInRect(point, rect))
  draggingItemId = inventory ? inventory.instanceId : null
})

wx.onTouchEnd(event => {
  const point = touchPoint(event)
  if (scene === 'LOADOUT' && loadoutDragging) {
    let handled = false
    if (loadoutDragging.source === 'WAREHOUSE' && pointInRect(point, ui.loadoutBackpackDropRect)) {
      addLoadoutCard(loadoutDragging.cardId)
      handled = true
    }
    if (loadoutDragging.source === 'BACKPACK' && pointInRect(point, ui.loadoutWarehouseDropRect)) {
      removeLoadoutCard(loadoutDragging.cardId)
      handled = true
    }
    loadoutDragging = null
    if (handled) return
  }
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
loadCardCatalog()
loop()
