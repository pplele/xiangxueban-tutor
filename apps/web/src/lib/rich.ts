import katex from 'katex';
import { repairTex } from '@tutor/shared';

/** 匹配 $$...$$ / \[...\] / \(...\) / $...$ 四种公式定界符 */
const FORMULA_RE = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]+?\$)/g;
/** 匹配带可选语言标记的三反引号代码块 */
const FENCE_RE = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;

/**
 * HTML 转义：把 & < > " ' 转成实体，防止 v-html 注入。
 * @param text 原始文本
 * @returns 转义后的文本
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 去掉公式定界符后交给 KaTeX 渲染；渲染失败先用 repairTex 修补粘连命令重试，仍失败则降级为纯文本。
 * @param raw 含定界符的原始公式
 * @returns KaTeX HTML 或降级 span
 */
function renderFormula(raw: string): string {
  const display = raw.startsWith('$$') || raw.startsWith('\\[');
  let tex = raw;
  if (raw.startsWith('$$')) tex = raw.slice(2, -2);
  else if (raw.startsWith('\\[')) tex = raw.slice(2, -2);
  else if (raw.startsWith('\\(')) tex = raw.slice(2, -2);
  else if (raw.startsWith('$')) tex = raw.slice(1, -1);

  /** 用固定配置调用 KaTeX：throwOnError 便于捕获后走修补/降级流程 */
  const render = (t: string) =>
    katex.renderToString(t, {
      displayMode: display,
      throwOnError: true,
      strict: false,
      trust: false,
      output: 'html',
    });

  const source = tex.trim();
  try {
    return render(source);
  } catch {
    // OCR 常把 `\ln(\sin x)` 识别成 `\lnsinx`，KaTeX 会当未知命令报错。
    // 先尝试修补命令粘连再重试，能救回就绝不把反斜杠源码甩给用户。
    const fixed = repairTex(source);
    if (fixed !== source) {
      try {
        return render(fixed);
      } catch {
        /* 落到下面的纯文本降级 */
      }
    }
    // 仍然失败：只去定界符，保留反斜杠，至少让学生看出是哪个式子坏了
    return `<span class="formula-fallback">${escapeHtml(fixed)}</span>`;
  }
}

/**
 * 渲染行内 Markdown 子集：行内代码、粗体、斜体、删除线与安全链接（仅 http/https）。
 * @param text 已做 HTML 转义的行内文本
 * @returns 行内 HTML
 */
function inline(text: string): string {
  let out = text;
  // 行内代码
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // 粗体
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 斜体（避免误伤粗体残留）
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // 删除线
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // 安全链接：仅允许 http/https
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return out;
}

/**
 * 判断一行是否为 Markdown 表格分隔行（形如 |---|:---:|）。
 * @param line 待判断的行
 * @returns 是否为分隔行
 */
function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

/**
 * 逐行解析受控 Markdown 子集：段落、标题、水平线、表格、引用、有序/无序列表，
 * 遇到 \u0001Cn\u0001 代码占位符与空行时刷新缓冲区。
 * @param text 已转义并抽出公式/代码的文本
 * @returns 块级 HTML
 */
