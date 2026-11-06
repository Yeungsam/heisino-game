const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { AccountService } = require('../functions/heisino-account/service')
const { MemoryAccountStore } = require('../functions/heisino-account/store')
const cards = require('../client/data/cards')

test('Canvas 端拒绝资料授权后可手动建号，战备开局和恢复只使用账号服务', async () => {
  const service = new AccountService({ store: new MemoryAccountStore(), identity: {
    exchange: async () => ({ appId: 'wx-client-test', openid: 'client' }), moderate: async () => true
  } })
  let token
  let authorizeTap
  let keyboardConfirm
  let touchEnd
  const commands = []
  const api = {
    async login() { const result = await service.login('test-code'); token = result.token; return result },
    async command(action, data = {}) { commands.push(action); return service.execute(token, action, { ...data, requestId: `client-${Date.now()}-${Math.random().toString(36).slice(2)}` }) }
  }
  const gradient = { addColorStop() {} }
  const context = new Proxy({}, { get(target, key) {
    if (key in target) return target[key]
    if (key === 'measureText') return value => ({ width: String(value).length * 7 })
    if (String(key).startsWith('create')) return () => gradient
    return () => {}
  } })
  const wx = {
    createCanvas: () => ({ getContext: () => context }),
    getWindowInfo: () => ({ windowWidth: 812, windowHeight: 375, pixelRatio: 1 }),
    createImage: () => ({ width: 1920, height: 1080, set src(_) { queueMicrotask(() => { if (this.onload) this.onload() }) } }),
    createUserInfoButton: () => ({ onTap(handler) { authorizeTap = handler }, destroy() {} }),
    onTouchStart() {}, onTouchMove() {}, onTouchEnd(handler) { touchEnd = handler }, onHide() {}, onShow() {},
    onKeyboardConfirm(handler) { keyboardConfirm = handler }, offKeyboardConfirm() {}, showKeyboard() {}, hideKeyboard() {}
  }
  const main = path.join(__dirname, '../client/js/main.js')
  const realRequire = createRequire(main)
  const sandbox = vm.createContext({ wx, console, setTimeout, clearTimeout, requestAnimationFrame() {}, require(name) {
    if (name === './api/account') return api
    if (name === './api/cards') return { fetchCardCatalog: async () => ({ cards }) }
    if (name === './api/search') return {}
    return realRequire(name)
  } })
  vm.runInContext(fs.readFileSync(main, 'utf8'), sandbox, { filename: main })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(vm.runInContext('scene', sandbox), 'PROFILE')
  vm.runInContext('nicknameInput.close(); draw()', sandbox)
  authorizeTap({ errMsg: 'getUserInfo:fail auth deny' })
  const nicknameRect = vm.runInContext('ui.hotspots.find(item => item.id === "profile_name").rect', sandbox)
  touchEnd({ changedTouches: [{ clientX: nicknameRect.x + 10, clientY: nicknameRect.y + 10 }] })
  assert.equal(typeof keyboardConfirm, 'function', 'Actual nickname button touch must open the input')
  keyboardConfirm({ value: '手动昵称' })
  await vm.runInContext('saveProfile()', sandbox)
  assert.equal(vm.runInContext('scene', sandbox), 'HOME')
  assert.equal(vm.runInContext('accountProfile.nickname', sandbox), '手动昵称')
  assert.equal(vm.runInContext('accountProfile.avatarUrl', sandbox), '')
  vm.runInContext('enterLoadout(); loadout.add("wp_006"); loadout.add("ar_001"); draw()', sandbox)
  await vm.runInContext('startGame()', sandbox)
  assert.equal(vm.runInContext('scene', sandbox), 'GAME')
  assert.equal(vm.runInContext('searchAuthority', sandbox), 'ACCOUNT')
  await vm.runInContext('accountAction("move", { target: { x: 0, y: 0 } })', sandbox)
  await new Promise(resolve => setImmediate(resolve))
  vm.runInContext('draw()', sandbox)
  assert.equal(vm.runInContext('presentation', sandbox), 'ROOM')
  await vm.runInContext('accountAction("abandon")', sandbox)
  vm.runInContext('draw()', sandbox)
  assert.equal(vm.runInContext('presentation', sandbox), 'SETTLEMENT')
  assert.equal(vm.runInContext('accountProfile.quantities.wp_006', sandbox), 0)
  assert.equal(vm.runInContext('accountProfile.quantities.sk_001', sandbox), 1)
  assert.deepEqual(commands, ['profile', 'start', 'game', 'game'])
})

