/**
 * 极简 LaTeX → rich-text 节点
 *
 * 小程序的 rich-text 只认 HTML，不认 TeX。讲解里全是 $\frac{\pi}{6}$、$\ln(\sin x)$、
 * 积分上下限这类写法，不转就会整屏露出反斜杠。这里覆盖教材/讲解中实际会出现的子集：
 *   分式（上下叠放+横线）、根号、上下标、希腊字母、积分/求和/极限、\left \right 定界符、
 *   \text \mathrm 正体、\overline \vec 等重音、常见运算符与函数名。
 *
 * 设计原则：宁可降级成可读的纯文字，也绝不把 LaTeX 源码吐给学生。
 * 逐字符解析（不用正则套正则），遇到没见过的命令只去掉反斜杠保留名字。
 */

const INK = '#1f2329'
const MONO = 'Menlo,Consolas,"Courier New",monospace'
// 公式走衬线体，接近纸质教材/试卷的排字感；等宽体只留给真正需要对齐的地方
const SERIF = '"Times New Roman",Georgia,"Songti SC","SimSun",serif'

const S = {
  math: `font-family:${SERIF};color:${INK}`,
  sup: 'font-size:0.72em;line-height:0;vertical-align:super',
  sub: 'font-size:0.72em;line-height:0;vertical-align:sub',
  fracWrap: 'display:inline-block;vertical-align:middle;text-align:center;margin:0 2px;line-height:1.2',
  fracCell: 'display:block;padding:0 3px;line-height:1.28;white-space:nowrap',
  sqrtBody: `border-top:1px solid ${INK};padding:0 3px 0 2px`,
  upright: `font-family:-apple-system,"PingFang SC",sans-serif;font-style:normal`,
  overline: `border-top:1px solid ${INK};padding:0 1px`,
  vec: 'position:relative',
}

/** 单字符 / 无参数命令 → 可显示的字形 */
const SYMBOL = {
  // 希腊字母
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // 运算符
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
  circ: '∘', bullet: '•', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  ne: '≠', neq: '≠', equiv: '≡', approx: '≈', sim: '∼', simeq: '≃',
  propto: '∝', infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃',
  emptyset: '∅', varnothing: '∅', in: '∈', notin: '∉', ni: '∋',
  subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', wedge: '∧', vee: '∨', neg: '¬',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦',
  implies: '⇒', iff: '⇔', therefore: '∴', because: '∵',
  angle: '∠', perp: '⊥', parallel: '∥', triangle: '△', square: '□',
  degree: '°', prime: '′', backslash: '\\',
  ldots: '…', dots: '…', cdots: '…', vdots: '⋮', ddots: '⋱',
  // 大算符
  int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  sum: '∑', prod: '∏', coprod: '∐', bigcup: '⋃', bigcap: '⋂',
  // 定界符
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  '{': '{', '}': '}', '|': '‖', '%': '%', $: '$', '&': '&', '#': '#', _: '_',
}

/** 函数名：正体显示，不改字形 */
const FUNC = {
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh',
  ln: 'ln', log: 'log', lg: 'lg', exp: 'exp',
  lim: 'lim', max: 'max', min: 'min', sup: 'sup', inf: 'inf',
  det: 'det', dim: 'dim', ker: 'ker', gcd: 'gcd', mod: 'mod', bmod: 'mod',
  deg: 'deg', arg: 'arg', sgn: 'sgn',
}

