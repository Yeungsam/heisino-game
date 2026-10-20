function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function normalizeSafeArea(windowInfo) {
  const width = windowInfo.windowWidth
  const height = windowInfo.windowHeight
  const safeArea = windowInfo.safeArea || {}
  const left = clamp(Number(safeArea.left) || 0, 0, width)
  const top = clamp(Number(safeArea.top) || 0, 0, height)
  const rightCandidate = Number.isFinite(Number(safeArea.right))
    ? Number(safeArea.right)
    : left + (Number(safeArea.width) || width)
  const bottomCandidate = Number.isFinite(Number(safeArea.bottom))
    ? Number(safeArea.bottom)
    : top + (Number(safeArea.height) || height)
  const right = clamp(rightCandidate, left, width)
  const bottom = clamp(bottomCandidate, top, height)
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function validMenuRect(rect, width, height) {
  return Boolean(
    rect && Number(rect.width) > 0 && Number(rect.height) > 0 &&
    Number(rect.left) >= 0 && Number(rect.top) >= 0 &&
    Number(rect.right) <= width && Number(rect.bottom) <= height
  )
}

function createSafeLayout(options) {
  const windowInfo = options.windowInfo
  const width = windowInfo.windowWidth
  const height = windowInfo.windowHeight
  const shortSide = Math.min(width, height)
  const bleedRatio = options.bleedRatio || 0.025
  const bleed = clamp(Math.round(shortSide * bleedRatio), 8, 18)
  const safeArea = normalizeSafeArea(windowInfo)
  const menuButtonRect = validMenuRect(options.menuButtonRect, width, height)
    ? { ...options.menuButtonRect }
    : null

  const contentBounds = {
    left: safeArea.left + bleed,
    top: safeArea.top + bleed,
    right: safeArea.right - bleed,
    bottom: safeArea.bottom - bleed
  }
  if (menuButtonRect && menuButtonRect.top < height * 0.3) {
    contentBounds.top = Math.max(contentBounds.top, menuButtonRect.bottom + bleed)
  } else {
    const fallbackSystemTop = clamp(Math.round(height * 0.11), 40, 56)
    contentBounds.top = Math.max(contentBounds.top, safeArea.top + fallbackSystemTop + bleed)
  }

  if (contentBounds.right <= contentBounds.left || contentBounds.bottom <= contentBounds.top) {
    contentBounds.left = bleed
    contentBounds.top = bleed
    contentBounds.right = width - bleed
    contentBounds.bottom = height - bleed
  }

  const contentWidth = contentBounds.right - contentBounds.left
  const contentHeight = contentBounds.bottom - contentBounds.top
  const scale = Math.min(contentWidth / width, contentHeight / height)
  const renderedWidth = width * scale
  const renderedHeight = height * scale
  const offsetX = contentBounds.left + (contentWidth - renderedWidth) / 2
  const offsetY = contentBounds.top + (contentHeight - renderedHeight) / 2

  return {
    width,
    height,
    bleed,
    scale,
    offsetX,
    offsetY,
    renderedWidth,
    renderedHeight,
    safeArea,
    contentBounds,
    menuButtonRect,
    toLogicalPoint(point) {
      return {
        x: (point.x - offsetX) / scale,
        y: (point.y - offsetY) / scale
      }
    },
    toScreenPoint(point) {
      return {
        x: offsetX + point.x * scale,
        y: offsetY + point.y * scale
      }
    }
  }
}

module.exports = { createSafeLayout, normalizeSafeArea }