test('建号页触控与仅鼠标环境均可输入昵称，重复事件不重叠弹窗或跳过审核', async () => {
  let touchEnd, mouseUp, modal, modalCount = 0
  const calls = []
  const profile = { profileComplete: false, quantities: { wp_006: 1, ar_001: 1, sk_001: 1 }, gold: 0, avatarUrl: '' }
  const gradient = { addColorStop() {} }
  const context = new Proxy({}, { get(_, key) {
    if (key === 'measureText') return value => ({ width: String(value).length * 7 })
    if (String(key).startsWith('create')) return () => gradient
    return () => {}
  } })
  const wx = {
    createCanvas: () => ({ getContext: () => context }),
    getWindowInfo: () => ({ windowWidth: 812, windowHeight: 375, pixelRatio: 3 }),
    createImage: () => ({ set src(_) { queueMicrotask(() => { if (this.onload) this.onload() }) } }),
    canIUse: () => true, showModal(options) { modal = options; modalCount += 1 },
    onMouseUp(handler) { mouseUp = handler },
    onTouchStart() {}, onTouchMove() {}, onTouchEnd(handler) { touchEnd = handler }, onHide() {}, onShow() {}
  }
  const main = path.join(__dirname, '../client/js/main.js'), realRequire = createRequire(main)
  const sandbox = vm.createContext({ wx, console, setTimeout, clearTimeout, requestAnimationFrame() {}, require(name) {
    if (name === './api/account') return {
      login: async () => ({ profile, activeGame: null }),
      command: async (action, data) => { calls.push({ action, data }); return { profile: { ...profile, profileComplete: true, nickname: data.nickname }, activeGame: null } }
    }
    if (name === './api/cards') return { fetchCardCatalog: async () => ({ cards }) }
    return realRequire(name)
  } })
  vm.runInContext(fs.readFileSync(main, 'utf8'), sandbox, { filename: main })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(modal.editable, true, 'First account setup opens a real editable input automatically')
  function tap(id, mouse = false) {
    vm.runInContext('draw()', sandbox)
    const rect = vm.runInContext(`ui.hotspots.find(item => item.id === "${id}").rect`, sandbox)
    if (mouse) mouseUp({ button: 0, x: rect.x + 10, y: rect.y + 10 })
    else touchEnd({ changedTouches: [{ clientX: rect.x + 10, clientY: rect.y + 10 }] })
  }
  tap('profile_name', true)
  tap('profile_name')
  assert.equal(modal.editable, true)
  assert.equal(modalCount, 1)
  tap('profile_save', true)
  assert.equal(calls.length, 0, 'Cannot submit while native input is open')
  modal.success({ confirm: true, content: '旺旺仙草' })
  assert.equal(vm.runInContext('profileNickname', sandbox), '旺旺仙草')
  assert.equal(calls.length, 0, 'Input confirmation does not bypass the explicit save/review')
  assert.equal(modal.title, '确认游戏身份')
  assert.match(modal.content, /旺旺仙草/)
  tap('profile_save')
  assert.equal(calls.length, 0, 'Cannot submit behind a pending identity confirmation')
  modal.success({ confirm: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'profile')
  assert.equal(calls[0].data.nickname, '旺旺仙草')
  assert.equal(vm.runInContext('scene', sandbox), 'HOME')
})

test('手机域名错误主动显示原生脱敏诊断，并可再次通过触控查看', async () => {
  let touchEnd, modal, modalCount = 0
  const gradient = { addColorStop() {} }
  const context = new Proxy({}, { get(_, key) {
    if (key === 'measureText') return value => ({ width: String(value).length * 7 })
    if (String(key).startsWith('create')) return () => gradient
    return () => {}
  } })
  const wx = {
    createCanvas: () => ({ getContext: () => context }),
    getWindowInfo: () => ({ windowWidth: 812, windowHeight: 375, pixelRatio: 3 }),
    createImage: () => ({ set src(_) { queueMicrotask(() => { if (this.onload) this.onload() }) } }),
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wxac0dd152fc261ffd', envVersion: 'develop' } }),
    showModal(options) { modal = options; modalCount += 1 },
    onTouchStart() {}, onTouchMove() {}, onTouchEnd(handler) { touchEnd = handler }, onHide() {}, onShow() {}
  }
  const main = path.join(__dirname, '../client/js/main.js'), realRequire = createRequire(main)
  const sandbox = vm.createContext({ wx, console, setTimeout, clearTimeout, requestAnimationFrame() {}, require(name) {
    if (name === './api/account') return { async login() { throw Object.assign(new Error('DOMAIN_NOT_ALLOWED'), {
      code: 'DOMAIN_NOT_ALLOWED', diagnostic: { sdkMessage: 'request:fail url not in domain list', errCode: 600001 }
    }) } }
    if (name === './api/cards') return { fetchCardCatalog: async () => ({ cards }) }
    return realRequire(name)
  } })
  vm.runInContext(fs.readFileSync(main, 'utf8'), sandbox, { filename: main })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(vm.runInContext('scene', sandbox), 'LOGIN')
  assert.equal(modal.title, '账号连接诊断')
  assert.match(modal.content, /wxac0dd152fc261ffd/)
  assert.match(modal.content, /account-diag-20261103-1/)
  assert.match(modal.content, /request:fail url not in domain list/)
  assert.doesNotMatch(modal.content, /Bearer|session_key|openid|AppSecret/)
  vm.runInContext('showConnectionDiagnostics()', sandbox)
  assert.equal(modalCount, 1, 'Do not stack native diagnostic dialogs')
  modal.complete()
  vm.runInContext('draw()', sandbox)
  const rect = vm.runInContext('ui.hotspots.find(item => item.id === "account_diagnostics").rect', sandbox)
  touchEnd({ changedTouches: [{ clientX: rect.x + 10, clientY: rect.y + 10 }] })
  assert.equal(modalCount, 2)
})
