/**
 * 极简 Markdown → rich-text nodes
 * 只覆盖老师讲解里实际会出现的语法：标题、加粗、行内代码、列表、引用、分隔线、
 * 代码块、$$公式块$$、$行内公式$。不追求完整 CommonMark，够用且不会误伤 LaTeX。
 *
 * 用法：const { toNodes } = require('../../utils/md')
 *      this.setData({ answerNodes: toNodes(markdown) })
 *      <rich-text nodes="{{answerNodes}}" />
 *
 * 注意：rich-text 内部不支持 class 选择器，所有样式必须内联。
 */

const MONO = 'Menlo,Consolas,"Courier New",monospace'
const latex = require('./latex')

// rich-text 是 WebView 渲染，内联样式用 px 才稳（rpx 不一定被转换）
const S = {
  h1: 'font-size:19px;font-weight:600;line-height:1.6;color:#1f2329;margin:14px 0 7px',
  h2: 'font-size:17px;font-weight:600;line-height:1.6;color:#1f2329;margin:13px 0 6px',
  h3: 'font-size:16px;font-weight:600;line-height:1.6;color:#1f2329;margin:11px 0 5px',
  p: 'font-size:15px;line-height:1.85;color:#1f2329;margin:0 0 9px',
  li: 'font-size:15px;line-height:1.85;color:#1f2329;margin:0 0 5px',
  quote:
    'font-size:14px;line-height:1.8;color:#4e5969;border-left:3px solid #c9cdd4;padding-left:10px;margin:0 0 9px',
  codeInline: `font-size:13px;color:#0f4c81;background:#f2f3f5;border-radius:3px;padding:1px 4px;font-family:${MONO}`,
  codeBlock: `font-size:13px;line-height:1.75;color:#1f2329;background:#f2f3f5;border-radius:6px;padding:10px;margin:0 0 9px;font-family:${MONO}`,
  mathBlock: `font-size:14px;line-height:1.7;color:#1f2329;background:#f7f8fa;border-radius:6px;padding:10px;margin:0 0 9px;font-family:${MONO}`,
  mathInline: `font-size:14px;color:#0f4c81;font-family:${MONO}`,
  bold: 'font-weight:600',
  hr: 'height:1px;background:#e5e6eb;margin:14px 0',
  tableRow: `font-size:13px;line-height:1.7;color:#1f2329;font-family:${MONO};margin:0 0 3px`,
}

function div(style, children) {
  return { name: 'div', attrs: { style }, children: children || [] }
}

function txt(text) {
  return { type: 'text', text: String(text) }
}

function span(style, text) {
  return { name: 'span', attrs: { style }, children: [txt(text)] }
}

/** 行内解析：**粗体** / `代码` / $公式$ */
function inline(line, baseStyle) {
  const out = []
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\$\$[^$\n]+\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\))/g
  let last = 0
  let m
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(txt(line.slice(last, m.index)))
    const tok = m[0]
    if (tok.indexOf('**') === 0) {
      // 粗体内部可能还有 $公式$ 或 `代码`，递归解析一次
      out.push({ name: 'span', attrs: { style: S.bold }, children: inline(tok.slice(2, -2)) })
    } else if (tok.charAt(0) === '`') {
      out.push(span(S.codeInline, tok.slice(1, -1)))
    } else {
      // 公式交给 latex.js 转成上下叠放的分式、根号、上下标
      let tex = tok
      if (tex.indexOf('$$') === 0) tex = tex.slice(2, -2)
      else if (tex.indexOf('\\(') === 0) tex = tex.slice(2, -2)
      else tex = tex.slice(1, -1)
      latex.inlineNodes(tex).forEach((n) => out.push(n))
    }
    last = m.index + tok.length
  }
  if (last < line.length) out.push(txt(line.slice(last)))
  if (out.length === 0) out.push(txt(' '))
  return out
}

function isTableRow(t) {
  return t.charAt(0) === '|' && t.indexOf('|', 1) > 0
}

function isTableSep(t) {
  return /^\|?[\s:|-]+\|?$/.test(t) && t.indexOf('-') >= 0
}