function renderBlocks(text: string): string {
  const lines = text.split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let listItems: string[] = [];
  let quote: string[] = [];

  /** 将缓冲的段落行输出为 <p> 并清空缓冲 */
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${inline(paragraph.join('<br>'))}</p>`);
      paragraph = [];
    }
  };
  /** 将缓冲的列表项输出为 <ul>/<ol> 并清空缓冲 */
  const flushList = () => {
    if (listType && listItems.length > 0) {
      html.push(`<${listType}>${listItems.map((li) => `<li>${inline(li)}</li>`).join('')}</${listType}>`);
    }
    listType = null;
    listItems = [];
  };
  /** 将缓冲的引用行输出为 <blockquote> 并清空缓冲 */
  const flushQuote = () => {
    if (quote.length > 0) {
      html.push(`<blockquote>${inline(quote.join('<br>'))}</blockquote>`);
      quote = [];
    }
  };
  /** 依次刷出段落、列表、引用三类缓冲 */
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.replace(/\s+$/, '');

    if (/^\u0001C\d+\u0001$/.test(line.trim())) {
      flushAll();
      html.push(line.trim());
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(4, heading[1].length + 1);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushAll();
      html.push('<hr>');
      continue;
    }

    // 表格：当前行含 |，下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushAll();
      const headerCells = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      i -= 1;
      html.push(
        `<table><thead><tr>${headerCells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }

    const quoteMatch = /^>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    const ulMatch = /^\s*[-*+]\s+(.*)$/.exec(line);
    const olMatch = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ulMatch || olMatch) {
      flushParagraph();
      flushQuote();
      const type: 'ul' | 'ol' = ulMatch ? 'ul' : 'ol';
      if (listType && listType !== type) flushList();
      listType = type;
      listItems.push((ulMatch ?? olMatch)![1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }

  flushAll();
  return html.join('\n');
}

/**
 * 去掉行首尾的 | 后按 | 拆成单元格并去除空白。
 * @param line 表格的一行
 * @returns 单元格文本数组
 */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * 变式题的题干常把选项挤在一行（`…则（ ）A. $0$ / B. $1$ / …`），
 * 铺到页面上就是一大坨。这里在渲染前把选项拆成独立行。
 * 只在确认「题干末尾紧跟 A.」时才动手，避免误伤正文。
 * @param text 原始题干
 * @returns 选项已断行的题干
 */
function splitInlineOptions(text: string): string {
  if (!/[（(]\s*[）)]\s*A\s*[.．、]/.test(text)) return text;
  let s = text;
  // `/ B.`、`／C.` 这类分隔符 → 换行
  s = s.replace(/\s*[/／]\s*(?=[A-D]\s*[.．、])/g, '\n');
  // 题干与 A 之间断行
  s = s.replace(/((?:[（(]\s*[）)]|：|:))\s*(?=A\s*[.．、])/g, '$1\n');
  // B/C/D 仍挤在同一行时补断行
  s = s.replace(/([^\n])\s+(?=[B-D]\s*[.．、])/g, '$1\n');
  return s;
}

/**
 * 安全渲染：先转义 HTML，再生成受控 Markdown 子集；公式交给 KaTeX。
 * 禁止未净化内容的 v-html。
 * @param input 原始 Markdown/公式混合文本
 * @returns 可安全 v-html 的 HTML
 */
export function renderRich(input: string): string {
  if (!input) return '';
  const formulas: string[] = [];
  const codes: string[] = [];

  let text = splitInlineOptions(input).replace(FENCE_RE, (_m, _lang, code) => {
    const idx = codes.push(String(code)) - 1;
    return `\n\u0001C${idx}\u0001\n`;
  });

  text = text.replace(FORMULA_RE, (m) => {
    const idx = formulas.push(m) - 1;
    return `\u0001F${idx}\u0001`;
  });

  text = escapeHtml(text);
  let html = renderBlocks(text);

  html = html.replace(/\u0001F(\d+)\u0001/g, (_m, idx) => renderFormula(formulas[Number(idx)] ?? ''));
  html = html.replace(/\u0001C(\d+)\u0001/g, (_m, idx) => `<pre><code>${escapeHtml(codes[Number(idx)] ?? '')}</code></pre>`);

  return html;
}

/**
 * 去掉选项自带的「A.」前缀，保留公式定界符，避免与字母徽标重复。
 * @param text 选项原文
 * @returns 去除字母前缀后的选项文本
 */
export function cleanOption(text: string | null | undefined): string {
  if (!text) return '';
  let s = text.trim();
  // 源数据有两种写法：
  //   A. $x\to 0^-$        → 只去掉字母前缀
  //   $A. [-4,4]$          → 先去掉外层 $，再去掉字母前缀
  if (s.startsWith('$') && s.endsWith('$') && s.length > 2) {
    const inner = s.slice(1, -1).trim();
    if (/^[A-Fa-f]\s*[.、．)]/.test(inner)) s = inner;
  }
  s = s.replace(/^[A-Fa-f]\s*[.、．)]\s*/, '').trim();
  return s;
}