/** 空白类命令 */
const SPACE = { ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', quad: '\u2003', qquad: '\u2003\u2003', enspace: ' ' }

/* ---------- 命令粘连修复 ----------
 * OCR 常把 `\ln(\sin x)` 识别成 `\lnsinx`，整体是个未知命令，解析器只能吐出
 * `lnsinx` 一串字母，KaTeX 那边直接报错。这里按已知函数名做最长前缀切分，
 * 和后端 packages/shared/src/tex.ts 的 repairTex 保持同一套规则。
 */
const KNOWN_CMDS = new Set(
  Object.keys(SYMBOL)
    .filter((k) => k.length >= 2)
    .concat(Object.keys(FUNC))
    .concat([
      'frac', 'dfrac', 'tfrac', 'sqrt', 'left', 'right', 'text', 'mathrm', 'mathbf',
      'textit', 'mbox', 'operatorname', 'overline', 'bar', 'underline', 'vec',
      'overrightarrow', 'hat', 'widehat', 'begin', 'end', 'limits', 'nolimits',
      'lnot', 'not', 'binom', 'lbrace', 'rbrace', 'vert', 'Vert', 'mid', 'langle',
      'rangle', 'lceil', 'rceil', 'lfloor', 'rfloor', 'displaystyle', 'textstyle',
      'boxed', 'overset', 'underset', 'stackrel', 'hspace',
    ]),
)
const FUNC_PREFIXES = Object.keys(FUNC).sort((a, b) => b.length - a.length)

function matchPrefix(name) {
  for (let i = 0; i < FUNC_PREFIXES.length; i += 1) {
    const p = FUNC_PREFIXES[i]
    if (name.length > p.length && name.indexOf(p) === 0) return { head: p, rest: name.slice(p.length) }
  }
  return null
}

function splitRest(rest, depth) {
  if (!rest || depth > 4) return ` ${rest}`
  const m = matchPrefix(rest)
  if (!m) return ` ${rest}`
  return `\\${m.head}${splitRest(m.rest, depth + 1)}`
}

/** `\lnsinx` → `\ln\sin x`；幂等，正常公式不受影响 */
function repairTex(tex) {
  const src = String(tex == null ? '' : tex)
  if (src.indexOf('\\') < 0) return src
  return src.replace(/\\([a-zA-Z]+)/g, (whole, name) => {
    if (KNOWN_CMDS.has(name)) return whole
    const m = matchPrefix(name)
    if (!m) return whole
    return `\\${m.head}${splitRest(m.rest, 0)}`
  })
}

function txt(text) {
  return { type: 'text', text: String(text) }
}

function el(name, style, children) {
  return { name, attrs: style ? { style } : {}, children: children || [] }
}

const span = (style, children) => el('span', style, children)

/** 读 {…} 组，返回组内原文；支持 \frac12 这种单字符参数 */
function readGroup(src, i) {
  if (src[i] !== '{') {
    if (src[i] === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i))
      if (m) return { body: m[0], next: i + m[0].length }
    }
    return { body: src[i] || '', next: i + 1 }
  }
  let depth = 0
  for (let j = i; j < src.length; j += 1) {
    const ch = src[j]
    if (ch === '\\') {
      j += 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { body: src.slice(i + 1, j), next: j + 1 }
    }
  }
  return { body: src.slice(i + 1), next: src.length }
}

/** 跳过空白（TeX 里空格不影响排版） */
function skipSpace(src, i) {
  let j = i
  while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j += 1
  return j
}

/** 上下标：^{…} / _x */
function readScriptArg(src, i) {
  const j = skipSpace(src, i)
  if (src[j] === '{') {
    const g = readGroup(src, j)
    return g
  }
  return readGroup(src, j)
}

function fraction(numNodes, denNodes) {
  return span(S.fracWrap, [
    span(`${S.fracCell};border-bottom:1px solid ${INK}`, numNodes),
    span(S.fracCell, denNodes),
  ])
}

function sqrtNode(inner, indexNodes) {
  const kids = []
  if (indexNodes && indexNodes.length) {
    kids.push(el('sup', 'font-size:0.62em;vertical-align:super;margin-right:-4px', indexNodes))
  }
  kids.push(txt('√'))
  kids.push(span(S.sqrtBody, inner))
  return span('display:inline-block;white-space:nowrap', kids)
}

