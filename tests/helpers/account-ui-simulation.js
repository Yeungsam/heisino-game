const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { AccountService } = require('../../functions/heisino-account/service')
const { MemoryAccountStore } = require('../../functions/heisino-account/store')
const { createAccountHandler } = require('../../functions/heisino-account/http-handler')
const cards = require('../../client/data/cards')

const mainPath = path.resolve(__dirname, '../../client/js/main.js')
const apiPath = path.resolve(__dirname, '../../client/js/api/account.js')
const mainSource = fs.readFileSync(mainPath, 'utf8')
const apiSource = fs.readFileSync(apiPath, 'utf8')
const mainRequire = createRequire(mainPath)
const apiRequire = createRequire(apiPath)

async function simulation(t, count = 3, { combatVersion } = {}) {
  const clock = { now: 2_000_000 }
  const store = new MemoryAccountStore()
  const service = new AccountService({
    store, now: () => clock.now,
    identity: { exchange: async code => ({ appId: 'account-ui-test', openid: code }), moderate: async () => {} }
  })
  const server = http.createServer(createAccountHandler(service))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const accounts = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const code = `client-${index + 1}`
    const { token, profile } = await service.login(code)
    await service.execute(token, 'profile', { nickname: `测试玩家${index + 1}` })
    return { code, token, id: profile.accountId }
  }))

  async function mount(index, { width = 812, height = 375, blockResponse, loginCode, showModal = args => args.success({ confirm: true }) } = {}) {
    const account = accounts[index]
    const events = {}
    const labels = []
    const requests = []
    const pending = new Set()
    const gradient = { addColorStop() {} }
    const noop = () => {}
    const context = new Proxy({}, { get(target, key) {
      if (key in target) return target[key]
      if (key === 'fillText') return (...args) => labels.push(args)
      if (key === 'measureText') return value => ({ width: String(value).length * 7 })
      if (String(key).startsWith('create')) return () => gradient
      return noop
    } })
    const wx = {
      createCanvas: () => ({ getContext: () => context }),
      getWindowInfo: () => ({ windowWidth: width, windowHeight: height, pixelRatio: 2 }),
      createImage: () => ({ width: 1280, height: 722, set src(_) { queueMicrotask(() => this.onload?.()) } }),
      login: args => queueMicrotask(() => args.success({ code: loginCode ? loginCode() : account.code })),
      showModal,
      onTouchStart: fn => { events.start = fn },
      onTouchMove: fn => { events.move = fn },
      onTouchEnd: fn => { events.end = fn },
      onTouchCancel: fn => { events.cancel = fn },
      onHide: fn => { events.hide = fn },
      onShow: fn => { events.show = fn },
      request(options) {
        const route = new URL(options.url).pathname
        const request = { route, input: options.data }
        requests.push(request)
        const operation = (async () => {
          try {
            const response = await fetch(options.url, { method: options.method, headers: options.header, body: JSON.stringify(options.data) })
            request.status = response.status
            const result = { statusCode: response.status, data: await response.json(), header: Object.fromEntries(response.headers) }
            await blockResponse?.(request, result)
            options.success(result)
          } catch (error) { options.fail({ errMsg: String(error.message) }) }
        })()
        pending.add(operation)
        operation.finally(() => pending.delete(operation))
      }
    }
    const config = { gameApiBaseUrl: origin, cardAssetBaseUrl: origin, cardApiBaseUrl: origin, combatVersion }
    const globals = { wx, console, setTimeout, clearTimeout, requestAnimationFrame: noop,
      Date: class extends Date { static now() { return clock.now } } }
    const api = vm.runInNewContext(apiSource + '\nmodule.exports', { ...globals, module: { exports: {} },
      require: name => name === '../config' ? config : apiRequire(name) }, { filename: apiPath })
    const sandbox = vm.createContext({ ...globals, require(name) {
      if (name === './api/account') return api
      if (name === './api/cards') return { fetchCardCatalog: async () => ({ cards }) }
      if (name === './config') return config
      return mainRequire(name)
    } })
    const run = code => vm.runInContext(code, sandbox, { filename: mainPath })
    run(mainSource)
    const read = code => JSON.parse(run(`JSON.stringify(${code})`))
    const draw = () => { labels.length = 0; run('draw()'); return labels.map(([label]) => label) }
    const hits = id => { draw(); return read('ui.hotspots').filter(hit => hit.id === id) }
    const touch = (event, x, y) => {
      const point = { clientX: x, clientY: y }
      events[event]({ touches: ['end', 'cancel'].includes(event) ? [] : [point], changedTouches: [point] })
    }
    const idle = async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve))
        if (pending.size) await Promise.all([...pending])
        else if (!run('accountBusy || lobbyPollInFlight || heartbeatInFlight')) return
      }
      assert.fail('测试客户端没有完成请求')
    }
    const tap = async (id, predicate = () => true, wait = true) => {
      const hit = hits(id).find(predicate)
      assert.ok(hit, `页面 ${run('scene + "/" + presentation')} 缺少热区 ${id}`)
      const { x, y, width, height } = hit.rect
      touch('start', x + width / 2, y + height / 2)
      touch('end', x + width / 2, y + height / 2)
      if (wait) await idle()
    }
    const app = { run, read, draw, hits, touch, idle, tap, requests, events, api, account }
    await idle()
    return app
  }

  const client = await Promise.all(accounts.map((_, index) => mount(index)))
  return { client, store, service, accounts, mount, tick: ms => { clock.now += ms } }
}

async function dock(app) {
  await app.tap('home_start')
  await transferLoadoutCard(app, 'wp_006')
  await app.tap('loadout_match')
  assert.equal(app.run('scene'), 'LOBBY')
}

async function transferLoadoutCard(app, cardId, source = 'warehouse') {
  await app.tap(`loadout_${source}_card`, hit => hit.data === cardId)
  await app.tap('card_preview_close')
  await app.tap('loadout_transfer')
}

async function heartbeat(app) {
  await app.run('heartbeatAccount()')
  await app.idle()
}

async function move(app, x, y) {
  await app.tap('map_node', hit => hit.data.x === x && hit.data.y === y)
  await app.tap('confirm_move')
}

function center(rect) {
  return [rect.x + rect.width / 2, rect.y + rect.height / 2]
}

module.exports = { simulation, dock, heartbeat, move, center, transferLoadoutCard }
