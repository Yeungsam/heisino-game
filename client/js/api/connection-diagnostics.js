// Only public connection metadata. Never retain request bodies, headers,
// session tokens, login codes, account identifiers or arbitrary SDK text.
const BUILD = 'account-diag-20261103-1'

function networkFailure(result, endpoint) {
  const raw = typeof (result && result.errMsg) === 'string' ? result.errMsg : ''
  let sdkMessage = '未识别的网络错误（详细内容已隐藏）'
  let code = 'NETWORK_ERROR'
  if (/url\s+not\s+in\s+domain\s+list|not\s+in\s+(?:the\s+)?domain\s+list|不在.*合法域名/i.test(raw)) {
    code = 'DOMAIN_NOT_ALLOWED'
    sdkMessage = 'request:fail url not in domain list'
  } else if (/ssl|tls|certificate|证书/i.test(raw)) sdkMessage = 'request:fail TLS/SSL certificate error'
  else if (/timeout|超时/i.test(raw)) sdkMessage = 'request:fail timeout'
  else if (/domain/i.test(raw)) sdkMessage = 'request:fail domain error（非白名单错误或尚未识别）'
  return { code, diagnostic: { sdkMessage, endpoint,
    errCode: typeof (result && result.errCode) === 'number' && Number.isFinite(result.errCode) ? result.errCode : null } }
}

function formatDiagnostics(error, wxApi, endpoint) {
  let appId = '不可读取', version = '不可读取'
  try {
    const info = wxApi.getAccountInfoSync().miniProgram
    if (/^wx[a-f0-9]{16}$/.test(info.appId)) appId = info.appId
    if (['develop', 'trial', 'release'].includes(info.envVersion)) version = info.envVersion
  } catch (_) {}
  const diagnostic = error && error.diagnostic || {}
  // SDK data is never interpolated wholesale; values below are constrained.
  const code = error && ['DOMAIN_NOT_ALLOWED', 'NETWORK_ERROR', 'LOGIN_FAILED', 'ACCOUNT_UNAVAILABLE'].includes(error.code) ? error.code : 'OTHER_ERROR'
  return [`构建：${BUILD}`, `AppID：${appId}`, `版本：${version}`, `请求：${endpoint}/api/account/login`,
    `错误：${code}`, `SDK：${diagnostic.sdkMessage || '无网络失败详情'}`,
    `SDK码：${typeof diagnostic.errCode === 'number' ? diagnostic.errCode : '无'}`].join('\n')
}

module.exports = { networkFailure, formatDiagnostics }
