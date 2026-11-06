const test = require('node:test')
const assert = require('node:assert/strict')
const { createNicknameInput } = require('../client/js/ui/nickname-input')

function fixture(overrides = {}) {
  const values = [], errors = [], visibility = [], modals = [], keyboards = []
  const listeners = {}, removed = []
  let hidden = 0
  const wx = {
    canIUse: () => true,
    showModal(options) { modals.push(options) },
    showKeyboard(options) { keyboards.push(options) },
    hideKeyboard() { hidden += 1 },
    ...Object.fromEntries(['KeyboardConfirm', 'KeyboardInput', 'KeyboardComplete'].flatMap(name => [
      [`on${name}`, handler => { listeners[name] = handler }],
      [`off${name}`, handler => { removed.push([name, handler]); if (listeners[name] === handler) delete listeners[name] }]
    ])), ...overrides
  }
  const input = createNicknameInput(wx, { onValue: value => values.push(value), onError: value => errors.push(value), onVisibility: value => visibility.push(value) })
  return { input, values, errors, visibility, modals, keyboards, listeners, removed, hidden: () => hidden }
}

test('昵称优先使用原生可编辑弹窗，明确预填并仅在确认后更新', () => {
  const f = fixture()
  f.input.open('原来昵称')
  assert.equal(f.modals[0].editable, true)
  assert.equal(f.modals[0].content, '原来昵称')
  assert.match(f.modals[0].placeholderText, /2–16/)
  assert.equal(f.input.active, true)
  f.modals[0].success({ confirm: true, content: '旺旺仙草' })
  assert.deepEqual(f.values, ['旺旺仙草'])
  assert.deepEqual(f.visibility, [true, false])
  assert.equal(f.input.active, false)
  assert.equal(f.keyboards.length, 0)
})

test('取消昵称输入不清空原值；重复点击不重叠弹窗', () => {
  const f = fixture()
  f.input.open('原来昵称')
  f.input.open('不能覆盖')
  assert.equal(f.modals.length, 1)
  f.modals[0].success({ confirm: false, cancel: true, content: '未确认' })
  assert.deepEqual(f.values, [])
  assert.equal(f.input.active, false)
})

test('旧环境和原生弹窗失败时使用带完整参数的小游戏键盘', () => {
  for (const overrides of [{ canIUse: () => false }, { showModal: undefined }, { showModal(options) { options.fail() } }, { showModal() { throw new Error('unsupported') } }]) {
    const f = fixture(overrides)
    f.input.open('默认昵称')
    assert.equal(f.keyboards.length, 1)
    assert.equal(f.keyboards[0].defaultValue, '默认昵称')
    assert.equal(f.keyboards[0].keyboardType, 'text')
    assert.equal(f.keyboards[0].maxLength, 16)
    f.listeners.KeyboardConfirm({ value: '新昵称' })
    assert.deepEqual(f.values, ['新昵称'])
    assert.equal(f.removed.length, 3)
    assert.ok(f.removed.every(([, handler]) => typeof handler === 'function'))
    assert.equal(f.hidden(), 1)
  }
})

test('键盘收起而没有确认事件也保存本次输入，回调不重复执行', () => {
  const f = fixture({ canIUse: () => false })
  f.input.open('旧昵称')
  const confirm = f.listeners.KeyboardConfirm, complete = f.listeners.KeyboardComplete
  f.listeners.KeyboardInput({ value: '旺旺仙草' })
  complete({})
  confirm({ value: '迟到的回调' })
  assert.deepEqual(f.values, ['旺旺仙草'])
  assert.equal(f.input.active, false)
})

test('旧环境弹窗未返回可编辑内容时不能把未输入误认为成功', () => {
  const f = fixture()
  f.input.open()
  f.modals[0].success({ confirm: true })
  assert.equal(f.keyboards.length, 1)
  assert.deepEqual(f.values, [])
})

test('输入接口缺失或失败必须显示错误，且允许下一次重试', () => {
  for (const overrides of [{ showModal: undefined, showKeyboard: undefined },
    { showModal: undefined, onKeyboardConfirm: undefined },
    { showModal: undefined, showKeyboard(options) { options.fail() } },
    { showModal: undefined, showKeyboard() { throw new Error('unsupported') } }]) {
    const f = fixture(overrides)
    f.input.open()
    assert.equal(f.errors.length, 1)
    assert.equal(f.input.active, false)
    f.input.open()
    assert.equal(f.errors.length, 2)
  }
})

test('切换页面后的迟到输入回调不能覆盖资料或重新打开键盘', () => {
  const f = fixture()
  f.input.open()
  const modal = f.modals[0]
  f.input.close()
  modal.success({ confirm: true, content: '迟到昵称' })
  modal.fail()
  assert.deepEqual(f.values, [])
  assert.equal(f.keyboards.length, 0)
  assert.deepEqual(f.visibility, [true, false])
})

test('输入框不私自截断或替换非法昵称，交由服务端统一校验', () => {
  const f = fixture()
  f.input.open()
  f.modals[0].success({ confirm: true, content: '<非法昵称>' })
  assert.deepEqual(f.values, ['<非法昵称>'])
})
