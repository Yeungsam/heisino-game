const TAP_DURATION_MS = 500

function createTapFeedback(limit = 8) {
  const taps = []
  let lastTouchAt = -Infinity
  return {
    add(point, now, source = 'touch') {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
      if (source === 'mouse' && now - lastTouchAt < 700) return false
      if (source === 'touch') lastTouchAt = now
      taps.push({ x: point.x, y: point.y, at: now })
      if (taps.length > limit) taps.shift()
      return true
    },
    sample(now) {
      while (taps.length && now - taps[0].at >= TAP_DURATION_MS) taps.shift()
      return taps.map(tap => {
        const progress = Math.max(0, (now - tap.at) / TAP_DURATION_MS)
        return { x: tap.x, y: tap.y, radius: 5 + 16 * (1 - (1 - progress) ** 2), alpha: 0.54 * (1 - progress) ** 2 }
      })
    },
    clear() { taps.length = 0 }
  }
}

function createRenderScheduler(fps = 30) {
  let dirty = true, lastPaint = -Infinity, lastKey, previousEffects = false
  return {
    invalidate() { dirty = true },
    frame(now, key, effects) {
      if (now - lastPaint < 1000 / fps - 0.5) return null
      const sceneChanged = dirty || key !== lastKey
      if (!sceneChanged && !effects && !previousEffects) return null
      dirty = false
      lastPaint = now
      lastKey = key
      previousEffects = effects
      return { sceneChanged }
    }
  }
}

function createMemo(limit = 128) {
  const values = new Map()
  return (key, build) => {
    if (values.has(key)) return values.get(key)
    const value = build()
    if (values.size >= limit) values.delete(values.keys().next().value)
    values.set(key, value)
    return value
  }
}

function createLayerCanvas(wxApi, screen) {
  // The screen was already created. Mini-game wx.createCanvas subsequent calls
  // create offscreen canvases; support this path as well as newer explicit APIs.
  const factories = []
  if (wxApi.createOffscreenCanvas) factories.push(() => wxApi.createOffscreenCanvas({ type: '2d', width: screen.width, height: screen.height }))
  if (wxApi.createCanvas) factories.push(() => wxApi.createCanvas())
  for (const create of factories) {
    try {
      const layer = create()
      if (!layer || layer === screen) continue
      layer.width = screen.width
      layer.height = screen.height
      if (layer.getContext('2d')) return layer
    } catch (_) {}
  }
  return null
}

module.exports = { TAP_DURATION_MS, createTapFeedback, createRenderScheduler, createMemo, createLayerCanvas }