/** LaTeX 命令到 Unicode 符号的映射，用于纯文本降级：Unknown 命令仅去反斜杠保留名字 */
const LATEX_SYMBOLS: Record<string, string> = {
  '\\lim': 'lim',
  '\\to': '→',
  '\\infty': '∞',
  '\\sin': 'sin',
  '\\cos': 'cos',
  '\\tan': 'tan',
  '\\cot': 'cot',
  '\\sec': 'sec',
  '\\csc': 'csc',
  '\\arcsin': 'arcsin',
  '\\arccos': 'arccos',
  '\\arctan': 'arctan',
  '\\sinh': 'sinh',
  '\\cosh': 'cosh',
  '\\tanh': 'tanh',
  '\\ln': 'ln',
  '\\log': 'log',
  '\\lg': 'lg',
  '\\exp': 'exp',
  '\\max': 'max',
  '\\min': 'min',
  '\\sup': 'sup',
  '\\inf': 'inf',
  '\\det': 'det',
  '\\gcd': 'gcd',
  '\\cdot': '·',
  '\\times': '×',
  '\\div': '÷',
  '\\le': '≤',
  '\\leq': '≤',
  '\\ge': '≥',
  '\\geq': '≥',
  '\\ne': '≠',
  '\\neq': '≠',
  '\\approx': '≈',
  '\\equiv': '≡',
  '\\pm': '±',
  '\\mp': '∓',
  '\\sim': '∼',
  '\\propto': '∝',
  '\\in': '∈',
  '\\notin': '∉',
  '\\subset': '⊂',
  '\\subseteq': '⊆',
  '\\cup': '∪',
  '\\cap': '∩',
  '\\forall': '∀',
  '\\exists': '∃',
  '\\emptyset': '∅',
  '\\because': '∵',
  '\\therefore': '∴',
  '\\partial': '∂',
  '\\nabla': '∇',
  '\\int': '∫',
  '\\iint': '∬',
  '\\oint': '∮',
  '\\sum': '∑',
  '\\prod': '∏',
  '\\cdots': '…',
  '\\ldots': '…',
  '\\dots': '…',
  '\\left': '',
  '\\right': '',
  // 环境残缺时（OCR 只抄了 \begin 没抄 \end）别把这些词当正文吐出来
  '\\begin': '',
  '\\end': '',
  '\\quad': ' ',
  '\\qquad': ' ',
  '\\,': ' ',
  '\\;': ' ',
  '\\rightarrow': '→',
  '\\leftarrow': '←',
  '\\Rightarrow': '⇒',
  '\\Leftrightarrow': '⇔',
  '\\mapsto': '↦',
  '\\angle': '∠',
  '\\perp': '⊥',
  '\\parallel': '∥',
  '\\triangle': '△',
  '\\degree': '°',
  // 希腊字母：题干里极常见，缺一个就会把 \xi 原样吐成 "xi"
  '\\alpha': 'α',
  '\\beta': 'β',
  '\\gamma': 'γ',
  '\\delta': 'δ',
  '\\epsilon': 'ε',
  '\\varepsilon': 'ε',
  '\\zeta': 'ζ',
  '\\eta': 'η',
  '\\theta': 'θ',
  '\\vartheta': 'ϑ',
  '\\iota': 'ι',
  '\\kappa': 'κ',
  '\\lambda': 'λ',
  '\\mu': 'μ',
  '\\nu': 'ν',
  '\\xi': 'ξ',
  '\\omicron': 'ο',
  '\\pi': 'π',
  '\\rho': 'ρ',
  '\\sigma': 'σ',
  '\\tau': 'τ',
  '\\upsilon': 'υ',
  '\\phi': 'φ',
  '\\varphi': 'φ',
  '\\chi': 'χ',
  '\\psi': 'ψ',
  '\\omega': 'ω',
  '\\Gamma': 'Γ',
  '\\Delta': 'Δ',
  '\\Theta': 'Θ',
  '\\Lambda': 'Λ',
  '\\Xi': 'Ξ',
  '\\Pi': 'Π',
  '\\Sigma': 'Σ',
  '\\Phi': 'Φ',
  '\\Psi': 'Ψ',
  '\\Omega': 'Ω',
};