/** \begin{cases} … \end{cases}：左大括号 + 逐行 */
function casesNode(body) {
  const rows = body
    .split(/\\\\/)
    .map((r) => r.replace(/&/g, ' ').trim())
    .filter(Boolean)
    .map((r) => span('display:block;line-height:1.9;padding-left:4px', parse(r)))
  return span('display:inline-block;vertical-align:middle;white-space:nowrap', [
    span(`font-size:1.9em;line-height:1;vertical-align:middle;font-family:${SERIF}`, [txt('{')]),
    span('display:inline-block;vertical-align:middle', rows),
  ])
}

/**
 * 主解析：源码 → 节点数组
 * @param {string} src LaTeX（不含 $ 定界符）
 */
function parse(src) {
  const out = []
  let i = 0

  const pushText = (s) => {
    if (!s) return
    const last = out[out.length - 1]
    if (last && last.type === 'text') last.text += s
    else out.push(txt(s))
  }

  while (i < src.length) {
    const ch = src[i]

    if (ch === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i))
      if (!m) {
        i += 1
        continue
      }
      const name = m[1]
      i += m[0].length

      // 换行 \\ 与空白命令
      if (name === '\\') {
        pushText(' ')
        continue
      }
      if (Object.prototype.hasOwnProperty.call(SPACE, name)) {
        pushText(SPACE[name])
        continue
      }
      // 分式
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const a = readGroup(src, skipSpace(src, i))
        const b = readGroup(src, skipSpace(src, a.next))
        out.push(fraction(parse(a.body), parse(b.body)))
        i = b.next
        continue
      }
      // 根号
      if (name === 'sqrt') {
        let j = skipSpace(src, i)
        let index = null
        if (src[j] === '[') {
          const close = src.indexOf(']', j)
          if (close > 0) {
            index = parse(src.slice(j + 1, close))
            j = close + 1
          }
        }
        const g = readGroup(src, skipSpace(src, j))
        out.push(sqrtNode(parse(g.body), index))
        i = g.next
        continue
      }
      // 正体文字
      if (name === 'text' || name === 'mathrm' || name === 'textit' || name === 'mbox' || name === 'operatorname') {
        const g = readGroup(src, skipSpace(src, i))
        out.push(span(S.upright, [txt(g.body)]))
        i = g.next
        continue
      }
      if (name === 'textbf' || name === 'mathbf' || name === 'boldsymbol') {
        const g = readGroup(src, skipSpace(src, i))
        out.push(span(`${S.upright};font-weight:600`, [txt(g.body)]))
        i = g.next
        continue
      }
      // 定界符
      if (name === 'left' || name === 'right') {
        const j = skipSpace(src, i)
        if (src[j] === '\\') {
          const d = /^\\([a-zA-Z]+|.)/.exec(src.slice(j))
          if (d) {
            if (d[1] !== '.') pushText(SYMBOL[d[1]] || d[1])
            i = j + d[0].length
            continue
          }
        }
        const c = src[j] || ''
        if (c && c !== '.') pushText(c)
        i = j + 1
        continue
      }
      // 重音 / 上划线
      if (name === 'overline' || name === 'bar') {
        const g = readGroup(src, skipSpace(src, i))
        out.push(span(S.overline, parse(g.body)))
        i = g.next
        continue
      }
      if (name === 'underline') {
        const g = readGroup(src, skipSpace(src, i))
        out.push(span(`border-bottom:1px solid ${INK};padding:0 1px`, parse(g.body)))
        i = g.next
        continue
      }
      if (name === 'vec' || name === 'overrightarrow') {
        const g = readGroup(src, skipSpace(src, i))
        out.push(span(S.vec, [span('display:block;font-size:0.7em;line-height:0.6', [txt('→')])].concat(parse(g.body))))
        i = g.next
        continue
      }
      if (name === 'hat' || name === 'widehat') {
        const g = readGroup(src, skipSpace(src, i))
        out.push(span(S.vec, [span('display:block;font-size:0.8em;line-height:0.5', [txt('^')])].concat(parse(g.body))))
        i = g.next
        continue
      }
      // 分段函数
      if (name === 'begin') {
        const env = readGroup(src, skipSpace(src, i))
        const endTag = `\\end{${env.body}}`
        const endIdx = src.indexOf(endTag, env.next)
        const body = endIdx >= 0 ? src.slice(env.next, endIdx) : src.slice(env.next)
        if (env.body === 'cases') out.push(casesNode(body))
        else out.push(span('display:block', parse(body)))
        i = endIdx >= 0 ? endIdx + endTag.length : src.length
        continue
      }
      if (name === 'end') {
        const g = readGroup(src, skipSpace(src, i))
        i = g.next
        continue
      }
      // 函数名
      if (Object.prototype.hasOwnProperty.call(FUNC, name)) {
        // \ln\sin x 里的两个函数名会粘成 "lnsin"，补一个空格还原 TeX 的字间距
        const last = out[out.length - 1]
        if (last && last.type === 'text' && /[a-zA-Z]$/.test(last.text)) pushText(' ')
        pushText(FUNC[name])
        continue
      }
      // 普通符号
      if (Object.prototype.hasOwnProperty.call(SYMBOL, name)) {
        pushText(SYMBOL[name])
        continue
      }
      // 未知命令：去掉反斜杠保留名字，绝不把源码吐出来
      pushText(name)
      continue
    }

    if (ch === '{') {
      const g = readGroup(src, i)
      parse(g.body).forEach((n) => out.push(n))
      i = g.next
      continue
    }

    if (ch === '}') {
      i += 1
      continue
    }

    if (ch === '^' || ch === '_') {
      const g = readScriptArg(src, i + 1)
      const kids = parse(g.body)
      out.push(el(ch === '^' ? 'sup' : 'sub', ch === '^' ? S.sup : S.sub, kids.length ? kids : [txt(' ')]))
      i = g.next
      continue
    }

    // 普通字符：连续空格压成一个，与 TeX 一致
    if (ch === ' ') {
      let j = i
      while (j < src.length && src[j] === ' ') j += 1
      pushText(' ')
      i = j
      continue
    }

    pushText(ch)
    i += 1
  }

  if (out.length === 0) out.push(txt(' '))
  return out
}

