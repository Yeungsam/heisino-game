const crypto = require('node:crypto')

function fault(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode })
}

function validateNickname(value) {
  if (typeof value !== 'string') throw fault('NICKNAME_INVALID')
  const nickname = value.normalize('NFKC').trim()
  if (!/^[\p{Script=Han}a-zA-Z0-9_]{2,16}$/u.test(nickname)) throw fault('NICKNAME_INVALID')
  if (/^(官方|管理员|系统|客服|GM$)/i.test(nickname)) throw fault('NICKNAME_RESERVED')
  return nickname
}

function validateAvatar(value) {
  if (!value) return ''
  let url
  try { url = new URL(value) } catch (_) { throw fault('AVATAR_INVALID') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['wx.qlogo.cn', 'thirdwx.qlogo.cn', 'mmhead.qpic.cn'].includes(url.hostname) || value.length > 2048) throw fault('AVATAR_INVALID')
  return url.toString()
}

class WechatIdentity {
  constructor(options = {}) {
    this.appId = options.appId || process.env.WX_APPID || 'wxac0dd152fc261ffd'
    this.secret = options.secret || process.env.WX_APPSECRET
    this.fetch = options.fetch || global.fetch
    this.cachedToken = null
  }

  async api(path, body, query = {}) {
    if (!this.secret) throw fault('WECHAT_NOT_CONFIGURED', 503)
    const url = new URL(path, 'https://api.weixin.qq.com')
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value))
    try {
      const response = await this.fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(6000)
      })
      if (!response.ok) throw fault('WECHAT_UNAVAILABLE', 503)
      return await response.json()
    } catch (error) {
      // Do not propagate fetch errors: their URLs can contain credentials.
      throw fault('WECHAT_UNAVAILABLE', 503)
    }
  }

  async exchange(code) {
    if (typeof code !== 'string' || !code || code.length > 512) throw fault('LOGIN_CODE_INVALID')
    const result = await this.api('/sns/jscode2session', null, {
      appid: this.appId, secret: this.secret, js_code: code, grant_type: 'authorization_code'
    })
    if (result.errcode || typeof result.openid !== 'string' || !result.openid) throw fault('LOGIN_CODE_INVALID', 401)
    // session_key, unionid and all other returned data are deliberately discarded.
    return { openid: result.openid, appId: this.appId }
  }

  async accessToken() {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) return this.cachedToken.value
    const result = await this.api('/cgi-bin/stable_token', {
      grant_type: 'client_credential', appid: this.appId, secret: this.secret, force_refresh: false
    })
    if (!result.access_token) throw fault('MODERATION_UNAVAILABLE', 503)
    this.cachedToken = { value: result.access_token, expiresAt: Date.now() + Math.max(0, result.expires_in - 120) * 1000 }
    return result.access_token
  }

  async moderate(nickname, openid) {
    const accessToken = await this.accessToken()
    const result = await this.api('/wxa/msg_sec_check', { version: 2, scene: 1, openid, content: nickname, nickname }, { access_token: accessToken })
    if ([40001, 42001, 40014].includes(result.errcode)) this.cachedToken = null
    if (result.errcode === 87014 || result.result && result.result.suggest !== 'pass') throw fault('NICKNAME_REJECTED')
    if (result.errcode !== 0 || !result.result || result.result.suggest !== 'pass') throw fault('MODERATION_UNAVAILABLE', 503)
    return true
  }
}

function accountIdFor(appId, openid) {
  return crypto.createHash('sha256').update(`${appId}:${openid}`).digest('hex')
}

module.exports = { WechatIdentity, validateNickname, validateAvatar, accountIdFor, fault }
