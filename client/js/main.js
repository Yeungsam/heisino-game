const bundledCards = require('../data/cards')
const C = require('./core/constants')
const { GameEngine, positionKey } = require('./core/game-engine')
const { LoadoutSession } = require('./core/loadout')
const { stackItems, quantitySlots } = require('./core/inventory')
const accountApi = require('./api/account')
const { formatDiagnostics } = require('./api/connection-diagnostics')
const { fetchCardCatalog } = require('./api/cards')
const { cardAssetBaseUrl, gameApiBaseUrl } = require('./config')
const { createCardCatalogIndex, resolveCardAssetUrl } = require('./ui/card-art')
const { createNicknameInput } = require('./ui/nickname-input')
const { createTapFeedback, createRenderScheduler, createMemo, createLayerCanvas } = require('./ui/render-performance')
const { createHomeLayout, centeredTextBaseline } = require('./ui/home-screen')
const {
  SEARCH_ASSET_CROPS,
  SEARCH_PANEL_NINE_SLICE,
  searchTimerState,
  syncSearchDeadline,
  createSearchLayout,
  createRoomLayout,
  fitAspectRect,
  createHudSafeLayout,
  createSearchPanelContentLayout,
  createNineSliceGeometry,
  nextSearchRippleIndex,
  searchRippleState
} = require('./ui/search-room')
const {
  CARD_ASPECT_RATIO,
  clamp,
  createContainedCardGrid,
  createVerticalCardGrid,
  rectsIntersect,
  intersectionRect,
  classifyCardGesture
} = require('./ui/card-scroll')
const {
  ROOM_MASK_ALPHA,
  PIN_TRANSITION_MS,
  LANDMARK_ROOMS,
  createMovementLayout,
  landmarkIconRect,
  roomRect,
  roomHighlightStyle,
  roomTypeAt,
  roomInfoAt,
  ROOM_TYPE_INFO,
  roomTypeForNode,
  pinTransitionOpacity
} = require('./ui/movement-map')

const canvas = wx.createCanvas()
let context = canvas.getContext('2d')
const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
let menuButtonRect = null
try {
  menuButtonRect = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null
} catch (menuButtonError) {
  menuButtonRect = null
}
const pixelRatio = Math.min(2, windowInfo.pixelRatio || 1)
const viewWidth = windowInfo.windowWidth
const viewHeight = windowInfo.windowHeight
canvas.width = viewWidth * pixelRatio
canvas.height = viewHeight * pixelRatio
context.scale(pixelRatio, pixelRatio)
const frameScheduler = createRenderScheduler(30)
const tapFeedback = createTapFeedback()
const memoText = createMemo(160)
let frameCache = null
let frameCacheContext = null
try {
  frameCache = createLayerCanvas(wx, canvas)
  frameCacheContext = frameCache && frameCache.getContext('2d')
} catch (_) { frameCache = null; frameCacheContext = null }
let cachedFrameReady = false
let roomArtworkCache = null
let roomArtworkCacheDisabled = false
function invalidateFrame() { frameScheduler.invalidate() }

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
  homeBackground: 'assets/ui/home/background.jpg',
  homeLogo: 'assets/ui/home/logo.png',
  homeCharacter: 'assets/ui/home/character.png',
  homeCat: 'assets/ui/home/cat.png',
  homeShopButton: 'assets/ui/home/shop-button.png',
  homeWarehouseButton: 'assets/ui/home/warehouse-button.png',
  homeStartButton: 'assets/ui/home/start-button.png',
  home: 'assets/home.jpg',
  movementMap: 'assets/movement-map.jpg',
  movementLocation: 'assets/movement-location.jpg',
  map: 'assets/map.jpg',
  characters: 'assets/characters.jpg',
  loading: 'assets/loading.jpg'
}
const searchAssetSources = {
  searchRoomBackground: 'subpackages/search/assets/room-background.png',
  searchRoomTitlePanel: 'subpackages/search/assets/room-title-panel.png',
  searchRoomTitleSpade: 'subpackages/search/assets/room-title-spade.png',
  searchRoomChairLeft: 'subpackages/search/assets/room-chair-left.png',
  searchRoomMainTable: 'subpackages/search/assets/room-main-table.png',
  searchRoomForeground: 'subpackages/search/assets/room-foreground.png',
  searchRoomLeaveButton: 'subpackages/search/assets/room-leave-button.png',
  searchRoomLeaveIcon: 'subpackages/search/assets/room-leave-icon.png',
  searchRoomChairFront: 'subpackages/search/assets/room-chair-front.png',
  searchRoomTimerTrack: 'subpackages/search/assets/room-timer-track.png',
  searchRoomTimerFill: 'subpackages/search/assets/room-timer-fill.png',
  searchPanel: 'subpackages/search/assets/search-panel.png',
  searchSlot: 'subpackages/search/assets/search-slot.png',
  searchSlotPattern: 'subpackages/search/assets/search-slot-pattern.png',
  searchBagIcon: 'subpackages/search/assets/search-bag-icon.png',
  searchBriefcaseIcon: 'subpackages/search/assets/search-briefcase-icon.png',
  searchFinishButton: 'subpackages/search/assets/search-finish-button.png',
  searchProgressTrack: 'subpackages/search/assets/search-progress-track.png',
  searchProgressFill: 'subpackages/search/assets/search-progress-fill.png'
}
const assets = {}
const cardImages = {}
let PLAYER_ACCOUNT_GOLD = 0
let accountProfile = null
let accountGame = null
let accountSettlement = null
let accountBusy = false
let heartbeatInFlight = false
let accountBusySince = 0
let accountBusyLabel = ''
let accountConnectionError = null
let connectionDiagnosticsOpen = false
let accountRevision = 0
let accountLastHeartbeat = 0
let accountBackground = false
let profileNickname = ''
let profileAvatarUrl = ''
let profileAvatarImage = null
let profileMessage = ''
let profileConfirmationOpen = false
let userInfoButton = null
let pendingResume = false
const nicknameInput = createNicknameInput(wx, {
  onValue(value) { profileNickname = value; profileMessage = ''; invalidateFrame(); confirmProfileDraft() },
  onError(message) { profileMessage = message; invalidateFrame() },
  onVisibility(active) {
    invalidateFrame()
    if (userInfoButton && typeof userInfoButton[active ? 'hide' : 'show'] === 'function') userInfoButton[active ? 'hide' : 'show']()
  }
})
let assetsLoaded = 0
let baseAssetsReady = false
let searchAssetsReady = false
let searchAssetsPromise = null
let cardCatalogReady = false
let cardCatalogSource = 'LOADING'
let pendingCardCatalog = null
let scene = 'LOADING'
let sceneEnteredAt = Date.now()
let lobbyRoom = null
let lobbyRooms = []
let lobbyPage = 0
let lobbyShowPlaying = false
let lobbyLastRefresh = -Infinity
let lobbyPollInFlight = false
let lobbyDeadlineAt = 0
let lobbyError = ''
let cards = bundledCards
let cardsById = createCardCatalogIndex(cards)
let loadout = new LoadoutSession({ cards })
let engine = null
let presentation = 'MAP'
let selectedMove = null
let movementPinPosition = null
let movementPinTransition = null
let activeBattle = null
let toast = ''
let toastUntil = 0
let draggingItemId = null
let loadoutSelection = null
let loadoutDragging = null
let loadoutDragPoint = null
let loadoutGesture = null
let loadoutScrollY = 0
let warehouseFilter = 'ALL'
let warehouseScrollY = 0
let warehousePreviewCardId = null
let warehouseGesture = null
let searchAuthority = 'ACCOUNT'
let searchVisitState = null
let roomTimerAnchor = null
let searchRequestPending = false
let searchDragging = null
let searchDragPoint = null
let searchRoomScrollY = 0
let searchRippleSlotIndex = null
let searchRippleStartedAt = 0
let searchGesture = null
let cancelledSearchTouch = false

const ui = {
  hotspots: [],
  inventoryRects: [],
  discardRect: null,
  searchItemRects: [],
  searchInventoryRects: [],
  searchBackpackRect: null,
  searchRoomRect: null,
  searchRoomScrollRect: null,
  searchRoomMaxScroll: 0,
  roomAreaRects: [],
  loadoutWarehouseRects: [],
  loadoutBackpackRects: [],
  loadoutWarehouseDropRect: null,
  loadoutBackpackDropRect: null,
  loadoutWarehouseScrollRect: null,
  loadoutWarehouseMaxScroll: 0,
  warehouseScrollRect: null,
  warehouseMaxScroll: 0
}

function setScene(nextScene) {
  invalidateFrame()
  nicknameInput.close()
  profileConfirmationOpen = false
  if (userInfoButton) { userInfoButton.destroy(); userInfoButton = null }
  scene = nextScene
  sceneEnteredAt = Date.now()
  ui.hotspots = []
  if (nextScene === 'PROFILE' && !profileNickname) {
    const enteredAt = sceneEnteredAt
    setTimeout(() => {
      if (scene === 'PROFILE' && sceneEnteredAt === enteredAt && !profileNickname) inputNickname()
    }, 0)
  }
}

function loadAssets() {
  Object.keys(assetSources).forEach(key => {
    const image = wx.createImage()
    image.onload = () => {
      assets[key] = image
      invalidateFrame()
      assetsLoaded += 1
      if (assetsLoaded === Object.keys(assetSources).length) {
        baseAssetsReady = true
        finishBoot()
      }
    }
    image.onerror = () => {
      invalidateFrame()
      assetsLoaded += 1
      if (assetsLoaded === Object.keys(assetSources).length) {
        baseAssetsReady = true
        finishBoot()
      }
    }
    image.src = assetSources[key]
  })
}

function loadSearchAssets() {
  if (searchAssetsReady) return Promise.resolve()
  if (searchAssetsPromise) return searchAssetsPromise
  searchAssetsPromise = new Promise(resolve => {
    const loadImages = () => {
      const entries = Object.entries(searchAssetSources)
      let completed = 0
      const finish = () => {
        invalidateFrame()
        completed += 1
        if (completed !== entries.length) return
        searchAssetsReady = true
        roomArtworkCache = null
        resolve()
      }
      entries.forEach(([key, source]) => {
        const image = wx.createImage()
        image.onload = () => {
          assets[key] = image
          finish()
        }
        image.onerror = finish
        image.src = source
      })
    }
    if (wx.loadSubpackage) wx.loadSubpackage({ name: 'search', success: loadImages, fail: loadImages })
    else loadImages()
  })
  return searchAssetsPromise
}

function finishBoot() {
  if (scene !== 'LOADING' || !baseAssetsReady || !cardCatalogReady) return
  connectAccount()
}

function accountError(error) {
  const messages = {
    ACCOUNT_UNAVAILABLE: '游戏账号服务暂不可用，请稍后重试。',
    ACCOUNT_CHANGED: '微信账号已切换，请重新登录。',
    DOMAIN_NOT_ALLOWED: '微信拦截了账号服务域名，请查看连接诊断。后台已配置时，也需核对当前账号与手机端配置。',
    WECHAT_NOT_CONFIGURED: '微信登录尚未配置，请联系开发者完成服务端配置。',
    MODERATION_UNAVAILABLE: '昵称审核服务暂不可用，请稍后重试。',
    NICKNAME_INVALID: '昵称须为 2–16 个汉字、字母、数字或下划线。',
    NICKNAME_RESERVED: '该昵称包含保留称谓，请换一个。',
    NICKNAME_REJECTED: '昵称未通过内容检查，请换一个。',
    NOT_OWNED: '仓库数量不足，请重新选择战备。',
    STALE_TURN: '回合已推进，已刷新最新状态。',
    BACKPACK_FULL: '背包已满，物品仍留在房间。',
    AREA_FULL: '该搜索区域已满。',
    ACTIVE_GAME_EXISTS: '有未完成的对局，请先恢复。',
    ALREADY_IN_ROOM: '请先退出当前房间。',
    ROOM_NOT_FOUND: '房间已关闭或不存在。',
    ROOM_IN_GAME: '该房间已开局，无法加入。',
    ROOM_FULL: '房间人数已满，无法加入。',
    ROOM_CHANGED: '房间成员有变动，请刷新后重试。',
    HOST_REQUIRED: '只有房主可以开始游戏。',
    NOT_ENOUGH_PLAYERS: '至少需要 2 名玩家才能开局。',
    MOVE_ALREADY_SUBMITTED: '已提交移动，正在等待其他玩家。',
    INVALID_PHASE: '当前行动阶段已结束，正在同步对局。'
  }
  return messages[error.code] || '连接失败，请检查网络后重试。'
}