/* ------------------------------------------------------------------ *
 * 纯文本降级：把一段 TeX 压成一行可读文字，用于列表摘要与详情标题。
 * 不能简单粗暴地删反斜杠——分段函数、嵌套分式、上下标都必须还原成人能读懂
 * 的写法，否则列表里会出现 `begincases … endcases`、`frac√(1+x^2)-1x`。
 * ------------------------------------------------------------------ */

/**
 * 读 `{...}` 内容（支持嵌套），返回 [组内原文, 右括号后一位]。
 * @param src 源字符串
 * @param bracePos 左花括号位置
 * @returns 组内文本与结束位置
 */
function readBrace(src: string, bracePos: number): [string, number] {
  if (src[bracePos] !== '{') return ['', bracePos];
  let depth = 0;
  for (let i = bracePos; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return [src.slice(bracePos + 1, i), i + 1];
    }
  }
  return [src.slice(bracePos + 1), src.length];
}

/** 上标字符映射，用于把 ^{...} 转成 Unicode 上标 */
const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', n: 'ⁿ', k: 'ᵏ', i: 'ⁱ',
};
/** 下标字符映射，用于把 _{...} 转成 Unicode 下标 */
const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
};

/**
 * 把上标/下标组里的字符尽量映射成 Unicode；含不可映射字符时写成 ^(...)/_(...)。
 * @param g 上下标组内容
 * @param table 对应字符映射表（SUP/SUB）
 * @param mark 映射失败时使用的标记（^ 或 _）
 * @returns 降级后的上下标文本
 */
function scriptOf(g: string, table: Record<string, string>, mark: string): string {
  const chars = [...g];
  if (chars.length && chars.every((c) => table[c] !== undefined)) {
    return chars.map((c) => table[c]).join('');
  }
  return `${mark}(${g})`;
}

/**
 * 分式分子分母加括号：单 token 不加，含运算符/空格才加。
 * @param s 分子或分母文本
 * @returns 按需加括号后的文本
 */
function wrapParen(s: string): string {
  const t = s.trim();
  if (!t) return '';
  if (!/[\s+\-*/()（）,，]/.test(t) && t.length <= 6) return t;
  return `(${t})`;
}

/** 常见函数名正则片段，用于判断分式前是否需补括号、函数名后是否补空格 */
const FUNC_NAMES =
  'arccos|arcsin|arctan|cosh|sinh|tanh|cos|sin|tan|cot|sec|csc|lim|max|min|sup|inf|exp|log|lg|ln';

/**
 * 把一段 TeX 递归压成单行可读文字（纯文本降级）：处理环境、分式、根式、\text、上下标、命令符号与残余转义。
 * @param tex 待转换的 TeX 文本
 * @param depth 递归深度，超过 6 层原样返回以防栈溢出
 * @returns 可读的纯文本
 */