function isBlockStart(t) {
  return (
    /^#{1,6}\s+/.test(t) ||
    /^```/.test(t) ||
    /^>\s?/.test(t) ||
    /^[-*+]\s+/.test(t) ||
    /^\d+[.)]\s+/.test(t) ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(t) ||
    /^\u0000B\d+\u0000$/.test(t) ||
    isTableRow(t)
  )
}

/**
 * @param {string} md
 * @param {{fontSize?:number,lineHeight?:number,gap?:number}} [opts]
 *        错题本列表这类窄容器传小一号字（px，rich-text 不认 rpx）
 * @returns {Array} rich-text nodes
 */
function toNodes(md, opts) {
  let src = String(md == null ? '' : md).replace(/\r\n?/g, '\n')
  if (!src.trim()) return []

  const o = opts || {}
  const pStyle = o.fontSize
    ? `font-size:${o.fontSize}px;line-height:${o.lineHeight || 1.72};color:#1f2329;margin:0 0 ${o.gap == null ? 5 : o.gap}px`
    : S.p
  const liStyle = o.fontSize
    ? `font-size:${o.fontSize}px;line-height:${o.lineHeight || 1.72};color:#1f2329;margin:0 0 ${o.gap == null ? 4 : o.gap}px`
    : S.li

  const blocks = []

  // 1) 代码块 ```lang ... ```
  src = src.replace(/```[a-zA-Z0-9+#-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push({ kind: 'code', text: code.replace(/\n+$/, '') })
    return '\u0000B' + (blocks.length - 1) + '\u0000'
  })

  // 2) 独立公式块 $$ ... $$（可能跨行）
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, f) => {
    blocks.push({ kind: 'math', text: f.trim() })
    return '\u0000B' + (blocks.length - 1) + '\u0000'
  })

  const lines = src.split('\n')
  const nodes = []
  let i = 0

  const renderBlock = (idx) => {
    const b = blocks[idx]
    if (!b) return
    if (b.kind === 'math') {
      // 独立公式：交给 latex.js 居中渲染，不再套灰底代码框
      latex.blockNodes(b.text).forEach((n) => nodes.push(n))
      return
    }
    // 逐行嵌套，避免依赖 white-space；外层容器负责背景与内边距
    const rows = b.text.split('\n').map((ln) =>
      div(`font-size:13px;line-height:1.75;color:#1f2329;font-family:${MONO}`, [txt(ln || ' ')]),
    )
    nodes.push(div('background:#f2f3f5;border-radius:6px;padding:10px;margin:0 0 9px', rows))
  }

  while (i < lines.length) {
    const raw = lines[i]
    const t = raw.trim()

    if (!t) {
      i += 1
      continue
    }

    // 预抽块占位
    const ph = t.match(/^\u0000B(\d+)\u0000$/)
    if (ph) {
      renderBlock(Number(ph[1]))
      i += 1
      continue
    }

    // 标题
    const h = t.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const style = level === 1 ? S.h1 : level === 2 ? S.h2 : S.h3
      nodes.push(div(style, inline(h[2].trim())))
      i += 1
      continue
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      nodes.push(div(S.hr, []))
      i += 1
      continue
    }

    // 引用
    if (/^>\s?/.test(t)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''))
        i += 1
      }
      nodes.push(div(S.quote, inline(buf.join(' '))))
      continue
    }

    // 无序列表
    if (/^[-*+]\s+/.test(t)) {
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        const item = lines[i].trim().replace(/^[-*+]\s+/, '')
        nodes.push(div(liStyle, [span('color:#86909c', '· ')].concat(inline(item))))
        i += 1
      }
      continue
    }

    // 有序列表
    if (/^\d+[.)]\s+/.test(t)) {
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        const mm = lines[i].trim().match(/^(\d+)[.)]\s+(.*)$/)
        nodes.push(div(liStyle, [span('color:#86909c', mm[1] + '. ')].concat(inline(mm[2]))))
        i += 1
      }
      continue
    }

    // 表格：rich-text 里手工画表格易错位，统一按等宽行显示
    if (isTableRow(t)) {
      while (i < lines.length && (isTableRow(lines[i].trim()) || isTableSep(lines[i].trim()))) {
        const row = lines[i].trim()
        if (!isTableSep(row)) nodes.push(div(S.tableRow, [txt(row)]))
        i += 1
      }
      continue
    }

    // 普通段落：合并直到空行或下一个块
    const buf = [t]
    i += 1
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i].trim())) {
      buf.push(lines[i].trim())
      i += 1
    }
    nodes.push(div(pStyle, inline(buf.join(' '))))
  }

  return nodes
}

/**
 * 题干专用：按行保留（题号、选项各占一行），只做行内样式与公式渲染。
 * 不走 toNodes 是因为题干开头的 "1." 会被当成有序列表，题号缩进就跑了。
 *
 * @param {string} text
 * @param {{fontSize?:number,lineHeight?:number,color?:string,gap?:number}} [opts]
 *        错题本列表这类窄容器要小一号字，字号以 px 传（rich-text 不认 rpx）
 */
function linesToNodes(text, opts) {
  const o = opts || {}
  const size = o.fontSize || 15
  const lh = o.lineHeight || 1.85
  const color = o.color || '#1f2329'
  const gap = o.gap == null ? 9 : o.gap
  const style = `font-size:${size}px;line-height:${lh};color:${color};margin:0 0 ${gap}px`
  const nodes = []
  String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((raw) => {
      const line = raw.trim()
      if (!line) return
      nodes.push(div(style, inline(line)))
    })
  return nodes
}

/**
 * 列表摘要：Markdown + LaTeX 压成一行纯文字，供错题本列表、会话标题用。
 * 公式降级成 (a)/(b)、x^2 这类可读写法，不会在列表里露出反斜杠。
 */
function plainPreview(md, max) {
  let text = String(md == null ? '' : md).replace(/\r\n?/g, '\n')
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, f) => ` ${latex.plainText(f)} `)
  text = text.replace(/\$([^$\n]+)\$/g, (_, f) => latex.plainText(f))
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, f) => latex.plainText(f))
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/[*_`>#~]/g, '')
  text = text.replace(/\s+/g, ' ').trim()
  const limit = max || 90
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

module.exports = { toNodes, linesToNodes, plainPreview }
