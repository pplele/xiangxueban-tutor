/**
 * 小程序静态体检（无需开发者工具）：
 * 1. wxml 里 bind/catch 绑定的处理函数在页面 js 中是否定义
 * 2. wxml 里 {{}} 引用的顶层变量是否出现在页面 data 中
 * 3. app.json 里的 pages 是否都存在四件套
 * 4. js 里 wx.navigateTo 指向的页面是否已注册
 * 用法：node scripts/check-miniprogram.mjs [miniprogramRoot]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(
  process.argv[2] || 'apps/miniprogram',
)

let problems = 0
const bad = (msg) => {
  problems++
  console.log('  ✗ ' + msg)
}

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
const pages = appJson.pages || []

// 1 + 3
for (const p of pages) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    const f = path.join(ROOT, p + '.' + ext)
    if (!fs.existsSync(f)) bad(`${p}.${ext} 缺失`)
  }
}
console.log(`· 页面注册 ${pages.length} 个，四件套检查完成`)

const registered = new Set(pages)

for (const p of pages) {
  const wxmlPath = path.join(ROOT, p + '.wxml')
  const jsPath = path.join(ROOT, p + '.js')
  if (!fs.existsSync(wxmlPath) || !fs.existsSync(jsPath)) continue
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const js = fs.readFileSync(jsPath, 'utf8')

  // 处理函数
  const handlers = new Set()
  for (const m of wxml.matchAll(/\b(?:bind|catch)(?::)?[a-zA-Z]+\s*=\s*"([^"{}]+)"/g)) {
    handlers.add(m[1].trim())
  }
  // wxml 方法引用也可能写成 {{}} 表达式，这里只查静态字符串
  for (const h of handlers) {
    const re = new RegExp(`(^|[\\s,{])${h}\\s*(\\(|:)`, 'm')
    if (!re.test(js)) bad(`${p}.wxml 绑定了 ${h}，但 ${p}.js 未定义`)
  }

  // data 顶层键
  const dataBlock = js.match(/data\s*:\s*\{([\s\S]*?)\n\s{2}\}/)
  const dataKeys = new Set()
  if (dataBlock) {
    for (const m of dataBlock[1].matchAll(/^\s{4}([a-zA-Z_$][\w$]*)\s*:/gm)) dataKeys.add(m[1])
  }
  // 循环变量与 item/index 是隐式的
  const loopVars = new Set(['item', 'index', 'true', 'false', 'null'])
  for (const m of wxml.matchAll(/wx:for(?:-item)?\s*=\s*"\{\{\s*([\w$]+)/g)) loopVars.add(m[1])
  for (const m of wxml.matchAll(/wx:for-item\s*=\s*"([\w$]+)"/g)) loopVars.add(m[1])

  const used = new Set()
  for (const m of wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    for (const id of m[1].matchAll(/(?:^|[^.\w$'"])([a-zA-Z_$][\w$]*)/g)) used.add(id[1])
  }
  for (const u of used) {
    if (dataKeys.has(u) || loopVars.has(u)) continue
    // 数字/布尔字面量、比较运算符右值等已由正则过滤不全，这里只报疑似
    if (/^[A-Z_]+$/.test(u)) continue // 常量占位
    bad(`${p}.wxml 引用了 {{${u}}}，但 data 中没有该字段`)
  }

  console.log(`  · ${p}: 事件 ${handlers.size} 个、data ${dataKeys.size} 项、模板变量 ${used.size} 个`)
}

// 4. 跳转目标
for (const p of pages) {
  const jsPath = path.join(ROOT, p + '.js')
  if (!fs.existsSync(jsPath)) continue
  const js = fs.readFileSync(jsPath, 'utf8')
  for (const m of js.matchAll(/navigateTo\(\{\s*url:\s*'([^'?]+)/g)) {
    const target = m[1].replace(/^\//, '')
    if (!registered.has(target)) bad(`${p}.js 跳转到 ${target}，但该页未在 app.json 注册`)
  }
}

console.log(problems === 0 ? '\n✓ 静态体检通过' : `\n✗ 共 ${problems} 处问题`)
process.exit(problems === 0 ? 0 : 1)