async function connectAccount() {
  if (accountBusy) return
  beginAccountRequest('连接微信账号…')
  accountConnectionError = null
  profileMessage = '正在连接微信账号…'
  try {
    const response = await accountApi.login()
    applyAccountResponse(response)
    if (response.profile.profileComplete) loadSearchAssets()
    if (!accountProfile.profileComplete) setScene('PROFILE')
    else if (response.activeGame) resumeAccountGame()
    else if (lobbyRoom) enterLobby()
    else if (response.lastSettlement && !response.lastSettlement.acknowledged) { pendingResume = true; applyAccountResponse(response); setScene('GAME'); presentation = 'SETTLEMENT' }
    else setScene('HOME')
    profileMessage = ''
  } catch (error) {
    accountConnectionError = error
    profileMessage = accountError(error)
    setScene('LOGIN')
    if (error.code === 'DOMAIN_NOT_ALLOWED') showConnectionDiagnostics()
  } finally { endAccountRequest() }
}

function beginAccountRequest(label) {
  accountBusy = true
  accountBusySince = Date.now()
  accountBusyLabel = label
  invalidateFrame()
}

function endAccountRequest() {
  accountBusy = false
  invalidateFrame()
}

function showConnectionDiagnostics() {
  if (connectionDiagnosticsOpen || !accountConnectionError || !wx.showModal) return
  connectionDiagnosticsOpen = true
  try {
    wx.showModal({ title: '账号连接诊断', content: formatDiagnostics(accountConnectionError, wx, gameApiBaseUrl),
      showCancel: false, confirmText: '知道了', complete() { connectionDiagnosticsOpen = false } })
  } catch (_) { connectionDiagnosticsOpen = false }
}

function applyAccountResponse(response) {
  if (!response || response.revision < accountRevision) return
  invalidateFrame()
  accountLastHeartbeat = Date.now()
  accountRevision = response.revision
  const previousGame = accountGame
  const previousVisit = searchVisitState?.visit
  if ('lobbyRoom' in response) {
    lobbyRoom = response.lobbyRoom
    lobbyDeadlineAt = lobbyRoom ? Date.now() + lobbyRoom.expiresAt - response.serverNow : 0
  }
  if (Array.isArray(response.rooms)) lobbyRooms = response.rooms
  const changedAssets = !accountProfile || JSON.stringify(accountProfile.quantities) !== JSON.stringify(response.profile.quantities)
  accountProfile = response.profile
  if (!profileAvatarImage && accountProfile.avatarUrl) {
    const image = wx.createImage()
    image.onload = () => { profileAvatarImage = image; invalidateFrame() }
    image.src = accountProfile.avatarUrl
  }
  PLAYER_ACCOUNT_GOLD = accountProfile.gold
  if (changedAssets) loadout = new LoadoutSession({ cards, quantities: accountProfile.quantities })
  accountGame = response.activeGame
  accountSettlement = response.lastSettlement
  if (accountGame) {
    if (!engine || !previousGame || previousGame.gameId !== accountGame.gameId || engine.cards !== cards) engine = new GameEngine({ cards })
    Object.assign(engine, accountGame.state)
    const receivedAt = Date.now()
    const clockOffset = receivedAt - response.serverNow
    engine.moveDeadlineAt += clockOffset
    engine.turnDeadlineAt += clockOffset
    searchAuthority = 'ACCOUNT'
    const search = accountGame.search
    roomTimerAnchor = search ? syncSearchDeadline(roomTimerAnchor, search.visit, response.serverNow, receivedAt) : null
    searchVisitState = search ? { ...search, visit: {
      ...search.visit,
      deadlineAt: roomTimerAnchor.localDeadlineAt,
      observation: search.visit.observation && {
        ...search.visit.observation,
        startedAt: search.visit.observation.startedAt + clockOffset
      }
    } } : null
    if (previousGame && previousGame.state.turn !== accountGame.state.turn) {
      selectedMove = null
      activeBattle = null
      movementPinPosition = { ...engine.getPlayer('P1').position }
      movementPinTransition = null
      presentation = 'MAP'
      searchRippleSlotIndex = null
      searchRoomScrollY = 0
      if (engine.phase !== 'MOVE_SELECTION' && !accountGame.waiting) decidePostMove()
    } else if (accountGame.waiting) {
      activeBattle = null
      presentation = 'MAP'
    } else if (previousGame && previousGame.state.phase === 'MOVE_SELECTION' && engine.phase !== 'MOVE_SELECTION') decidePostMove()
  } else if (accountSettlement && (scene === 'GAME' || pendingResume)) {
    engine = new GameEngine({ cards })
    Object.assign(engine, accountSettlement.state)
    engine.phase = 'GAME_OVER'
    searchVisitState = null
    roomTimerAnchor = null
    presentation = 'SETTLEMENT'
  }
  const visit = searchVisitState?.visit
  if (searchGesture && (visit?.visitId !== previousVisit?.visitId || !visit?.observation?.active ||
      visit.observation.areaId !== previousVisit?.observation?.areaId)) cancelInputGesture()
}

function resumeAccountGame() {
  pendingResume = true
  loadSearchAssets()
  setScene('GAME')
  if (!accountGame) { presentation = 'SETTLEMENT'; return }
  movementPinPosition = { ...engine.getPlayer('P1').position }
  movementPinTransition = null
  selectedMove = null
  activeBattle = null
  if (engine.phase === 'MOVE_SELECTION' || accountGame.waiting) presentation = 'MAP'
  else if (searchVisitState?.visit.observation?.active) presentation = 'SEARCH'
  else if (searchVisitState?.visit.observation) beginRoomVisit()
  else decidePostMove()
}

async function accountAction(action, extra = {}) {
  if (!accountGame) return false
  if (accountBusy) { addToast('上一操作处理中，请稍候。', 900); return false }
  beginAccountRequest('正在同步操作…')
  try {
    applyAccountResponse(await accountApi.command('game', { gameId: accountGame.gameId, turn: accountGame.state.turn, action, ...extra }))
    return true
  } catch (error) {
    addToast(accountError(error), 2200)
    try { applyAccountResponse(await accountApi.command('resume')) } catch (_) {}
    return false
  } finally { endAccountRequest() }
}

async function heartbeatAccount() {
  if (accountBusy || heartbeatInFlight || accountBackground || !accountGame) return
  heartbeatInFlight = true
  try { applyAccountResponse(await accountApi.command('heartbeat')) } catch (_) { addToast('连接中断，10 分钟内重进可恢复。', 1500) }
  finally { heartbeatInFlight = false }
}

function inputNickname() {
  if (accountBusy || profileConfirmationOpen) return
  nicknameInput.open(profileNickname)
}

function confirmProfileDraft() {
  if (scene !== 'PROFILE' || profileConfirmationOpen || typeof wx.showModal !== 'function') return
  const nickname = profileNickname
  profileConfirmationOpen = true
  const finish = () => { profileConfirmationOpen = false }
  try {
    wx.showModal({ title: '确认游戏身份',
      content: `游戏昵称：${nickname}\n${profileAvatarUrl ? '使用已选择的微信头像。' : '使用默认头像，不获取微信头像。'}\n当前版本创建后暂不能修改昵称。`,
      confirmText: '确认创建', cancelText: '返回修改',
      success(result) {
        finish()
        if (result.confirm && scene === 'PROFILE' && profileNickname === nickname) saveProfile()
      },
      fail() { finish(); profileMessage = '昵称已填入，请点击下方确认按钮完成内容审核。' }
    })
  } catch (_) { finish(); profileMessage = '昵称已填入，请点击下方确认按钮完成内容审核。' }
}

async function saveProfile() {
  if (accountBusy || nicknameInput.active || profileConfirmationOpen) return
  beginAccountRequest('正在检查昵称…')
  profileMessage = '正在检查昵称…'
  try {
    applyAccountResponse(await accountApi.command('profile', { nickname: profileNickname, avatarUrl: profileAvatarUrl }))
    profileMessage = ''
    setScene('HOME')
    loadSearchAssets()
  } catch (error) { profileMessage = accountError(error) }
  finally { endAccountRequest() }
}

function drawAccountSetup() {
  drawCover(assets.homeBackground)
  darken(0.76)
  const width = Math.min(530, viewWidth - 32)
  const x = (viewWidth - width) / 2
  const y = Math.max(12, (viewHeight - 325) / 2)
  panel(x, y, width, Math.min(325, viewHeight - 24), { fill: 'rgba(30,18,37,.97)', stroke: PALETTE.gold })
  text(scene === 'LOGIN' ? '连接游戏账号' : '创建你的赌场身份', viewWidth / 2, y + 30, 20, PALETTE.paleGold, 'center', 'bold')
  if (scene === 'LOGIN') {
    drawWrappedText(profileMessage, x + 24, y + 90, width - 48, 22, 12, '#f5d4c8', 4)
    button('account_retry', accountBusy ? '连接中…' : '重试微信登录', { x: x + width / 2 - 90, y: y + 220, width: 180, height: 38 })
    if (accountConnectionError) button('account_diagnostics', '查看连接诊断', { x: x + width / 2 - 90, y: y + 267, width: 180, height: 30 }, { size: 11 })
    return
  }
  const avatar = { x: x + 30, y: y + 66, width: 60, height: 60 }
  panel(avatar.x, avatar.y, avatar.width, avatar.height, { radius: 30, fill: '#4b304b' })
  if (profileAvatarImage) context.drawImage(profileAvatarImage, avatar.x + 2, avatar.y + 2, 56, 56)
  else text('♠', avatar.x + 30, avatar.y + 30, 33, PALETTE.gold, 'center')
  text('头像和昵称授权可跳过', x + 108, y + 78, 12, '#f5e2bc')
  text('不获取手机号、位置等信息', x + 108, y + 102, 10, '#c7b5c7')
  const rect = { x: x + 24, y: y + 140, width: width - 48, height: 39 }
  button('profile_name', profileNickname || '输入或修改游戏昵称', rect, { size: 13 })
  text('2–16 个汉字、字母、数字或下划线', x + 24, y + 194, 10, '#d7c5d3')
  drawWrappedText(profileMessage || '未授权时使用默认头像，昵称需通过检查。', x + 24, y + 215, width - 48, 17, 10, '#ffcf9f', 2)
  button('profile_save', accountBusy ? '检查中…' : '确认昵称并进入游戏', { x: x + 24, y: y + 264, width: width - 48, height: 35 }, { size: 12 })
  if (!userInfoButton && !nicknameInput.active && wx.createUserInfoButton) {
    try {
      userInfoButton = wx.createUserInfoButton({ type: 'text', text: '使用微信头像昵称（可选）',
        style: { left: x + width - 230, top: y + 114, width: 206, height: 24, lineHeight: 24, backgroundColor: '#663844', color: '#fff0d6', fontSize: 10, textAlign: 'center', borderRadius: 6 } })
      userInfoButton.onTap(result => {
        invalidateFrame()
        if (!result.userInfo) { profileMessage = '已跳过授权，请输入游戏昵称。'; return }
        profileNickname = result.userInfo.nickName && result.userInfo.nickName !== '微信用户' ? result.userInfo.nickName : ''
        profileAvatarUrl = result.userInfo.avatarUrl || ''
        if (profileAvatarUrl) {
          const image = wx.createImage()
          image.onload = () => { profileAvatarImage = image; invalidateFrame() }
          image.src = profileAvatarUrl
        }
        profileMessage = profileNickname ? '请确认昵称，或点击修改后进入游戏。' : '微信未返回可用昵称，请输入游戏昵称。'
      })
    } catch (_) { profileMessage = '当前环境不支持资料授权，请输入游戏昵称。' }
  }
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
    invalidateFrame()
  }
  image.onerror = error => {
    record.status = 'FAILED'
    record.ready = false
    record.failed = true
    record.error = error
    record.retryAt = Date.now() + 2000 * record.attempts
    invalidateFrame()
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
  invalidateFrame()
  cards = nextCards
  cardsById = createCardCatalogIndex(cards)
  loadout = new LoadoutSession({ cards, quantities: accountProfile ? accountProfile.quantities : {} })
  cardCatalogSource = source
  cardCatalogReady = true
  finishBoot()
}

