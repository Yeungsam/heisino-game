const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { run } = require('node:test')
const { parseArgs } = require('node:util')

const root = path.resolve(__dirname, '..')
process.chdir(root)
const indexPath = 'docs/自动化用例索引.md'
const testFiles = fs.readdirSync('tests', { recursive: true })
  .filter(file => file.endsWith('.test.js')).sort().map(file => path.join('tests', file))
const coverageIncludeGlobs = ['client/js/**/*.js', 'functions/**/*.js', 'server/**/*.js']
const coverageExcludeGlobs = ['**/node_modules/**', '**/runtime/**']
const sourceFiles = ['client/js', 'functions', 'server'].flatMap(directory => fs.readdirSync(directory, { recursive: true })
  .filter(file => file.endsWith('.js') && !file.split(path.sep).some(part => part === 'node_modules' || part === 'runtime'))
  .map(file => relative(path.resolve(directory, file)))).sort()

function positiveInteger(value, option) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${option} 必须为正整数`)
  return Number(value)
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function renderIndex(cases) {
  const sections = new Map()
  for (const { file, name } of cases) {
    if (!sections.has(file)) sections.set(file, [])
    sections.get(file).push(name)
  }
  const lines = [
    '# 自动化用例索引', '',
    `共 ${cases.length} 项，由全局回归从实际执行的用例生成。更新时运行 \`npm run test:regression -- --update-cases\`。`,
    '', '功能范围和维护方法见[全局回归测试用例](全局回归测试用例.md)。'
  ]
  for (const [file, names] of sections) {
    const revision = createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)
    lines.push('', `## [${file}](../${file})`, '', `用例版本 ${revision}`, '', ...names.map(name => `- ${name.replace(/\r?\n/g, ' ')}`))
  }
  return lines.join('\n') + '\n'
}

async function runRound(concurrency) {
  const cases = []
  let counts
  let coverage
  for await (const { type, data } of run({ files: testFiles, concurrency, timeout: 30000, coverage: true, coverageIncludeGlobs, coverageExcludeGlobs })) {
    if (type === 'test:summary' && !data.file) counts = data.counts
    if (type === 'test:coverage') {
      coverage = { totals: data.summary.totals, files: data.summary.files.map(file => ({
        file: relative(file.path),
        lines: file.coveredLinePercent,
        branches: file.coveredBranchPercent,
        functions: file.coveredFunctionPercent,
        uncoveredBranchLines: [...new Set(file.branches.filter(branch => branch.count === 0).map(branch => branch.line))].sort((a, b) => a - b)
      })) }
    }
    if ((type === 'test:pass' || type === 'test:fail') && data.details.type === 'test' && data.file && data.line) {
      cases.push({ file: relative(data.file), line: data.line, name: data.name, status: data.skip ? 'skip' : data.todo ? 'todo' : type.slice(5) })
    }
    if (type === 'test:fail') console.error(`${data.name}\n${data.details.error?.stack || data.details.error || ''}`)
  }
  cases.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
  if (!counts || !coverage || !coverage.files.length) throw new Error('回归运行器未收到完整的测试与覆盖率结果')
  const observed = new Set(coverage.files.map(file => file.file))
  coverage.unobservedFiles = sourceFiles.filter(file => !observed.has(file))
  return { counts, coverage, cases }
}

async function main() {
  const { values } = parseArgs({ options: {
    rounds: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
    'report-dir': { type: 'string' },
    'update-cases': { type: 'boolean' }
  } })
  const rounds = positiveInteger(values.rounds, '--rounds')
  const concurrency = positiveInteger(values.concurrency, '--concurrency')
  const reportDir = values['report-dir'] || path.join('coverage', 'regression', new Date().toISOString().replaceAll(':', '-'))
  fs.mkdirSync(reportDir, { recursive: true })
  execFileSync(process.execPath, ['scripts/check-syntax.js'], { stdio: 'inherit' })
  for (let round = 1; round <= rounds; round += 1) {
    const result = await runRound(concurrency)
    fs.writeFileSync(path.join(reportDir, `round-${round}.json`), JSON.stringify({ round, ...result }, null, 2) + '\n')
    const { counts, coverage, cases } = result
    console.log(`第 ${round}/${rounds} 轮通过 ${counts.passed}/${counts.tests}，分支覆盖率 ${coverage.totals.coveredBranchPercent.toFixed(2)}%`)
    if (!counts.tests || counts.passed !== counts.tests || cases.length !== counts.tests) throw new Error('存在失败、跳过、待完成或未编入索引的用例')
    const index = renderIndex(cases)
    if (values['update-cases'] && round === 1) fs.writeFileSync(indexPath, index)
    if (!fs.existsSync(indexPath) || fs.readFileSync(indexPath, 'utf8') !== index) {
      throw new Error('测试用例索引已过期，请运行 npm run test:regression -- --update-cases 并提交索引')
    }
  }
  console.log(`逐轮结果和未覆盖分支位于 ${reportDir}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