/** 行内公式：包一层衬线字体，跟着正文行高走 */
function inlineNodes(tex) {
  const inner = parse(repairTex(tex))
  return [span(S.math, inner)]
}

/** 独立公式：居中、字号略大 */
function blockNodes(tex) {
  return [
    el('div', `text-align:center;margin:6px 0 10px;font-size:1.12em;line-height:2`, [
      span(S.math, parse(repairTex(tex))),
    ]),
  ]
}

/**
 * 纯文本降级：列表摘要、搜索匹配这类放不下排版的地方用。
 * 分式写成 (a)/(b)，上下标写成 x^2 —— 保住信息，不留反斜杠。
 */
function plainText(tex) {
  return repairTex(tex)
    .replace(/\\(?:d|t)?frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
    .replace(/\\sqrt\[([^\]]*)\]\{([^{}]*)\}/g, '$1√($2)')
    .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
    .replace(/\^\{([^{}]*)\}/g, '^$1')
    .replace(/_\{([^{}]*)\}/g, '_$1')
    .replace(/\\[a-zA-Z]+/g, (m, offset, src) => {
      const name = m.slice(1)
      let val
      if (Object.prototype.hasOwnProperty.call(SYMBOL, name)) val = SYMBOL[name]
      else if (Object.prototype.hasOwnProperty.call(FUNC, name)) val = FUNC[name]
      else if (name === 'quad' || name === 'qquad') val = ' '
      // 未知命令保留名字，绝不返回空串——那会让整个式子从摘要里消失
      else val = name
      // \ln\sin x 拆开后是 "lnsin"，中间补空格
      const prev = offset > 0 ? src.charAt(offset - 1) : ''
      return /[a-zA-Z]$/.test(prev) && /^[a-zA-Z]/.test(val) ? ` ${val}` : val
    })
    .replace(/\\[{}%$&#_|]/g, (m) => m.slice(1))
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

module.exports = { inlineNodes, blockNodes, plainText, repairTex, toNodes: parse }