function loadCardCatalog() {
  // The bundled, validated catalog is usable immediately. A slow catalog GET
  // must not serialize before wx.login; never change cards mid-match/loadout.
  applyCardCatalog(bundledCards, 'LOCAL_CACHE')
  fetchCardCatalog()
    .then(catalog => {
      // During a rollout an older cached response may omit newly issued assets.
      const fetchedIndex = createCardCatalogIndex(catalog.cards)
      if (!bundledCards.every(card => fetchedIndex[card.cardId])) return
      if (JSON.stringify(catalog.cards) === JSON.stringify(cards)) { cardCatalogSource = 'SERVER'; invalidateFrame(); return }
      if (accountGame || ['LOADOUT', 'LOBBY', 'GAME'].includes(scene)) pendingCardCatalog = catalog.cards
      else applyCardCatalog(catalog.cards, 'SERVER')
    })
    .catch(() => {})
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

function text(value, x, y, size = 14, color = PALETTE.cream, align = 'left', weight = 'normal', maxWidth) {
  context.fillStyle = color
  context.font = `${weight} ${size}px sans-serif`
  context.textAlign = align
  context.textBaseline = 'middle'
  if (maxWidth === undefined) context.fillText(String(value), x, y)
  else if (maxWidth > 0) context.fillText(String(value), x, y, maxWidth)
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

function drawImageSourceInRect(image, source, rect) {
  if (!image || !source) return
  context.drawImage(image, source.x, source.y, source.width, source.height, rect.x, rect.y, rect.width, rect.height)
}

function drawNineSliceImage(image, rect, slices, destinationScale = 1) {
  if (!image) return
  createNineSliceGeometry(image.width, image.height, rect, slices, destinationScale).forEach(segment => {
    const source = segment.source
    const destination = segment.destination
    if (source.width <= 0 || source.height <= 0 || destination.width <= 0 || destination.height <= 0) return
    context.drawImage(image, source.x, source.y, source.width, source.height, destination.x, destination.y, destination.width, destination.height)
  })
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
  invalidateFrame()
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
  drawCover(assets.homeBackground)
  const layout = createHomeLayout(viewWidth, viewHeight)
  const drawLayer = (image, rect) => {
    if (image) context.drawImage(image, rect.x, rect.y, rect.width, rect.height)
  }
  drawLayer(assets.homeCharacter, layout.character)
  drawLayer(assets.homeCat, layout.cat)
  drawLayer(assets.homeLogo, layout.logo)
  drawLayer(assets.homeShopButton, layout.buttons.shop)
  drawLayer(assets.homeWarehouseButton, layout.buttons.warehouse)
  drawLayer(assets.homeStartButton, layout.buttons.start)
  Object.entries(layout.labels).forEach(([key, label]) => {
    context.save()
    context.fillStyle = '#fff1c1'
    context.font = `900 ${label.size}px "Noto Serif SC", "Songti SC", serif`
    context.textAlign = 'center'
    const metrics = context.measureText(label.text)
    const hasGlyphBounds = Number.isFinite(metrics.actualBoundingBoxAscent) && Number.isFinite(metrics.actualBoundingBoxDescent)
    context.textBaseline = hasGlyphBounds ? 'alphabetic' : 'middle'
    context.shadowColor = 'rgba(54, 12, 10, .9)'
    context.shadowBlur = Math.max(1, 3 * layout.scale)
    const textY = hasGlyphBounds
      ? centeredTextBaseline(layout.buttons[key], metrics)
      : layout.buttons[key].y + layout.buttons[key].height / 2
    context.fillText(label.text, label.x, textY)
    context.restore()
  })
  ui.hotspots.push({ id: 'home_shop', rect: layout.buttons.shop })
  ui.hotspots.push({ id: 'home_warehouse', rect: layout.buttons.warehouse })
  ui.hotspots.push({ id: 'home_start', rect: layout.buttons.start })
  if (accountProfile) {
    panel(12, 10, 200, 42, { fill: 'rgba(25,14,31,.88)', stroke: '#b98d4d' })
    if (profileAvatarImage) context.drawImage(profileAvatarImage, 18, 15, 32, 32)
    else text('♠', 34, 31, 24, PALETTE.gold, 'center')
    text(accountProfile.nickname, 59, 24, 11, '#fff0ca', 'left', 'bold')
    text(`金币 ${accountProfile.gold}`, 59, 41, 9, '#dec492')
  }
}

function enterLoadout() {
  if (pendingCardCatalog && !accountGame) { applyCardCatalog(pendingCardCatalog, 'SERVER'); pendingCardCatalog = null }
  if (!accountProfile || !accountProfile.profileComplete) return
  if (accountGame) { resumeAccountGame(); return }
  loadoutSelection = null
  loadoutDragging = null
  loadoutDragPoint = null
  loadoutGesture = null
  loadoutScrollY = 0
  setScene('LOADOUT')
}

function enterWarehouse() {
  warehouseFilter = 'ALL'
  warehouseScrollY = 0
  warehousePreviewCardId = null
  warehouseGesture = null
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
  if (card.category === 'WEAPON') return `武器卡 · 攻击倍率 ${Math.round((card.attackMultiplier || 0) * 100)}%`
  if (card.category === 'ARMOR') return '防具卡'
  if (card.category === 'SKILL') return `技能卡 · ${card.description}`
  return `物资卡 · ${card.value !== null ? formatGold(card.value) : '价值待定'}`
}

function drawWrappedText(value, x, y, maxWidth, lineHeight, size = 10, color = PALETTE.cream, maxLines = 2) {
  context.save()
  context.font = `normal ${size}px sans-serif`
  context.fillStyle = color
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  const lines = memoText(JSON.stringify([String(value || ''), maxWidth, size]), () => {
    const result = []
    let line = ''
    for (const character of Array.from(String(value || ''))) {
      const candidate = line + character
      if (line && context.measureText(candidate).width > maxWidth) { result.push(line); line = character }
      else line = candidate
    }
    if (line) result.push(line)
    return result
  })
  lines.slice(0, maxLines).forEach((content, index) => {
    const clipped = index === maxLines - 1 && lines.length > maxLines ? `${content.slice(0, -1)}…` : content
    context.fillText(clipped, x, y + index * lineHeight)
  })
  context.restore()
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
  if (card?.category === 'ARMOR' && card.rarity === 'BLUE') {
    const size = Math.max(9, Math.min(24, rect.width * 0.19))
    const x = rect.x + inset + 2
    const y = rect.y + inset + 2
    roundedPath(x, y, size, size, 3)
    context.fillStyle = '#17577f'
    context.fill()
    context.strokeStyle = '#9ad9ff'
    context.lineWidth = 1
    context.stroke()
    text('蓝', x + size / 2, y + size / 2, Math.max(7, size * 0.69), '#f1faff', 'center', 'bold')
  }
  context.restore()
  return art
}

function drawScrollIndicator(viewport, contentHeight, scrollY) {
  if (contentHeight <= viewport.height + 1) return
  const trackHeight = viewport.height - 12
  const thumbHeight = Math.max(28, trackHeight * viewport.height / contentHeight)
  const maxScroll = contentHeight - viewport.height
  const travel = trackHeight - thumbHeight
  const thumbY = viewport.y + 6 + travel * (scrollY / maxScroll)
  roundedPath(viewport.x + viewport.width - 5, viewport.y + 6, 3, trackHeight, 2)
  context.fillStyle = 'rgba(255,255,255,.10)'
  context.fill()
  roundedPath(viewport.x + viewport.width - 5, thumbY, 3, thumbHeight, 2)
  context.fillStyle = 'rgba(255,215,116,.72)'
  context.fill()
}

function drawFloatingCard(card, point) {
  if (!card || !point) return
  const width = Math.min(94, viewWidth * 0.115)
  const height = width / CARD_ASPECT_RATIO
  const rect = { x: point.x - width / 2, y: point.y - height * 0.5, width, height }
  context.save()
  context.globalAlpha = 0.93
  context.shadowColor = '#ffd266'
  context.shadowBlur = 18
  drawCardArt(card, rect, { radius: 10, inset: 2, stroke: '#fff1a8', lineWidth: 2 })
  context.restore()
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

function drawQuantity(rect, quantity) {
  panel(rect.x + rect.width - 29, rect.y + 2, 27, 16, { radius: 4, fill: 'rgba(10,6,14,.92)', stroke: '#e6c379' })
  text(`×${quantity}`, rect.x + rect.width - 15, rect.y + 10, 9, '#fff0cf', 'center', 'bold')
}

function drawLoadoutCard(card, rect, selected, location, quantity) {
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
  if (quantity !== undefined) drawQuantity(rect, quantity)
}

function addLoadoutCard(cardId) {
  const result = loadout.add(cardId)
  if (result.ok) {
    loadoutSelection = null
    addToast('卡牌已放入行动背包。')
    return true
  }
  if (result.reason === 'LOADOUT_FULL') addToast('本次行动最多携带 4 张卡牌。')
  else if (result.reason === 'LOADOUT_CATEGORY_NOT_ALLOWED') addToast('战备只可携带武器、防具或技能卡。')
  else addToast('该卡牌无法放入背包。')
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
  return quantitySlots(accountProfile ? accountProfile.quantities : {})
    .map(slot => ({ ...cardById(slot.cardId), quantity: slot.quantity }))
    .filter(card => warehouseFilter === 'ALL' || card.category === warehouseFilter)
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
  drawCover(assets.homeBackground)
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
  text(`拥有 ${loadout.ownedCardIds.length}/${cards.length} · ${cardCatalogSource === 'SERVER' ? '云端卡库' : '本地缓存'}`, viewWidth - 16, 21, 9, cardCatalogSource === 'SERVER' ? '#9fe5c2' : '#ffd47d', 'right', 'bold')

  const filterY = panelRect.y + 11
  const filterGap = 4
  const filterWidth = (panelRect.width - 24 - filterGap * 4) / 5
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
  const gridViewport = {
    x: panelRect.x + 9,
    y: panelRect.y + 46,
    width: panelRect.width - 18,
    height: panelRect.height - 55
  }
  const columns = gridViewport.width >= 900 ? 7 : gridViewport.width >= 700 ? 6 : 5
  const grid = createVerticalCardGrid({
    viewport: gridViewport,
    count: filteredCards.length,
    columns,
    gap: 9,
    padding: 7,
    scrollY: warehouseScrollY
  })
  warehouseScrollY = grid.scrollY
  ui.warehouseScrollRect = gridViewport
  ui.warehouseMaxScroll = grid.maxScroll

  context.save()
  roundedPath(gridViewport.x, gridViewport.y, gridViewport.width, gridViewport.height, 10)
  context.clip()
  grid.rects.forEach((rect, index) => {
    if (!rectsIntersect(rect, gridViewport)) return
    const card = filteredCards[index]
    drawLoadoutCard(card, rect, false, 'WAREHOUSE', card.quantity)
    ui.hotspots.push({ id: 'warehouse_card', rect: intersectionRect(rect, gridViewport), data: card.cardId })
  })
  context.restore()
  drawScrollIndicator(gridViewport, grid.contentHeight, warehouseScrollY)

  button('warehouse_home', '返回首页', { x: 14, y: viewHeight - 43, width: 124, height: 31 }, { top: '#554653', bottom: '#2a222c', stroke: '#a692a4', size: 11 })
  text(`当前分类 ${filteredCards.length} 张 · 上下滑动浏览 · 点击卡牌查看大图`, viewWidth / 2, viewHeight - 28, 9, '#c6b8c8', 'center')
  drawWarehousePreview()
}

function drawWarehousePreview() {
  const card = cardById(warehousePreviewCardId)
  if (!card) return
  context.fillStyle = 'rgba(7,4,12,.92)'
  context.fillRect(0, 0, viewWidth, viewHeight)

  const detailHeight = Math.min(112, viewHeight * 0.23)
  const detailY = viewHeight - detailHeight - 10
  const availableHeight = detailY - 22
  const cardWidth = Math.min(viewWidth * 0.34, availableHeight * CARD_ASPECT_RATIO)
  const cardHeight = cardWidth / CARD_ASPECT_RATIO
  const cardRect = {
    x: (viewWidth - cardWidth) / 2,
    y: 12 + Math.max(0, (availableHeight - cardHeight) / 2),
    width: cardWidth,
    height: cardHeight
  }
  drawCardArt(card, cardRect, { radius: 14, inset: 3, stroke: '#ffe199', lineWidth: 2.5 })
  text('点击屏幕任意位置返回仓库', viewWidth - 18, 19, 9, '#d8c6d4', 'right', 'bold')

  panel(18, detailY, viewWidth - 36, detailHeight, { fill: 'rgba(32,20,38,.98)', stroke: '#d5a84e', lineWidth: 2, radius: 14 })
  text(card.name, 34, detailY + 23, 16, cardColor(card), 'left', 'bold')
  text(cardMeta(card), viewWidth - 34, detailY + 23, 10, '#ffe9bd', 'right', 'bold')
  drawWrappedText(card.description || cardMeta(card), 34, detailY + 49, viewWidth - 68, 18, 10, '#d9cbd8', 3)
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
  const remaining = { ...state.quantities }
  state.selectedCardIds.forEach(id => { remaining[id] -= 1 })
  const warehouseStacks = quantitySlots(remaining).filter(slot => state.warehouseCardIds.includes(slot.cardId))
  const selectedStacks = stackItems(state.selectedCardIds.map((cardId, index) => ({ cardId, instanceId: String(index) })))

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
  text(`武器/防具/技能 · ${state.warehouseCardIds.length}张`, warehouseRect.x + warehouseRect.width - 12, warehouseRect.y + 18, 8, '#c9b9ca', 'right', 'bold')
  ui.loadoutWarehouseDropRect = warehouseRect
  const detailHeight = 36
  const gridViewport = {
    x: warehouseRect.x + 7,
    y: warehouseRect.y + 33,
    width: warehouseRect.width - 14,
    height: warehouseRect.height - 39 - detailHeight
  }
  const columns = gridViewport.width >= 540 ? 5 : 4
  const grid = createVerticalCardGrid({
    viewport: gridViewport,
    count: warehouseStacks.length,
    columns,
    gap: 6,
    padding: 4,
    scrollY: loadoutScrollY
  })
  loadoutScrollY = grid.scrollY
  ui.loadoutWarehouseScrollRect = gridViewport
  ui.loadoutWarehouseMaxScroll = grid.maxScroll
  context.save()
  roundedPath(gridViewport.x, gridViewport.y, gridViewport.width, gridViewport.height, 9)
  context.clip()
  grid.rects.forEach((rect, index) => {
    if (!rectsIntersect(rect, gridViewport)) return
    const cardId = warehouseStacks[index].cardId
    const card = cardById(cardId)
    const selected = loadoutSelection && loadoutSelection.cardId === cardId && loadoutSelection.source === 'WAREHOUSE'
    drawLoadoutCard(card, rect, selected, 'WAREHOUSE', warehouseStacks[index].quantity)
    const visibleRect = intersectionRect(rect, gridViewport)
    ui.loadoutWarehouseRects.push({ ...visibleRect, cardId })
    ui.hotspots.push({ id: 'loadout_warehouse_card', rect: visibleRect, data: cardId })
  })
  context.restore()
  drawScrollIndicator(gridViewport, grid.contentHeight, loadoutScrollY)
  if (state.warehouseCardIds.length === 0) text('暂无可携带的武器、防具或技能卡', warehouseRect.x + warehouseRect.width / 2, warehouseRect.y + warehouseRect.height / 2, 11, '#8e7e8c', 'center')

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
  const bagViewport = {
    x: backpackRect.x + 8,
    y: backpackRect.y + 31,
    width: backpackRect.width - 16,
    height: backpackRect.height - 39
  }
  const bagGrid = createContainedCardGrid({
    viewport: bagViewport,
    count: C.BACKPACK_SLOTS,
    columns: 3,
    gap: 5,
    padding: 3
  })
  bagGrid.rects.forEach((rect, index) => {
    roundedPath(rect.x, rect.y, rect.width, rect.height, 6)
    context.fillStyle = index < C.LOADOUT_CARD_LIMIT ? 'rgba(103,61,113,.22)' : 'rgba(255,255,255,.035)'
    context.fill()
    context.strokeStyle = index < C.LOADOUT_CARD_LIMIT ? 'rgba(205,161,241,.45)' : 'rgba(255,255,255,.13)'
    context.stroke()
    const cardId = selectedStacks[index] && selectedStacks[index].cardId
    if (cardId) {
      const card = cardById(cardId)
      const selected = loadoutSelection && loadoutSelection.cardId === cardId && loadoutSelection.source === 'BACKPACK'
      drawLoadoutCard(card, rect, selected, 'BACKPACK', selectedStacks[index].quantity)
      ui.loadoutBackpackRects.push({ ...rect, cardId })
      ui.hotspots.push({ id: 'loadout_backpack_card', rect, data: cardId })
    } else if (index < C.LOADOUT_CARD_LIMIT) {
      text(`携带位 ${index + 1}`, rect.x + rect.width / 2, rect.y + rect.height / 2, 8, '#8f7899', 'center')
    } else {
      text(`${index + 1}`, rect.x + rect.width / 2, rect.y + rect.height / 2, 8, '#5d5361', 'center')
    }
  })
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
  button('loadout_match', '前往码头', { x: viewWidth - 154, y: viewHeight - 47, width: 140, height: 35 }, { top: '#dc9f3a', bottom: '#882e25', stroke: '#ffe19a', size: 12 })
  if (loadoutDragging) drawFloatingCard(cardById(loadoutDragging.cardId), loadoutDragPoint)
}

function enterLobby() {
  lobbyPage = 0
  lobbyShowPlaying = false
  lobbyLastRefresh = -Infinity
  lobbyError = ''
  setScene('LOBBY')
  refreshLobby()
}

function consumeLobbyResponse(response) {
  if (lobbyRoom && response.lastSettlement?.gameId === lobbyRoom.roomId && !response.lastSettlement.acknowledged) pendingResume = true
  applyAccountResponse(response)
  if (accountGame || (pendingResume && presentation === 'SETTLEMENT')) resumeAccountGame()
}

async function refreshLobby() {
  if (lobbyPollInFlight || accountBusy || accountBackground || scene !== 'LOBBY') return
  lobbyPollInFlight = true
  lobbyLastRefresh = Date.now()
  try {
    const response = await accountApi.command('lobby', { op: 'list' })
    if (scene !== 'LOBBY') return
    const previousRoom = lobbyRoom
    consumeLobbyResponse(response)
    lobbyError = ''
    if (previousRoom && !lobbyRoom && !accountGame) addToast('等待时间已到，房间已关闭。', 2400)
  } catch (error) {
    if (scene === 'LOBBY' && error.code === 'ACTIVE_GAME_EXISTS') {
      try {
        const response = await accountApi.command('resume')
        if (scene !== 'LOBBY') return
        if (response.lastSettlement && !response.lastSettlement.acknowledged) pendingResume = true
        consumeLobbyResponse(response)
        lobbyError = ''
        return
      } catch (_) {}
    }
    lobbyError = '大厅连接中断，正在重试…'
  } finally {
    lobbyPollInFlight = false
    invalidateFrame()
  }
}

async function lobbyAction(op, roomId) {
  if (accountBusy) return
  beginAccountRequest(op === 'start' ? '正在确认开局…' : '正在同步房间…')
  try {
    const input = { op, roomId }
    if (op === 'create' || op === 'join') input.cardIds = loadout.snapshot().selectedCardIds
    consumeLobbyResponse(await accountApi.command('lobby', input))
  } catch (error) { addToast(accountError(error), 2600) }
  finally { endAccountRequest() }
  refreshLobby()
}

function drawLobby() {
  drawCover(assets.homeBackground || assets.map)
  darken(0.54, '18,9,32')
  const margin = 16
  const top = 50
  const bottom = viewHeight - 55
  const height = bottom - top
  const gap = 10
  const listWidth = Math.floor((viewWidth - margin * 2 - gap) * 0.62)
  const detailX = margin + listWidth + gap
  const detailWidth = viewWidth - detailX - margin
  const small = { size: 10, radius: 7, top: '#54404e', bottom: '#2a1a30', stroke: '#b29676' }

  text('♠ 码头匹配大厅', margin, 24, 21, PALETTE.paleGold, 'left', 'bold')
  text(lobbyError || '选择房间与其他玩家登船，也可单独出发。', margin + 182, 25, 11, '#e9d5c5')
  panel(margin, top, listWidth, height, { fill: 'rgba(25,14,33,.92)', stroke: '#c6a36c', radius: 12 })
  panel(detailX, top, detailWidth, height, { fill: 'rgba(31,17,37,.94)', stroke: '#c6a36c', radius: 12 })

  const waiting = lobbyRooms.filter(room => room.status === 'WAITING')
  const playing = lobbyRooms.filter(room => room.status === 'PLAYING')
  const rows = lobbyShowPlaying ? waiting.concat(playing) : waiting
  const rowHeight = 27
  const perPage = Math.max(1, Math.floor((height - 68) / rowHeight))
  const pageCount = Math.max(1, Math.ceil(rows.length / perPage))
  lobbyPage = Math.max(0, Math.min(lobbyPage, pageCount - 1))
  text(`待开始（${waiting.length}）`, margin + 13, top + 18, 12, PALETTE.paleGold, 'left', 'bold')
  button('lobby_toggle_playing', `游戏中（${playing.length}） ${lobbyShowPlaying ? '▴' : '▾'}`,
    { x: margin + listWidth - 130, y: top + 7, width: 120, height: 22 }, { ...small, data: Math.floor(waiting.length / perPage) })
  if (!rows.length) text('暂无可加入的房间', margin + listWidth / 2, top + height / 2, 12, '#c3aec6', 'center')
  rows.slice(lobbyPage * perPage, (lobbyPage + 1) * perPage).forEach((room, index) => {
    const rect = { x: margin + 10, y: top + 34 + index * rowHeight, width: listWidth - 20, height: 24 }
    const inGame = room.status === 'PLAYING'
    const ownRoom = lobbyRoom?.roomId === room.roomId
    panel(rect.x, rect.y, rect.width, rect.height, { fill: inGame ? '#231f35' : ownRoom ? '#623c36' : '#3b243d',
      stroke: ownRoom ? '#ffd781' : 'rgba(209,170,110,.36)', radius: 6 })
    text(room.name, rect.x + 9, rect.y + 12, 11, inGame ? '#c0b6d4' : '#fff0d4', 'left', 'bold', rect.width - 113)
    text(`${room.playerCount}/${room.capacity}  ${inGame ? '游戏中' : ownRoom ? '我的房间' : '待开始'}`,
      rect.x + rect.width - 9, rect.y + 12, 10, inGame ? '#b4a6e8' : '#ffe29c', 'right')
    if (!inGame && !ownRoom && !lobbyRoom) ui.hotspots.push({ id: 'lobby_join', rect, data: room })
  })
  if (pageCount > 1) {
    const pageY = bottom - 26
    if (lobbyPage > 0) button('lobby_page', '上一页', { x: margin + 12, y: pageY, width: 66, height: 21 }, { ...small, data: -1 })
    text(`${lobbyPage + 1}/${pageCount}`, margin + listWidth / 2, pageY + 11, 10, '#d6bfa8', 'center')
    if (lobbyPage + 1 < pageCount) button('lobby_page', '下一页', { x: margin + listWidth - 78, y: pageY, width: 66, height: 21 }, { ...small, data: 1 })
  }

  if (lobbyRoom) {
    const time = Math.max(0, Math.ceil((lobbyDeadlineAt - Date.now()) / 1000))
    text(lobbyRoom.name, detailX + 12, top + 20, 14, PALETTE.paleGold, 'left', 'bold', detailWidth - 24)
    text(`等待登船 · ${String(Math.floor(time / 60)).padStart(2, '0')}:${String(time % 60).padStart(2, '0')}`,
      detailX + 12, top + 44, 11, '#dcc6ac')
    for (let index = 0; index < C.PLAYER_LIMIT; index += 1) {
      const member = lobbyRoom.members[index]
      const y = top + 69 + index * 22
      const role = member ? `${member.isHost ? ' · 房主' : ''}${member.isSelf ? ' · 你' : ''}` : ''
      text(member ? `${member.nickname}${role}` : '等待加入', detailX + 12, y, 11,
        member ? '#fff0d5' : '#9e88a5', 'left', 'normal', detailWidth - 24)
    }
    text(lobbyRoom.isHost ? '满 2 人可开局' : '等待房主开局', detailX + 12, bottom - 17, 10, '#dec4ab')
  } else {
    text('登 船 准 备', detailX + 12, top + 20, 14, PALETTE.paleGold, 'left', 'bold')
    text(`本次战备 ${loadout.selectedCardIds.length}/${C.LOADOUT_CARD_LIMIT}`, detailX + 12, top + 46, 11, '#ffe7bf')
    text('多人房间支持 2–3 人开局', detailX + 12, top + 70, 11, '#d8c4d6', 'left', 'normal', detailWidth - 24)
    text('正式开局后扣除带入战备', detailX + 12, top + 91, 11, '#d8c4d6', 'left', 'normal', detailWidth - 24)
  }

  const actionY = viewHeight - 43
  const actionWidth = Math.min(124, (viewWidth - margin * 2 - 16) / 3)
  const actionRect = (fromRight, width = actionWidth) => ({ x: viewWidth - margin - width - fromRight, y: actionY, width, height: 32 })
  button(lobbyRoom ? 'lobby_leave' : 'lobby_back', lobbyRoom ? '退出房间' : '返回战备',
    { x: margin, y: actionY, width: actionWidth, height: 32 }, small)
  if (!lobbyRoom) {
    button('lobby_create', '创建房间', actionRect(actionWidth + 8), { ...small, size: 12 })
    button('lobby_single', '单人模式', actionRect(0), { size: 12 })
  } else if (lobbyRoom.isHost && lobbyRoom.playerCount >= 2 && lobbyDeadlineAt > Date.now()) {
    button('lobby_start', '开始游戏', actionRect(0), { size: 12 })
  }
}

async function startGame() {
  if (accountBusy) return
  beginAccountRequest('正在建立对局…')
  try {
    const response = await accountApi.command('start', { cardIds: loadout.snapshot().selectedCardIds, mode: 'SINGLE' })
    applyAccountResponse(response)
    resumeAccountGame()
  } catch (error) {
    addToast(accountError(error), 3000)
    try {
      const response = await accountApi.command('resume')
      applyAccountResponse(response)
      if (response.activeGame) resumeAccountGame()
      else if (scene !== 'LOBBY') setScene('LOADOUT')
    } catch (_) { if (scene !== 'LOBBY') setScene('LOADOUT') }
  } finally { endAccountRequest() }
}










function beginRoomVisit() {
  presentation = 'ROOM'
  invalidateFrame()
  // Display the usable room immediately, then replace fallback art as it loads.
  // Waiting here also allowed a stale asset promise to overwrite a later turn.
  loadSearchAssets().then(invalidateFrame)
}


function currentState() {
  // Rendering only reads this server-projected engine. No JSON deep copy per frame.
  return engine
}

function drawTopHud(state) {
  const local = state.players.find(player => player.id === 'P1')
  const hudLayout = createHudSafeLayout(viewWidth, menuButtonRect)
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
  const { title, round, hp, alert, resource } = hudLayout
  text('♠ 大劫卡西诺', title.x, 23, 17, PALETTE.paleGold, 'left', 'bold', title.width)
  text(`回合 ${String(state.turn).padStart(2, '0')}/${C.MAX_TURNS}`, round.x, 17, 11, '#decdd3', 'left', 'normal', round.width)
  const progressWidth = Math.min(96, round.width)
  roundedPath(round.x, 29, progressWidth, 6, 3)
  context.fillStyle = 'rgba(255,255,255,.13)'
  context.fill()
  roundedPath(round.x, 29, progressWidth * state.turn / C.MAX_TURNS, 6, 3)
  context.fillStyle = state.turn >= 10 ? '#ee5252' : PALETTE.gold
  context.fill()
  text(`HP ${local.hp}/${local.maxHp}`, hp.x + hp.width / 2, 15, 11, '#fff5e3', 'center', 'bold', hp.width)
  hpBar(hp.x, 29, hp.width, local.hp, local.maxHp)
  const alertActive = state.turn >= C.ALERT_START_TURN
  text(alertActive ? '⚠ 警报圈生效' : `警报圈：第${C.ALERT_START_TURN}轮`, alert.x + alert.width / 2, 23, 11, alertActive ? '#ff6c6c' : '#c7b8cc', 'center', 'bold', alert.width)
  text(`物资 ${formatGold(engine.inventoryValue('P1'))}`, hudLayout.resourceRight, 23, 12, PALETTE.gold, 'right', 'bold', resource.width)
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
  const inventoryStacks = stackItems(local.inventory.map(id => state.items.find(item => item.instanceId === id)).filter(Boolean))
  panel(x, y, width, viewHeight - y - 70, { fill: 'rgba(28,17,30,.9)', stroke: 'rgba(247,201,92,.66)', radius: 13 })
  text('装备与背包', x + 14, y + 20, 14, PALETTE.paleGold, 'left', 'bold')
  const weapon = state.items.find(item => item.instanceId === local.equippedWeaponId)
  const weaponCard = weapon && cardById(weapon.cardId)
  panel(x + 10, y + 38, width - 20, 46, { fill: 'rgba(98,30,40,.55)', stroke: '#b57962', radius: 8 })
  const equippedArtRect = { x: x + 14, y: y + 42, width: 30, height: 38 }
  if (weaponCard) drawCardArt(weaponCard, equippedArtRect, { radius: 5, inset: 1, lineWidth: 1 })
  const weaponTextX = weaponCard ? x + 51 : x + 20
  text(weaponCard ? weaponCard.name : '徒手', weaponTextX, y + 54, 12, '#fff2d5', 'left', 'bold')
  text(weaponCard ? `攻击倍率 ${weaponCard.attackMultiplier}` : '攻击倍率 0.3', weaponTextX, y + 72, 9, '#d7bca9')
  text(`背包 ${inventoryStacks.length}/${C.BACKPACK_SLOTS}`, x + 14, y + 103, 11, '#d8cbd7', 'left', 'bold')
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
    const instanceId = inventoryStacks[index] && inventoryStacks[index].instanceId
    if (instanceId) {
      const item = state.items.find(candidate => candidate.instanceId === instanceId)
      const card = item && cardById(item.cardId)
      drawCardArt(card, rect, { radius: 6, inset: 2, stroke: 'rgba(230,198,125,.55)', lineWidth: 1 })
      drawQuantity(rect, inventoryStacks[index].quantity)
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

function canSelectMovement(state) {
  return state.phase === 'MOVE_SELECTION' && !accountGame?.waiting && Date.now() < state.moveDeadlineAt
}

function drawMovementRooms(state, layout) {
  const local = state.players.find(player => player.id === 'P1')
  const selecting = canSelectMovement(state)
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

      const info = roomInfoAt(x, y)
      const labelWidth = rect.width * 0.72
      const labelHeight = Math.min(rect.height * 0.3, Math.max(12, 21 * scale))
      const labelX = rect.x + (rect.width - labelWidth) / 2
      const labelY = rect.y + rect.height - labelHeight - 3 * scale
      roundedPath(labelX, labelY, labelWidth, labelHeight, labelHeight / 2)
      context.fillStyle = 'rgba(20,12,22,.86)'
      context.fill()
      text(info.name, rect.x + rect.width / 2, labelY + labelHeight / 2, Math.max(8, 16 * scale), info.color, 'center', 'bold', labelWidth - 6 * scale)

      if (selecting && (current || reachable)) ui.hotspots.push({ id: 'map_node', rect: roomRect(layout, x, y), data: { x, y } })
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
  if (accountGame?.waiting && seconds > 0) {
    drawHudPlate(layout.action, { stroke: '#c2a475', inner: '#584332' })
    text(`等待其他玩家  ${seconds}s`, layout.action.x + layout.action.width / 2, layout.action.y + layout.action.height / 2,
      Math.max(9, 16 * scale), '#eadfc9', 'center', 'bold', layout.action.width - 8 * scale)
  } else if (canSelectMovement(state)) {
    button('confirm_move', selectedMove ? `确认移动  ${seconds}s` : `原地停留  ${seconds}s`, layout.action, {
      top: selectedMove ? '#c43b32' : '#78552e',
      bottom: selectedMove ? '#6d1423' : '#372519',
      stroke: '#ffe17d',
      size: Math.max(9, 17 * scale),
      radius: Math.max(7, 12 * scale)
    })
  } else {
    drawHudPlate(layout.action, { stroke: '#a99470', inner: '#584332' })
    text(seconds === 0 ? '同步回合中…' : '行动结算中', layout.action.x + layout.action.width / 2, layout.action.y + layout.action.height / 2, Math.max(9, 17 * scale), '#eadfc9', 'center', 'bold')
  }
  context.save()
  context.shadowColor = '#281720'
  context.shadowBlur = 4
  context.shadowOffsetY = 1
  text(`目标：${roomTypeAt(target.x, target.y)}`, layout.action.x + layout.action.width / 2, layout.action.y + layout.action.height + 17 * scale, Math.max(8, 12 * scale), '#fff0c8', 'center', 'bold')
  context.restore()
}

// Trace the original title plate so the old background behind it does not show.
const MOVEMENT_LOCATION_OUTLINE = [
  [15, 70], [26, 57], [43, 45], [44, 40], [51, 37], [58, 39], [85, 39], [98, 31],
  [111, 35], [126, 27], [138, 28], [150, 14], [167, 6], [184, 14], [195, 28], [211, 27],
  [219, 34], [234, 32], [246, 39], [274, 39], [282, 37], [288, 40], [289, 45], [307, 56],
  [319, 70], [307, 83], [288, 96], [287, 101], [281, 105], [254, 103], [248, 99], [180, 99],
  [172, 103], [161, 103], [152, 99], [83, 99], [77, 103], [51, 105], [45, 102], [43, 96], [27, 84]
]

function drawMovementLocation(layout) {
  const image = assets.movementLocation
  if (!image) return
  const { x, y, width, height } = layout.location
  const { scale } = layout.transform
  context.save()
  context.beginPath()
  MOVEMENT_LOCATION_OUTLINE.forEach(([px, py], index) => {
    const drawX = x + px * scale
    const drawY = y + py * scale
    if (index === 0) context.moveTo(drawX, drawY)
    else context.lineTo(drawX, drawY)
  })
  context.closePath()
  context.clip()
  context.drawImage(image, x, y, width, height)
  context.restore()
}

function drawMovementLegend(layout) {
  const rect = layout.legend
  const scale = layout.transform.scale
  const entries = [
    ...Object.values(ROOM_TYPE_INFO),
    { name: '当前房间', color: '#d6ffe8' },
    { name: '可前往房间', color: '#4bff9f' },
    { name: '未探索区域', color: '#a8a5b4' }
  ]
  context.fillStyle = '#171019'
  context.fillRect(rect.x, rect.y, rect.width, rect.height)
  context.strokeStyle = '#d9ad60'
  context.lineWidth = Math.max(1, 2 * scale)
  context.strokeRect(rect.x, rect.y, rect.width, rect.height)
  text('房间类型', rect.x + rect.width / 2, rect.y + 25 * scale, Math.max(9, 18 * scale), '#ffe8b0', 'center', 'bold', rect.width - 12 * scale)
  const rowHeight = (rect.height - 54 * scale) / entries.length
  entries.forEach(({ name, color }, index) => {
    const y = rect.y + 46 * scale + (index + 0.5) * rowHeight
    context.fillStyle = color
    context.fillRect(rect.x + 16 * scale, y - 5 * scale, 10 * scale, 10 * scale)
    text(name, rect.x + 36 * scale, y, Math.max(8, 16 * scale), color, 'left', 'normal', rect.width - 47 * scale)
  })
}

function drawMapScene(state) {
  drawContainedBackdrop(assets.movementMap || assets.map, '#09080b')
  const layout = createMovementLayout(viewWidth, viewHeight)
  drawMovementRooms(state, layout)
  drawMovementPin(state, layout)
  drawMovementLandmarks(layout)
  drawMovementLegend(layout)
  drawMovementLocation(layout)
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
  beginRoomVisit()
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
  if (!searchVisitState || canActInRoom()) {
    button('battle_continue', won ? '查看战利品' : '进入结算', { x: viewWidth / 2 - 70, y: viewHeight - 39, width: 140, height: 30 }, { size: 10, top: won ? '#cc8b2f' : '#8b3546', bottom: won ? '#87421f' : '#4d2335' })
  } else text('同步回合中…', viewWidth / 2, viewHeight - 24, 10, '#ffe9bd', 'center', 'bold')
}

function canActInRoom() {
  const visit = searchVisitState?.visit
  return visit?.status === 'ACTIVE' && Date.now() < visit.deadlineAt
}

function currentSearchProgress() {
  return searchVisitState ? searchTimerState(searchVisitState.visit.deadlineAt, Date.now()).progress : 0
}

function drawDesignAsset(key, layout, sourceRect, options = {}) {
  const image = assets[key]
  if (!image) return
  const rect = {
    x: layout.offsetX + sourceRect.x * layout.scale,
    y: layout.offsetY + sourceRect.y * layout.scale,
    width: sourceRect.width * layout.scale,
    height: sourceRect.height * layout.scale
  }
  context.save()
  context.globalAlpha = options.alpha === undefined ? 1 : options.alpha
  context.translate(rect.x + rect.width / 2, rect.y + rect.height / 2)
  if (options.rotation) context.rotate(options.rotation * Math.PI / 180)
  context.scale(options.flipX ? -1 : 1, options.flipY ? -1 : 1)
  context.drawImage(image, -rect.width / 2, -rect.height / 2, rect.width, rect.height)
  context.restore()
}

function drawRoomArtwork() {
  if (!roomArtworkCache && !roomArtworkCacheDisabled && searchAssetsReady) {
    const screenContext = context
    try {
      const layer = createLayerCanvas(wx, canvas)
      if (!layer) throw new Error('Offscreen canvas unavailable')
      context = layer.getContext('2d')
      context.scale(pixelRatio, pixelRatio)
      paintRoomArtwork()
      roomArtworkCache = layer
    } catch (_) { roomArtworkCacheDisabled = true }
    finally { context = screenContext }
  }
  if (roomArtworkCache) {
    try {
      context.drawImage(roomArtworkCache, 0, 0, viewWidth, viewHeight)
      return createRoomLayout(viewWidth, viewHeight)
    } catch (_) { roomArtworkCache = null; roomArtworkCacheDisabled = true }
  }
  return paintRoomArtwork()
}

function paintRoomArtwork() {
  const layout = createRoomLayout(viewWidth, viewHeight)
  const background = assets.searchRoomBackground
  const artwork = layout.artwork
  const { x, y, width, height } = layout.contentRect
  if (background) context.drawImage(background, x, y, width, height)
  else drawCover(assets.map)
  drawDesignAsset('searchRoomChairLeft', artwork, { x: 238, y: 461, width: 188, height: 229 }, { rotation: 0.85 })
  drawDesignAsset('searchRoomChairLeft', artwork, { x: 899, y: 442, width: 201, height: 236 }, { rotation: -173.74, flipY: true })
  drawDesignAsset('searchRoomChairLeft', artwork, { x: 620, y: 379, width: 242, height: 279 }, { rotation: 169.81, flipY: true })
  drawDesignAsset('searchRoomMainTable', artwork, { x: 270, y: 500, width: 756, height: 462 })
  drawDesignAsset('searchRoomChairFront', artwork, { x: 809, y: 731, width: 217, height: 262 })
  drawDesignAsset('searchRoomChairFront', artwork, { x: 443, y: 740, width: 234, height: 274 }, { rotation: -175.75, flipY: true })
  drawDesignAsset('searchRoomForeground', artwork, { x: 0, y: 639, width: 1920, height: 442 })
  return layout
}

function drawSearchTimer(layout = createSearchLayout(viewWidth, viewHeight)) {
  const progress = currentSearchProgress()
  const timer = layout.timer
  if (assets.searchProgressTrack) context.drawImage(assets.searchProgressTrack, timer.x, timer.y, timer.width, timer.height)
  else panel(timer.x, timer.y, timer.width, timer.height, { fill: 'rgba(10,7,14,.9)', stroke: '#f0bd52', radius: timer.height / 2 })
  context.save()
  context.beginPath()
  context.rect(timer.x + timer.width * 0.02, timer.y, timer.width * 0.96 * progress, timer.height)
  context.clip()
  if (assets.searchProgressFill) context.drawImage(assets.searchProgressFill, timer.x, timer.y, timer.width, timer.height)
  context.restore()
}

function drawRoomClock(rect) {
  const half = rect.width / (2 * Math.SQRT2)
  const radius = rect.width * 0.22
  context.save()
  context.translate(rect.x + rect.width / 2, rect.y + rect.height / 2)
  context.save()
  context.rotate(Math.PI / 4)
  panel(-half, -half, half * 2, half * 2, {
    fill: '#51151b', stroke: '#edbf65', radius: half * 0.12, lineWidth: Math.max(1, radius * 0.16)
  })
  context.restore()
  context.strokeStyle = '#ffe09a'
  context.lineWidth = Math.max(1, radius * 0.15)
  context.beginPath()
  context.arc(0, 0, radius, 0, Math.PI * 2)
  context.stroke()
  context.beginPath()
  context.moveTo(0, -radius * 0.62)
  context.lineTo(0, 0)
  context.lineTo(radius * 0.49, radius * 0.23)
  context.stroke()
  context.restore()
}

function drawRoomTimer(layout) {
  const { timerTrack: track, timerFill: fill, timerIcon: icon } = layout
  const image = assets.searchRoomTimerTrack
  if (image) context.drawImage(image, track.x, track.y, track.width, track.height)
  else panel(fill.x - 1, fill.y - 1, fill.width + 2, fill.height + 2, { fill: '#32131c', stroke: '#edbf65', radius: fill.height / 2 })
  const progress = currentSearchProgress()
  if (progress > 0) {
    context.save()
    roundedPath(fill.x, fill.y, fill.width, fill.height, fill.height / 2)
    context.clip()
    context.beginPath()
    context.rect(fill.x, fill.y, fill.width * progress, fill.height)
    context.clip()
    const art = assets.searchRoomTimerFill
    if (art) drawImageSourceInRect(art, SEARCH_ASSET_CROPS.roomTimerFill, fill)
    else {
      context.fillStyle = PALETTE.gold
      context.fillRect(fill.x, fill.y, fill.width, fill.height)
    }
    context.restore()
  }
  drawRoomClock(icon)
}

function drawAuthorityBadge(x, y) {
  const remote = searchAuthority === 'REMOTE' || searchAuthority === 'ACCOUNT'
  const label = remote ? '服务端权威结算' : searchAuthority === 'CONNECTING' ? '连接搜索服务' : '本地安全降级'
  panel(x, y, 106, 22, { fill: remote ? 'rgba(24,89,67,.88)' : 'rgba(88,48,38,.88)', stroke: remote ? '#8effc7' : '#ffd28c', radius: 11 })
  text(label, x + 53, y + 11, 8, remote ? '#d9ffea' : '#fff0cb', 'center', 'bold')
}

function drawRoom(state) {
  const layout = drawRoomArtwork()
  const visitOpen = canActInRoom()
  const node = searchVisitState ? searchVisitState.room.nodeId : positionKey(engine.getPlayer('P1').position)
  const roomName = roomTypeForNode(node)
  // Hit testing goes from last to first: background regions sit below buttons.
  ui.roomAreaRects = layout.areas
  if (visitOpen && !searchRequestPending) {
    layout.areas.forEach(area => ui.hotspots.push({ id: 'room_area', rect: area, data: area.areaId }))
  }
  drawDesignAsset('searchRoomTitlePanel', layout, { x: 133, y: 58, width: 515, height: 163 })
  drawDesignAsset('searchRoomTitleSpade', layout, { x: 133, y: 95, width: 134, height: 90 })
  text(roomName, layout.offsetX + 428 * layout.scale, layout.offsetY + 135 * layout.scale, Math.max(18, 48 * layout.scale), '#fff1c1', 'center', 'bold')

  drawRoomTimer(layout)

  drawDesignAsset('searchRoomLeaveButton', layout, { x: 1371, y: 889, width: 292, height: 104 })
  drawDesignAsset('searchRoomLeaveIcon', layout, { x: 1429, y: 911, width: 46, height: 60 })
  text(searchVisitState && !visitOpen ? '同步回合中…' : '离开房间', layout.offsetX + 1548 * layout.scale, layout.offsetY + 938 * layout.scale, Math.max(12, 29 * layout.scale), '#fff1c1', 'center', 'bold')
  ui.hotspots.push({ id: visitOpen && !searchRequestPending ? 'room_leave' : 'room_leave_disabled', rect: layout.leave })
  if (visitOpen && searchAuthority === 'ACCOUNT' && node === C.EXTRACTION_NODE_ID) {
    button('request_extraction', '呼叫白鸽 · 撤离', { x: viewWidth / 2 - 90, y: viewHeight - 44, width: 180, height: 33 }, { top: '#2c966b', bottom: '#174c3a', size: 12 })
  }

  if (!searchVisitState) text('正在同步房间物资…', viewWidth / 2, viewHeight / 2, Math.max(12, 24 * layout.scale), '#ffe7b0', 'center', 'bold')
}

function drawSearchRipple(slot, now) {
  const state = searchRippleState(slot, now, searchRippleStartedAt)
  context.save()
  context.strokeStyle = '#ffde8f'
  context.lineWidth = Math.max(1.2, Math.min(slot.width, slot.height) * 0.035)
  for (const ring of state.rings) {
    context.globalAlpha = ring.alpha
    context.beginPath()
    context.arc(state.x, state.y, ring.radius, 0, Math.PI * 2)
    context.stroke()
  }
  context.restore()
}

function drawSearchInventoryPanel(rect) {
  const scale = createSearchLayout(viewWidth, viewHeight).scale
  const contentLayout = createSearchPanelContentLayout(rect, scale)
  if (assets.searchPanel) drawNineSliceImage(assets.searchPanel, rect, SEARCH_PANEL_NINE_SLICE, scale)
  else panel(rect.x, rect.y, rect.width, rect.height, { fill: 'rgba(27,15,29,.94)', stroke: '#c9914b', lineWidth: 2, radius: 14 })
  if (assets.searchBagIcon) drawImageSourceInRect(assets.searchBagIcon, SEARCH_ASSET_CROPS.bagIcon, { x: rect.x + 52 * scale, y: contentLayout.iconTop, width: 32 * scale, height: 35 * scale })
  text(`玩家背包  ${searchVisitState ? searchVisitState.inventory.length : 0}/${C.BACKPACK_SLOTS}`, rect.x + 100 * scale, contentLayout.headerBaselineY, Math.max(10, 26 * scale), PALETTE.paleGold, 'left', 'bold')
  ui.searchInventoryRects = []
  const gridViewport = { x: rect.x + 54 * scale, y: contentLayout.gridTop, width: rect.width - 108 * scale, height: contentLayout.gridBottom - contentLayout.gridTop }
  const grid = createContainedCardGrid({ viewport: gridViewport, count: C.BACKPACK_SLOTS, columns: 5, gap: 10 * scale, padding: 2 * scale })
  ui.searchBackpackRect = gridViewport
  grid.rects.forEach((slot, index) => {
    if (assets.searchSlot) drawImageSourceInRect(assets.searchSlot, SEARCH_ASSET_CROPS.slot, slot)
    else panel(slot.x, slot.y, slot.width, slot.height, { fill: 'rgba(255,255,255,.045)', stroke: 'rgba(236,201,126,.32)', radius: 7 })
    const item = searchVisitState && searchVisitState.inventory[index]
    if (item) {
      drawCardArt(cardById(item.cardId), fitAspectRect(slot, CARD_ASPECT_RATIO), { radius: 7, inset: 1, stroke: 'rgba(255,226,157,.72)', lineWidth: 1 })
      drawQuantity(slot, item.quantity || 1)
      ui.searchInventoryRects.push({ ...slot, instanceId: item.instanceId, cardId: item.cardId })
    } else {
      if (assets.searchSlotPattern) drawImageSourceInRect(assets.searchSlotPattern, SEARCH_ASSET_CROPS.slotPattern, { x: slot.x + slot.width * 0.35, y: slot.y + slot.height * 0.32, width: slot.width * 0.3, height: slot.height * 0.36 })
    }
  })
}

function drawSearchRoomPanel(rect) {
  const scale = createSearchLayout(viewWidth, viewHeight).scale
  const contentLayout = createSearchPanelContentLayout(rect, scale)
  if (assets.searchPanel) drawNineSliceImage(assets.searchPanel, rect, SEARCH_PANEL_NINE_SLICE, scale)
  else panel(rect.x, rect.y, rect.width, rect.height, { fill: 'rgba(39,17,26,.95)', stroke: '#cc704d', lineWidth: 2, radius: 14 })
  const activeArea = searchVisitState && searchVisitState.room.activeArea
  const visible = activeArea ? activeArea.visibleItems : []
  const itemCount = activeArea ? activeArea.itemCount : 0
  if (assets.searchBriefcaseIcon) drawImageSourceInRect(assets.searchBriefcaseIcon, SEARCH_ASSET_CROPS.briefcaseIcon, { x: rect.x + 58 * scale, y: contentLayout.iconTop + 3 * scale, width: 38 * scale, height: 30 * scale })
  text(`搜索物品  ${visible.length}/${itemCount}`, rect.x + 110 * scale, contentLayout.headerBaselineY, Math.max(10, 26 * scale), PALETTE.paleGold, 'left', 'bold')
  text('每 2 秒揭示 1 件', rect.x + rect.width - 58 * scale, contentLayout.headerBaselineY, Math.max(7, 16 * scale), '#d8c1b6', 'right')
  const gridWidth = rect.width - 104 * scale
  const slotGap = 10 * scale
  const slotPadding = 2 * scale
  const slotWidth = (gridWidth - slotPadding * 2 - slotGap * 4) / 5
  const twoRowHeight = slotPadding * 2 + (slotWidth / CARD_ASPECT_RATIO) * 2 + slotGap
  const gridViewport = { x: rect.x + 52 * scale, y: contentLayout.gridTop, width: gridWidth, height: Math.min(twoRowHeight, contentLayout.gridBottom - contentLayout.gridTop) }
  ui.searchRoomRect = gridViewport
  ui.searchRoomScrollRect = gridViewport
  ui.searchItemRects = []
  const slotCount = Math.min(C.SEARCH_AREA_CAPACITY, Math.max(10, Math.ceil(Math.max(itemCount, visible.length) / 5) * 5))
  const observation = searchVisitState && searchVisitState.visit.observation
  const now = Date.now()
  const elapsed = observation ? now - observation.startedAt : 0
  const rippleIndex = observation && observation.active && activeArea && now < searchVisitState.visit.deadlineAt
    ? nextSearchRippleIndex(visible.length, itemCount, elapsed, C.SEARCH_REVEAL_INTERVAL_MS) : null
  let grid = createVerticalCardGrid({ viewport: gridViewport, count: slotCount, columns: 5, gap: slotGap, padding: slotPadding, scrollY: searchRoomScrollY })
  if (rippleIndex !== searchRippleSlotIndex) {
    searchRippleSlotIndex = rippleIndex
    searchRippleStartedAt = now
    const targetSlot = rippleIndex === null ? null : grid.rects[rippleIndex]
    if (targetSlot) {
      let nextScroll = grid.scrollY
      if (targetSlot.y < gridViewport.y) nextScroll -= gridViewport.y - targetSlot.y
      if (targetSlot.y + targetSlot.height > gridViewport.y + gridViewport.height) nextScroll += targetSlot.y + targetSlot.height - gridViewport.y - gridViewport.height
      if (nextScroll !== grid.scrollY) {
        searchRoomScrollY = clamp(nextScroll, 0, grid.maxScroll)
        grid = createVerticalCardGrid({ viewport: gridViewport, count: slotCount, columns: 5, gap: slotGap, padding: slotPadding, scrollY: searchRoomScrollY })
      }
    }
  }
  searchRoomScrollY = grid.scrollY
  ui.searchRoomMaxScroll = grid.maxScroll
  context.save()
  roundedPath(gridViewport.x, gridViewport.y, gridViewport.width, gridViewport.height, 8)
  context.clip()
  grid.rects.forEach((slot, index) => {
    if (!rectsIntersect(slot, gridViewport)) return
    if (assets.searchSlot) drawImageSourceInRect(assets.searchSlot, SEARCH_ASSET_CROPS.slot, slot)
    const item = visible[index]
    if (item) {
      const cardRect = fitAspectRect(slot, CARD_ASPECT_RATIO)
      drawCardArt(cardById(item.cardId), cardRect, { radius: 8, inset: 1, stroke: '#ffe09a', lineWidth: 1.5 })
      const visibleRect = intersectionRect(slot, gridViewport)
      if (visibleRect) ui.searchItemRects.push({ ...visibleRect, instanceId: item.instanceId, cardId: item.cardId })
    } else if (assets.searchSlotPattern) {
      drawImageSourceInRect(assets.searchSlotPattern, SEARCH_ASSET_CROPS.slotPattern, { x: slot.x + slot.width * 0.35, y: slot.y + slot.height * 0.32, width: slot.width * 0.3, height: slot.height * 0.36 })
    }
  })
  const targetSlot = rippleIndex === null ? null : grid.rects[rippleIndex]
  if (targetSlot && rectsIntersect(targetSlot, gridViewport)) drawSearchRipple(targetSlot, now)
  context.restore()
  drawScrollIndicator(gridViewport, grid.contentHeight, searchRoomScrollY)
  const emptyResolved = itemCount === 0 && elapsed >= C.SEARCH_REVEAL_INTERVAL_MS
  if (emptyResolved) text('该区域未发现物品', rect.x + rect.width / 2, rect.y + rect.height / 2, Math.max(11, 26 * scale), '#e2c7b2', 'center', 'bold')
}

function drawSearchDrag() {
  if (!searchDragging || !searchDragPoint) return
  drawFloatingCard(cardById(searchDragging.cardId), searchDragPoint)
}

function drawSearch(state) {
  drawRoomArtwork()
  darken(0.67, '12, 5, 24')
  drawTopHud(state)
  const layout = createSearchLayout(viewWidth, viewHeight)
  drawSearchTimer(layout)
  drawSearchInventoryPanel(layout.inventory)
  drawSearchRoomPanel(layout.search)
  if (assets.searchFinishButton) context.drawImage(assets.searchFinishButton, layout.finish.x, layout.finish.y, layout.finish.width, layout.finish.height)
  else panel(layout.finish.x, layout.finish.y, layout.finish.width, layout.finish.height, { fill: '#8b251e', stroke: '#ffe39a', radius: 10 })
  const visitOpen = canActInRoom()
  text(visitOpen ? '完成搜索' : '同步回合中…', layout.finish.x + layout.finish.width / 2, layout.finish.y + layout.finish.height / 2, Math.max(11, 31 * layout.scale), '#fff1c1', 'center', 'bold')
  if (visitOpen) {
    ui.hotspots.push({ id: 'search_finish', rect: layout.finish })
    drawSearchDrag()
  }
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
    text(`已到达${roomTypeAt(local.position.x, local.position.y)}，撤离将消耗 1 个回合`, viewWidth / 2, y + height - 62, 10, '#9ce8c5', 'center', 'bold')
    button('request_extraction', '呼叫白鸽 · 撤离', { x: viewWidth / 2 - 92, y: y + height - 47, width: 184, height: 34 }, { top: '#2d9c71', bottom: '#175842', stroke: '#b5ffe0', size: 12 })
  } else {
    button('next_turn', '进入下一回合', { x: viewWidth / 2 - 82, y: y + height - 50, width: 164, height: 35 }, { size: 12 })
  }
}

function drawSettlement(state) {
  drawCover(assets.loading)
  darken(0.58, '15, 6, 25')
  const settlement = accountSettlement || engine.settlementFor('P1')
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
  text(settlement.success ? '带出物品已存入云端仓库，展示价值不兑换金币。' : '本局携带资产已损失，仓库中未携带资产保留。', viewWidth / 2, y + 203, 10, '#c9bccb', 'center')
  button('settlement_home', '返回码头', { x: x + 48, y: y + height - 54, width: 128, height: 36 }, { top: '#514455', bottom: '#2c2330', stroke: '#a995a9', size: 11 })
  button('settlement_replay', '再来一局', { x: x + width - 176, y: y + height - 54, width: 128, height: 36 }, { top: '#d49635', bottom: '#81351f', stroke: '#ffe095', size: 11 })
}

function drawGame() {
  const state = currentState()
  if (!state) return
  if (state.phase === 'GAME_OVER') presentation = 'SETTLEMENT'
  if (presentation === 'MAP') drawMapScene(state)
  if (presentation === 'BATTLE') drawBattle(state)
  if (presentation === 'ROOM') drawRoom(state)
  if (presentation === 'SEARCH') drawSearch(state)
  if (presentation === 'ROUND_RESULT') drawRoundResult(state)
  if (presentation === 'SETTLEMENT') drawSettlement(state)
  if (accountGame && presentation !== 'SETTLEMENT') {
    button('account_abandon', '放弃对局', { x: 10, y: viewHeight - 30, width: 86, height: 24 }, { size: 9, top: '#46303d', bottom: '#281d2a' })
  }
}

function update() {
  if (accountApi.requiresLogin?.()) {
    if (scene !== 'LOGIN' && !accountBusy) {
      accountProfile = accountGame = accountSettlement = engine = null
      lobbyRoom = searchVisitState = roomTimerAnchor = null
      lobbyRooms = []
      pendingResume = false
      accountRevision = 0
      profileNickname = profileAvatarUrl = ''
      profileAvatarImage = null
      PLAYER_ACCOUNT_GOLD = 0
      accountConnectionError = null
      profileMessage = accountError({ code: 'ACCOUNT_CHANGED' })
      setScene('LOGIN')
    }
    return
  }
  if (accountGame && scene === 'GAME') {
    const deadline = engine.phase === 'MOVE_SELECTION' ? engine.moveDeadlineAt : engine.turnDeadlineAt
    const nearDeadline = Number.isFinite(deadline) && deadline - Date.now() < 1200
    const interval = presentation === 'SEARCH' || nearDeadline ? 1000 : accountGame.mode === 'MULTIPLAYER' ? 2000 : 5000
    if (Date.now() - accountLastHeartbeat > interval) {
      accountLastHeartbeat = Date.now()
      heartbeatAccount()
    }
  }
  if (scene === 'LOBBY' && Date.now() - lobbyLastRefresh >= 2000) refreshLobby()
}

function draw() {
  ui.hotspots = []
  ui.inventoryRects = []
  ui.searchItemRects = []
  ui.searchInventoryRects = []
  ui.searchBackpackRect = null
  ui.searchRoomRect = null
  ui.searchRoomScrollRect = null
  ui.searchRoomMaxScroll = 0
  ui.roomAreaRects = []
  ui.loadoutWarehouseRects = []
  ui.loadoutBackpackRects = []
  ui.loadoutWarehouseDropRect = null
  ui.loadoutBackpackDropRect = null
  ui.loadoutWarehouseScrollRect = null
  ui.loadoutWarehouseMaxScroll = 0
  ui.warehouseScrollRect = null
  ui.warehouseMaxScroll = 0
  ui.discardRect = null
  if (scene === 'LOADING') drawLoading()
  if (scene === 'LOGIN' || scene === 'PROFILE') drawAccountSetup()
  if (scene === 'HOME') drawHome()
  if (scene === 'WAREHOUSE') drawWarehouse()
  if (scene === 'LOADOUT') drawLoadout()
  if (scene === 'LOBBY') drawLobby()
  if (scene === 'GAME') drawGame()
  drawToast()
  drawPendingRequest()
}

function drawPendingRequest() {
  if (!accountBusy || Date.now() - accountBusySince < 180) return
  const width = Math.min(240, viewWidth - 40), x = (viewWidth - width) / 2, y = viewHeight - 78
  panel(x, y, width, 26, { fill: 'rgba(24,15,29,.88)', stroke: 'rgba(247,201,92,.4)', radius: 13 })
  const dots = '.'.repeat(1 + Math.floor(Date.now() / 350) % 3)
  text(`${accountBusyLabel}${dots}`, viewWidth / 2, y + 13, 10, '#ead8b3', 'center')
}

function drawTapFeedback(samples) {
  context.save()
  context.lineWidth = 2.1
  context.strokeStyle = '#ffe5a0'
  for (const tap of samples) {
    context.globalAlpha = tap.alpha
    context.beginPath()
    context.arc(tap.x, tap.y, tap.radius, 0, Math.PI * 2)
    context.stroke()
    context.globalAlpha = tap.alpha * 0.5
    context.fillStyle = '#fff1c6'
    context.beginPath()
    context.arc(tap.x, tap.y, 1.8, 0, Math.PI * 2)
    context.fill()
  }
  context.restore()
}

function renderVisualKey(now) {
  let tick = ''
  if (scene === 'GAME' && presentation !== 'SETTLEMENT') {
    const animated = presentation === 'SEARCH' || movementPinTransition || searchDragging
    tick = Math.floor(now / (animated ? 1000 / 30 : presentation === 'ROOM' ? 100 : 1000))
  } else if (scene === 'LOBBY' && lobbyRoom) tick = Math.floor(now / 1000)
  const pending = accountBusy ? Math.floor(now / 180) : ''
  const toastVisible = !!toast && now < toastUntil
  const retry = Object.values(cardImages).some(record => record.failed && record.attempts < 3) ? Math.floor(now / 1000) : ''
  return `${scene}:${presentation}:${tick}:${pending}:${toastVisible}:${retry}`
}

function renderFrame(now) {
  const samples = tapFeedback.sample(now)
  const frame = frameScheduler.frame(now, renderVisualKey(now), samples.length > 0)
  if (!frame) return
  if (frame.sceneChanged || !cachedFrameReady || !frameCacheContext) {
    draw()
    if (frameCacheContext) {
      try {
        frameCacheContext.clearRect(0, 0, canvas.width, canvas.height)
        frameCacheContext.drawImage(canvas, 0, 0)
        cachedFrameReady = true
      } catch (_) { frameCacheContext = null; frameCache = null }
    }
  } else {
    try { context.drawImage(frameCache, 0, 0, viewWidth, viewHeight) }
    catch (_) { frameCache = null; frameCacheContext = null; cachedFrameReady = false; draw() }
  }
  drawTapFeedback(samples)
}

function pointInRect(point, rect) {
  return rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

function touchPoint(event, changed = true) {
  const list = changed ? event.changedTouches : event.touches
  const touch = list && list[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : { x: 0, y: 0 }
}

async function nextTurn() {
  await accountAction('leave')
}

async function openSearchObservation(areaId) {
  if (await accountAction('observe', { areaId }) && searchVisitState?.visit.observation?.active) {
    searchRoomScrollY = 0
    searchRippleSlotIndex = null
    presentation = 'SEARCH'
  }
}

async function finishSearchOverlay() {
  if (await accountAction('finish-observation') && searchVisitState) presentation = 'ROOM'
}

async function leaveCurrentRoom() {
  await accountAction('leave')
}

async function pickupDraggedSearchItem(instanceId) {
  if (await accountAction('pickup', { instanceId })) addToast('物资已收入背包。')
}

async function dropDraggedInventoryItem(instanceId) {
  if (await accountAction('drop', { instanceId })) addToast('已丢弃 1 张卡牌，留在当前区域。')
}

function handleAction(action) {
  if (!action) return
  if (action.id === 'account_diagnostics') { showConnectionDiagnostics(); return }
  if (action.id === 'account_retry') { connectAccount(); return }
  if (action.id === 'profile_name') { inputNickname(); return }
  if (action.id === 'profile_save') { saveProfile(); return }
  if (action.id === 'account_abandon') {
    const gameId = accountGame?.gameId
    if (gameId) wx.showModal({ title: '放弃本局？', content: '本局带入及搜到的物品将全部损失，仓库中未携带的资产不受影响。',
      success(result) { if (result.confirm && accountGame?.gameId === gameId) accountAction('abandon') } })
    return
  }
  if (accountBusy) { addToast('上一操作处理中，请稍候。', 900); return }
  if (action.id === 'home_start') enterLoadout()
  if (action.id === 'home_shop') addToast('商店暂未开放。')
  if (action.id === 'home_warehouse') enterWarehouse()
  if (action.id === 'warehouse_home') setScene('HOME')
  if (action.id === 'warehouse_filter_all') {
    warehouseFilter = 'ALL'
    warehouseScrollY = 0
  }
  if (action.id === 'warehouse_filter_weapon') {
    warehouseFilter = 'WEAPON'
    warehouseScrollY = 0
  }
  if (action.id === 'warehouse_filter_armor') {
    warehouseFilter = 'ARMOR'
    warehouseScrollY = 0
  }
  if (action.id === 'warehouse_filter_skill') {
    warehouseFilter = 'SKILL'
    warehouseScrollY = 0
  }
  if (action.id === 'warehouse_filter_loot') {
    warehouseFilter = 'LOOT'
    warehouseScrollY = 0
  }
  if (action.id === 'warehouse_card') warehousePreviewCardId = action.data
  if (action.id === 'loadout_home') setScene('HOME')
  if (action.id === 'loadout_match') enterLobby()
  if (action.id === 'loadout_warehouse_card') {
    if (loadoutSelection && loadoutSelection.cardId === action.data && loadoutSelection.source === 'WAREHOUSE') addLoadoutCard(action.data)
    else loadoutSelection = { cardId: action.data, source: 'WAREHOUSE' }
  }
  if (action.id === 'loadout_backpack_card') {
    if (loadoutSelection && loadoutSelection.cardId === action.data && loadoutSelection.source === 'BACKPACK') removeLoadoutCard(action.data)
    else loadoutSelection = { cardId: action.data, source: 'BACKPACK' }
  }
  if (action.id === 'lobby_back') setScene('LOADOUT')
  if (action.id === 'lobby_create') lobbyAction('create')
  if (action.id === 'lobby_join') lobbyAction('join', action.data.roomId)
  if (action.id === 'lobby_leave') lobbyAction('leave', lobbyRoom?.roomId)
  if (action.id === 'lobby_start') lobbyAction('start', lobbyRoom?.roomId)
  if (action.id === 'lobby_single') startGame()
  if (action.id === 'lobby_page') lobbyPage += action.data
  if (action.id === 'lobby_toggle_playing') {
    lobbyShowPlaying = !lobbyShowPlaying
    lobbyPage = lobbyShowPlaying ? action.data : 0
  }
  if (action.id === 'map_node' && canSelectMovement(engine)) selectMovementTarget(action.data)
  if (action.id === 'confirm_move' && canSelectMovement(engine)) {
    accountAction('move', { target: selectedMove || engine.getPlayer('P1').position })
  }
  if (action.id === 'battle_continue' && presentation === 'BATTLE') {
    const local = engine.getPlayer('P1')
    if (local.status !== 'ACTIVE') presentation = 'SETTLEMENT'
    else if (canActInRoom()) beginRoomVisit()
  }
  if (action.id === 'room_area' && presentation === 'ROOM' && canActInRoom()) openSearchObservation(action.data)
  if (action.id === 'room_leave' && presentation === 'ROOM' && canActInRoom()) leaveCurrentRoom()
  if (action.id === 'search_finish' && presentation === 'SEARCH' && canActInRoom()) finishSearchOverlay()
  if (action.id === 'next_turn') nextTurn()
  if (action.id === 'request_extraction' && canActInRoom()) {
    accountAction('extract')
  }
  if (action.id === 'settlement_home' || action.id === 'settlement_replay') {
    if (accountSettlement) accountApi.command('acknowledge', { settlementId: accountSettlement.settlementId }).catch(() => {})
    pendingResume = false
    if (action.id === 'settlement_replay') enterLoadout()
    else { engine = null; setScene('HOME') }
  }
}

wx.onTouchStart(event => {
  cancelledSearchTouch = false
  const point = touchPoint(event, false)
  tapFeedback.add(point, Date.now())
  if (scene === 'WAREHOUSE') {
    warehouseGesture = { start: point, last: point, mode: warehousePreviewCardId ? 'PREVIEW' : 'PENDING' }
    return
  }
  if (scene === 'LOADOUT') {
    const warehouseCard = ui.loadoutWarehouseRects.find(rect => pointInRect(point, rect))
    const backpackCard = ui.loadoutBackpackRects.find(rect => pointInRect(point, rect))
    if (warehouseCard || backpackCard || pointInRect(point, ui.loadoutWarehouseScrollRect)) {
      const card = warehouseCard || backpackCard
      loadoutGesture = {
        start: point,
        last: point,
        mode: 'PENDING',
        cardId: card && card.cardId,
        source: warehouseCard ? 'WAREHOUSE' : backpackCard ? 'BACKPACK' : 'WAREHOUSE_SCROLL'
      }
    }
    return
  }
  if (scene === 'GAME' && presentation === 'SEARCH') {
    if (!canActInRoom()) return
    const roomItem = ui.searchItemRects.find(rect => pointInRect(point, rect))
    const inventoryItem = ui.searchInventoryRects.find(rect => pointInRect(point, rect))
    if (roomItem || inventoryItem || pointInRect(point, ui.searchRoomScrollRect)) {
      const item = roomItem || inventoryItem
      searchGesture = {
        start: point,
        last: point,
        mode: 'PENDING',
        instanceId: item && item.instanceId,
        cardId: item && item.cardId,
        source: roomItem ? 'ROOM' : inventoryItem ? 'INVENTORY' : 'ROOM_SCROLL'
      }
    }
    return
  }
  const inventory = ui.inventoryRects.find(rect => pointInRect(point, rect))
  draggingItemId = inventory ? inventory.instanceId : null
})

wx.onTouchMove(event => {
  invalidateFrame()
  const point = touchPoint(event, false)
  if (scene === 'WAREHOUSE' && warehouseGesture && warehouseGesture.mode !== 'PREVIEW') {
    if (warehouseGesture.mode === 'PENDING' && Math.hypot(point.x - warehouseGesture.start.x, point.y - warehouseGesture.start.y) >= 7) warehouseGesture.mode = 'SCROLL'
    if (warehouseGesture.mode === 'SCROLL') {
      warehouseScrollY = clamp(warehouseScrollY + warehouseGesture.last.y - point.y, 0, ui.warehouseMaxScroll)
    }
    warehouseGesture.last = point
    return
  }
  if (scene === 'LOADOUT' && loadoutGesture) {
    if (loadoutGesture.mode === 'PENDING') {
      if (!loadoutGesture.cardId) {
        if (Math.hypot(point.x - loadoutGesture.start.x, point.y - loadoutGesture.start.y) >= 7) loadoutGesture.mode = 'SCROLL'
      } else if (loadoutGesture.source === 'BACKPACK') {
        if (Math.hypot(point.x - loadoutGesture.start.x, point.y - loadoutGesture.start.y) >= 7) loadoutGesture.mode = 'DRAG'
      } else loadoutGesture.mode = classifyCardGesture(loadoutGesture.start, point)
    }
    if (loadoutGesture.mode === 'SCROLL') {
      loadoutScrollY = clamp(loadoutScrollY + loadoutGesture.last.y - point.y, 0, ui.loadoutWarehouseMaxScroll)
    }
    if (loadoutGesture.mode === 'DRAG' && loadoutGesture.cardId) {
      loadoutDragging = { cardId: loadoutGesture.cardId, source: loadoutGesture.source }
      loadoutDragPoint = point
    }
    loadoutGesture.last = point
    return
  }
  if (scene === 'GAME' && presentation === 'SEARCH' && searchGesture) {
    if (searchGesture.mode === 'PENDING') {
      const distance = Math.hypot(point.x - searchGesture.start.x, point.y - searchGesture.start.y)
      if (distance >= 7) {
        if (searchGesture.source === 'ROOM_SCROLL') searchGesture.mode = 'SCROLL'
        else if (searchGesture.source === 'INVENTORY') searchGesture.mode = 'DRAG'
        else searchGesture.mode = classifyCardGesture(searchGesture.start, point)
      }
    }
    if (searchGesture.mode === 'SCROLL') searchRoomScrollY = clamp(searchRoomScrollY + searchGesture.last.y - point.y, 0, ui.searchRoomMaxScroll)
    if (searchGesture.mode === 'DRAG' && searchGesture.instanceId) {
      searchDragging = { instanceId: searchGesture.instanceId, cardId: searchGesture.cardId, source: searchGesture.source }
      searchDragPoint = point
    }
    searchGesture.last = point
    return
  }
})

wx.onTouchEnd(event => {
  invalidateFrame()
  if (cancelledSearchTouch) {
    cancelledSearchTouch = false
    return
  }
  const point = touchPoint(event)
  if (scene === 'WAREHOUSE' && warehousePreviewCardId) {
    warehousePreviewCardId = null
    warehouseGesture = null
    return
  }
  if (scene === 'WAREHOUSE' && warehouseGesture) {
    const scrolled = warehouseGesture.mode === 'SCROLL'
    warehouseGesture = null
    if (scrolled) return
  }
  if (scene === 'LOADOUT' && loadoutGesture && loadoutGesture.mode === 'SCROLL') {
    loadoutGesture = null
    loadoutDragging = null
    loadoutDragPoint = null
    return
  }
  if (scene === 'LOADOUT' && loadoutGesture && loadoutGesture.mode === 'DRAG' && loadoutDragging) {
    let handled = false
    if (loadoutDragging.source === 'WAREHOUSE' && pointInRect(point, ui.loadoutBackpackDropRect)) {
      addLoadoutCard(loadoutDragging.cardId)
      handled = true
    }
    if (loadoutDragging.source === 'BACKPACK' && pointInRect(point, ui.loadoutWarehouseDropRect)) {
      removeLoadoutCard(loadoutDragging.cardId)
      handled = true
    }
    loadoutGesture = null
    loadoutDragging = null
    loadoutDragPoint = null
    if (!handled) addToast('拖到目标区域即可移动卡牌。', 1000)
    return
  }
  if (scene === 'LOADOUT') loadoutGesture = null
  if (scene === 'GAME' && presentation === 'SEARCH' && searchGesture && searchGesture.mode === 'SCROLL') {
    searchGesture = null
    searchDragging = null
    searchDragPoint = null
    return
  }
  if (scene === 'GAME' && presentation === 'SEARCH' && searchGesture && searchGesture.mode !== 'DRAG') searchGesture = null
  if (searchDragging) {
    const dragged = searchDragging
    searchDragging = null
    searchDragPoint = null
    searchGesture = null
    if (presentation !== 'SEARCH' || !canActInRoom()) return
    if (dragged.source === 'ROOM' && pointInRect(point, ui.searchBackpackRect)) {
      pickupDraggedSearchItem(dragged.instanceId)
      return
    }
    if (dragged.source === 'INVENTORY' && pointInRect(point, ui.searchRoomRect)) {
      dropDraggedInventoryItem(dragged.instanceId)
      return
    }
  }
  if (draggingItemId && ui.discardRect && pointInRect(point, ui.discardRect) && engine) {
    dropDraggedInventoryItem(draggingItemId)
    draggingItemId = null
    return
  }
  draggingItemId = null
  const action = ui.hotspots.slice().reverse().find(candidate => pointInRect(point, candidate.rect))
  handleAction(action)
})

// Desktop runtimes may emit mouse events without synthesizing mobile touches.
// Limit this fallback to account forms; their busy/input guards coalesce runtimes
// that emit both. Inventory drags continue to use the existing touch gestures.
if (typeof wx.onMouseUp === 'function') wx.onMouseUp(event => {
  if (event.button === 0) {
    tapFeedback.add({ x: event.x, y: event.y }, Date.now(), 'mouse')
  }
  if (!['LOGIN', 'PROFILE'].includes(scene) || accountBusy || nicknameInput.active || profileConfirmationOpen || event.button !== 0) return
  const point = { x: event.x, y: event.y }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
  const action = ui.hotspots.slice().reverse().find(candidate => pointInRect(point, candidate.rect))
  handleAction(action)
})

function cancelInputGesture() {
  warehouseGesture = null
  loadoutGesture = null
  loadoutDragging = null
  loadoutDragPoint = null
  if (searchGesture) cancelledSearchTouch = true
  searchGesture = null
  searchDragging = null
  searchDragPoint = null
  draggingItemId = null
  invalidateFrame()
}
if (wx.onTouchCancel) wx.onTouchCancel(cancelInputGesture)

function loop() {
  if (!accountBackground) { update(); renderFrame(Date.now()) }
  requestAnimationFrame(loop)
}

if (wx.onHide) wx.onHide(() => {
  accountBackground = true
  tapFeedback.clear()
  cancelInputGesture()
  if (accountGame) accountApi.command('suspend').catch(() => {})
})
if (wx.onShow) wx.onShow(() => {
  accountBackground = false
  invalidateFrame()
  if (accountProfile && accountGame) {
    const gameId = accountGame.gameId
    const stillOnGame = () => !accountBackground && scene === 'GAME' && (accountGame?.gameId || accountSettlement?.gameId) === gameId
    accountApi.command('resume').then(response => {
      if (!stillOnGame()) return
      applyAccountResponse(response)
      resumeAccountGame()
    }).catch(() => { if (stillOnGame()) addToast('恢复失败，正在重试。') })
  } else if (scene === 'LOBBY') refreshLobby()
})

loadAssets()
loadCardCatalog()
loop()
