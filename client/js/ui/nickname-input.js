// Native editable dialogs work in both DevTools and current WeChat clients.
// Older runtimes retain the game keyboard path, including dismiss/complete.
function createNicknameInput(wx, callbacks = {}) {
  let active = false
  let generation = 0
  let mode = null
  let draft = ''
  let removeListeners = () => {}
  const visibility = value => { if (callbacks.onVisibility) callbacks.onVisibility(value) }

  function finish(value, failed = false) {
    if (!active) return
    const keyboard = mode === 'keyboard'
    active = false
    generation += 1
    removeListeners()
    removeListeners = () => {}
    mode = null
    if (keyboard && typeof wx.hideKeyboard === 'function') {
      try { wx.hideKeyboard({}) } catch (_) {}
    }
    visibility(false)
    if (typeof value === 'string' && callbacks.onValue) callbacks.onValue(value)
    if (failed && callbacks.onError) callbacks.onError('昵称输入框暂时无法打开，请重新编译或在微信中重试。')
  }

  function keyboard(id) {
    if (!active || generation !== id || mode === 'keyboard') return
    mode = 'keyboard'
    if (typeof wx.showKeyboard !== 'function' || typeof wx.onKeyboardConfirm !== 'function') {
      finish(undefined, true)
      return
    }
    const current = () => active && generation === id
    const read = result => {
      if (current() && result && typeof result.value === 'string') draft = result.value
    }
    const confirm = result => { if (current()) { read(result); finish(draft) } }
    const complete = result => { if (current()) { read(result); finish(draft) } }
    const listeners = [['KeyboardConfirm', confirm], ['KeyboardInput', read], ['KeyboardComplete', complete]]
    removeListeners = () => listeners.forEach(([name, handler]) => {
      if (typeof wx[`off${name}`] === 'function') wx[`off${name}`](handler)
    })
    try {
      listeners.forEach(([name, handler]) => {
        if (typeof wx[`on${name}`] === 'function') wx[`on${name}`](handler)
      })
      wx.showKeyboard({ defaultValue: draft, keyboardType: 'text', maxLength: 16, multiple: false,
        confirmHold: false, confirmType: 'done', fail() { if (current()) finish(undefined, true) } })
    } catch (_) { if (current()) finish(undefined, true) }
  }

  function open(value = '') {
    if (active) return
    active = true
    const id = ++generation
    draft = typeof value === 'string' ? value : ''
    visibility(true)
    let editable = typeof wx.showModal === 'function'
    try { if (typeof wx.canIUse === 'function' && !wx.canIUse('showModal.object.editable')) editable = false } catch (_) {}
    if (!editable) { keyboard(id); return }
    mode = 'modal'
    try {
      wx.showModal({ title: '输入游戏昵称', editable: true, content: draft,
        placeholderText: '2–16 个汉字、字母、数字或下划线', confirmText: '使用昵称', cancelText: '取消',
        success(result) {
          if (!active || generation !== id || mode !== 'modal') return
          if (!result.confirm) { finish(); return }
          if (typeof result.content === 'string') finish(result.content)
          else keyboard(id)
        },
        fail() { if (active && generation === id && mode === 'modal') keyboard(id) }
      })
    } catch (_) { keyboard(id) }
  }

  return { open, close() { finish() }, get active() { return active } }
}

module.exports = { createNicknameInput }
