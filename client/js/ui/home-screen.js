const HOME_SOURCE_SIZE = Object.freeze({ width: 1920, height: 1080 })

const HOME_LAYERS = Object.freeze({
  logo: Object.freeze({ x: 111, y: 45, width: 617, height: 322 }),
  character: Object.freeze({ x: 492, y: 379, width: 337, height: 504 }),
  cat: Object.freeze({ x: 399, y: 742, width: 138, height: 153 }),
  shop: Object.freeze({ x: 540, y: 895, width: 336, height: 107 }),
  warehouse: Object.freeze({ x: 876, y: 894, width: 326, height: 108 }),
  start: Object.freeze({ x: 1219, y: 858, width: 487, height: 154 })
})

const HOME_LABELS = Object.freeze({
  shop: Object.freeze({ x: 748, y: 943.5, size: 40, text: '商店' }),
  warehouse: Object.freeze({ x: 1091, y: 943.5, size: 40, text: '仓库' }),
  start: Object.freeze({ x: 1530, y: 928.5, size: 40, text: '开始游戏' })
})

function createHomeLayout(viewWidth, viewHeight) {
  const scale = Math.min(viewWidth / HOME_SOURCE_SIZE.width, viewHeight / HOME_SOURCE_SIZE.height)
  const offsetX = (viewWidth - HOME_SOURCE_SIZE.width * scale) / 2
  const offsetY = (viewHeight - HOME_SOURCE_SIZE.height * scale) / 2
  const rect = source => ({
    x: offsetX + source.x * scale,
    y: offsetY + source.y * scale,
    width: source.width * scale,
    height: source.height * scale
  })
  const point = source => ({
    x: offsetX + source.x * scale,
    y: offsetY + source.y * scale,
    size: source.size * scale,
    text: source.text
  })
  return {
    scale,
    offsetX,
    offsetY,
    safeRect: {
      x: offsetX,
      y: offsetY,
      width: HOME_SOURCE_SIZE.width * scale,
      height: HOME_SOURCE_SIZE.height * scale
    },
    logo: rect(HOME_LAYERS.logo),
    character: rect(HOME_LAYERS.character),
    cat: rect(HOME_LAYERS.cat),
    buttons: {
      shop: rect(HOME_LAYERS.shop),
      warehouse: rect(HOME_LAYERS.warehouse),
      start: rect(HOME_LAYERS.start)
    },
    labels: {
      shop: point(HOME_LABELS.shop),
      warehouse: point(HOME_LABELS.warehouse),
      start: point(HOME_LABELS.start)
    }
  }
}

module.exports = { HOME_SOURCE_SIZE, HOME_LAYERS, HOME_LABELS, createHomeLayout }