function texToPlain(tex: string, depth = 0): string {
  if (depth > 6) return tex;
  let s = tex;

  // 1) 环境：\begin{cases} … \end{cases}。行分隔 \\ 变「；」，对齐符 & 丢弃
  s = s.replace(
    /\\begin\{([a-zA-Z*]+)\}([\s\S]*?)\\end\{\1\}/g,
    (_m, env: string, body: string) => {
      const rows = body
        .split(/\\\\\s*(?:\[[^\]]*\])?/)
        .map((r) => r.replace(/&/g, ' ').trim())
        .filter(Boolean);
      const inner = rows.map((r) => texToPlain(r, depth + 1)).join('；');
      // \u0002/\u0003 是花括号占位符：末尾要统一清掉结构性的 {}，
      // 但分段函数这对外层括号得留住，所以先用私有字符顶替
      return /matrix|array|align|gather/i.test(env) ? `[ ${inner} ]` : `\u0002 ${inner} \u0003`;
    },
  );

  // 2) 分式：手写扫描而非正则，否则 \frac{\sqrt{1+x^2}-1}{x} 这类嵌套匹配不上，
  //    会退化成「frac√(1+x^2)-1x」这种看不懂的东西
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s.startsWith('\\frac', i) || s.startsWith('\\dfrac', i) || s.startsWith('\\tfrac', i)) {
      const cmdLen = s.startsWith('\\frac', i) ? 5 : 6;
      let j = i + cmdLen;
      while (s[j] === ' ') j += 1;
      let num = '';
      let after = j;
      if (s[j] === '{') {
        const [body, next] = readBrace(s, j);
        num = body;
        after = next;
      } else if (s[j]) {
        num = s[j];
        after = j + 1;
      }
      let k = after;
      while (s[k] === ' ') k += 1;
      let den = '';
      let end = after;
      if (s[k] === '{') {
        const [body, next] = readBrace(s, k);
        den = body;
        end = next;
      } else if (s[k]) {
        den = s[k];
        end = k + 1;
      }
      if (num && den) {
        const piece = `${wrapParen(texToPlain(num, depth + 1))}/${wrapParen(texToPlain(den, depth + 1))}`;
        // 三角/对数函数后面直接跟分式时补括号：否则 2\arctan\frac{2}{x} 会变成 "2arctan 2/x"
        const tail = out.slice(-14);
        const afterFunc = new RegExp(`(?:^|[^A-Za-z])(${FUNC_NAMES})\\s*$`, 'i').test(tail);
        out += afterFunc ? `(${piece})` : piece;
        i = end - 1;
        continue;
      }
    }
    out += s[i];
  }
  s = out;

  // 3) 根式（与分式同源：先吃掉参数再递归）
  s = s.replace(/\\sqrt\s*\[([^\]]+)\]\s*\{([^{}]*)\}/g, (_m, idx: string, body: string) => {
    const n = idx.replace(/\s/g, '');
    return `${n === '3' ? '∛' : '√'}(${texToPlain(body, depth + 1)})`;
  });
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_m, body: string) => `√(${texToPlain(body, depth + 1)})`);

  // 4) \text{} / \mathrm{} 等只留内容
  for (let pass = 0; pass < 2; pass += 1) {
    s = s.replace(
      /\\(?:text|textrm|textbf|mathrm|mathbf|mathit|operatorname|rm|bf|it)\s*\{([^{}]*)\}/g,
      '$1',
    );
  }

  // 5) 上下标：能映射成 Unicode 就映射，否则写成 ^(...) / _(...)
  s = s.replace(/\^\{([^{}]*)\}/g, (_m, g: string) => scriptOf(texToPlain(g, depth + 1), SUP, '^'));
  s = s.replace(/\^([0-9nki+-])/g, (_m, g: string) => SUP[g] ?? g);
  s = s.replace(/_\{([^{}]*)\}/g, (_m, g: string) => `(${texToPlain(g, depth + 1)})`);
  s = s.replace(/_([0-9])/g, (_m, g: string) => SUB[g] ?? `_${g}`);

  // 6) 命令 → 符号。未知命令去掉反斜杠但保留名字：早先一律替换成空串，
  //    `\lnsinx` 会整段消失，题干比露源码更难查
  s = s.replace(/\\([a-zA-Z]+)/g, (_m, name: string, offset: number, src: string) => {
    const mapped = LATEX_SYMBOLS[`\\${name}`];
    const body = mapped === undefined ? name : mapped;
    const prev = offset > 0 ? src.charAt(offset - 1) : '';
    return /[a-zA-Z]$/.test(prev) && /^[a-zA-Z]/.test(body) ? ` ${body}` : body;
  });

  // 7) 函数名与后面的操作数之间补空格：cos\frac{1}{x} 会连成 "cos1/x"
  s = s.replace(new RegExp(`(?<![A-Za-z])(${FUNC_NAMES})(?=[0-9A-Za-z√])`, 'g'), '$1 ');

  // 8) 残余转义与行分隔
  s = s.replace(/\\\\/g, '；');
  s = s.replace(/\\[,;:!\s]/g, ' ');
  s = s.replace(/\\([{}%_$&#])/g, '$1');
  s = s.replace(/&/g, ' ');
  s = s.replace(/[{}]/g, '');
  return s.replace(/\s+/g, ' ');
}

/**
 * 截断时尽量落在标点处，并把被切断的 { 补全，避免标题停在半个式子上。
 * @param text 待截断文本
 * @param max 最大长度
 * @returns 截断后以 … 结尾的摘要
 */
function cutPreview(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const punct = ['，', '；', '。', ',', ';', '、'];
  const at = Math.max(...punct.map((p) => head.lastIndexOf(p)));
  let out = at >= Math.floor(max * 0.5) ? head.slice(0, at) : head;
  out = out.replace(/[，、,；;：:]$/, '').trim();
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open > close) out += ` ${'}'.repeat(open - close)}`;
  return `${out}…`;
}

/**
 * 去掉公式定界符：$$…$$ / \[…\] / \(…) / $…$。
 * @param raw 含定界符的公式
 * @returns 去定界符后的公式源码
 */
function stripMathDelims(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('$$') && s.endsWith('$$') && s.length > 4) return s.slice(2, -2);
  if (s.startsWith('\\[') && s.endsWith('\\]')) return s.slice(2, -2);
  if (s.startsWith('\\(') && s.endsWith('\\)')) return s.slice(2, -2);
  if (s.startsWith('$') && s.endsWith('$') && s.length > 2) return s.slice(1, -1);
  return s;
}

