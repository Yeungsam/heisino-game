// Deployment helper: transfer existing environment credentials without printing
// them or writing them into the repository. The private config is removed even
// when deployment fails. Never add real values to this source file.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const base = JSON.parse(fs.readFileSync(path.join(root, 'cloudbaserc.json'), 'utf8'))
let secretValues = []
let privateDirectory
let privateConfig

function redact(value) {
  let output = String(value)
  for (const secret of secretValues) if (secret) output = output.split(secret).join('[REDACTED]')
  return output
}
function cli(args) {
  try {
    const output = execFileSync('tcb', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    // CLI 3.8 emits a human-readable route URL after its JSON result.
    return JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1))
  } catch (error) {
    throw new Error(redact(error.stdout || error.stderr || `CloudBase command failed (exit ${error.status})`))
  }
}
function environment(name) {
  const detail = cli(['fn', 'detail', name, '--json', '-e', base.envId])
  const variables = detail.data && detail.data.Environment && detail.data.Environment.Variables || []
  return Object.fromEntries(variables.map(variable => [variable.Key, variable.Value]))
}

try {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-account-runtime.js')], { stdio: 'inherit' })
  const listed = cli(['fn', 'list', '--json', '-e', base.envId])
  const exists = listed.data.Functions.some(item => item.FunctionName === 'heisino-account')
  const sourceEnvironment = environment('heisino-game')
  secretValues = Object.entries(sourceEnvironment).filter(([key]) => /KEY|SECRET|TOKEN/i.test(key)).map(([, value]) => value)
  const currentEnvironment = exists ? environment('heisino-account') : {}
  secretValues.push(...Object.entries(currentEnvironment).filter(([key]) => /KEY|SECRET|TOKEN/i.test(key)).map(([, value]) => value))
  const envVariables = { ...currentEnvironment, WX_APPID: 'wxac0dd152fc261ffd', CLOUDBASE_ENV_ID: base.envId }
  if (!envVariables.CLOUDBASE_APIKEY) envVariables.CLOUDBASE_APIKEY = sourceEnvironment.CLOUDBASE_APIKEY
  if (!envVariables.CLOUDBASE_APIKEY) throw new Error('Existing environment database credential is unavailable; no configuration was changed.')
  privateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'heisino-account-deploy-'))
  fs.chmodSync(privateDirectory, 0o700)
  privateConfig = path.join(privateDirectory, 'cloudbaserc.json')
  fs.writeFileSync(privateConfig, JSON.stringify({
    envId: base.envId, functionRoot: path.join(root, 'functions'),
    functions: [{ ...base.functions.find(fn => fn.name === 'heisino-account'), envVariables }]
  }), { mode: 0o600 })
  console.log(JSON.stringify({ deploying: 'heisino-account', environment: base.envId, environmentKeys: Object.keys(envVariables), hasWechatSecret: Boolean(envVariables.WX_APPSECRET) }))
  const result = cli(['fn', 'deploy', 'heisino-account', '--config-file', privateConfig, '--httpFn', '--path', '/api/account', '--runtime', 'Nodejs20.19', '--install-dependency', 'true', '--force', '--json'])
  console.log(redact(JSON.stringify(result, null, 2)))
} catch (error) {
  console.error(redact(error.message))
  process.exitCode = 1
} finally {
  if (privateConfig && fs.existsSync(privateConfig)) fs.unlinkSync(privateConfig)
  if (privateDirectory) fs.rmdirSync(privateDirectory)
}
