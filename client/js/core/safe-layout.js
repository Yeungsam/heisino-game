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

function createCoverPlacement(options) {
  const zoom = options.zoom || 1
  const focusX = options.focusX === undefined ? 0.5 : options.focusX
  const focusY = options.focusY === undefined ? 0.5 : options.focusY
  const scale = Math.max(options.viewWidth / options.imageWidth, options.viewHeight / options.imageHeight) * zoom
  const width = options.imageWidth * scale
  const height = options.imageHeight * scale
  return {
    x: (options.viewWidth - width) * focusX,
    y: (options.viewHeight - height) * focusY,
    width,
    height,
    scale
  }
}

function createSafeLayout(options) {
  const windowInfo = options.windowInfo
  const width = windowInfo.windowWidth
  const height = windowInfo.windowHeight
  const shortSide = Math.min(width, height)
  const contentPaddingRatio = options.contentPaddingRatio || 0.025
  const contentPadding = clamp(Math.round(shortSide * contentPaddingRatio), 8, 18)
  const safeArea = normalizeSafeArea(windowInfo)
  const menuButtonRect = validMenuRect(options.menuButtonRect, width, height)
    ? { ...options.menuButtonRect }
    : null

  const contentBounds = {
    left: safeArea.left + contentPadding,
    top: safeArea.top + contentPadding,
    right: safeArea.right - contentPadding,
    bottom: safeArea.bottom - contentPadding
  }
  if (menuButtonRect && menuButtonRect.top < height * 0.3) {
    contentBounds.top = Math.max(contentBounds.top, menuButtonRect.bottom + contentPadding)
  } else {
    const fallbackSystemTop = clamp(Math.round(height * 0.11), 40, 56)
    contentBounds.top = Math.max(contentBounds.top, safeArea.top + fallbackSystemTop + contentPadding)
  }

  if (contentBounds.right <= contentBounds.left || contentBounds.bottom <= contentBounds.top) {
    contentBounds.left = contentPadding
    contentBounds.top = contentPadding
    contentBounds.right = width - contentPadding
    contentBounds.bottom = height - contentPadding
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
    contentPadding,
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

module.exports = { createSafeLayout, createCoverPlacement, normalizeSafeArea }