/**
 * 纯文本预览：修补公式、走 texToPlain 降级、剥离 Markdown 标记与题号噪声，用于列表摘要与详情标题。
 * @param input 原始文本
 * @param max 摘要最大长度（默认 120）
 * @returns 纯文本摘要
 */
export function plainPreview(input: string, max = 120): string {
  if (!input) return '';
  let text = repairTex(String(input));

  // 公式段落走 texToPlain；正文原样保留（不能整段删 `>`，否则 x > 0 变成 x 0）
  text = text.replace(FORMULA_RE, (m) => ` ${texToPlain(stripMathDelims(m))} `);
  if (text.includes('\\')) text = texToPlain(text);

  text = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([→←⇒⇔≠≤≥≈])\s*/g, '$1')
    .replace(/\s+([，。；：、？！])/g, '$1')
    .replace(/([，。；：、])\s+/g, '$1')
    .replace(/\u0002/g, '{')
    .replace(/\u0003/g, '}')
    // 题号是 OCR 抄进来的（「9. 已知 f(x)…」），列表本身已有题号标签，去掉这层噪声
    .replace(/^\d{1,3}\s*[.、．]\s*(?!\d)/, '')
    .trim();

  return cutPreview(text, max);
}

/**
 * 列表预览用：先跳过题干开头的引用块（英语阅读/完形题导入时把原文折成「> 」块放在最前），
 * 让左侧列表预览的是真正的题目而不是材料；没有引用块时行为与 plainPreview 一致。
 * @param input 题干原文
 * @param max 预览最大字数
 * @returns 纯文本预览
 */
export function bodyPreview(input: string, max = 88): string {
  const text = String(input ?? '');
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || !lines[i].trim())) i += 1;
  const rest = lines.slice(i).join('\n').trim();
  return plainPreview(rest || text, max);
}
