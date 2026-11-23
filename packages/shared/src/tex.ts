// LaTeX 文本清洗：修掉 OCR / 模型输出里最常见的「命令粘连」

/**
 * 函数名类命令。视觉模型识别 `ln sin x` 时常把括号和空格一起吃掉，
 * 输出成 `\lnsinx`，KaTeX 会当成未知命令直接报错，前端只能退化成源码。
 */
const FUNC_COMMANDS = new Set([
  'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh',
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'ln', 'log', 'lg', 'exp',
  'max', 'min', 'sup', 'inf', 'lim',
  'det', 'dim', 'ker', 'gcd', 'deg', 'arg', 'sgn', 'mod', 'bmod', 'pmod',
]);

/**
 * 全部已知命令。凡是整体命中这里的，一律原样保留——
 * 否则 `\lnot` 会被当成 `\ln`+`ot`，`\limits` 会被当成 `\lim`+`its`。
 */
const KNOWN_COMMANDS = new Set([
  ...FUNC_COMMANDS,
  // 结构
  'frac', 'dfrac', 'tfrac', 'sqrt', 'left', 'right', 'text', 'mathrm', 'mathbf',
  'textit', 'mathbb', 'mathcal', 'boldsymbol', 'mbox', 'operatorname', 'overline',
  'bar', 'underline', 'vec', 'overrightarrow', 'hat', 'widehat', 'begin', 'end',
  'displaystyle', 'textstyle', 'limits', 'nolimits', 'quad', 'qquad', 'hspace',
  'lnot', 'not', 'phantom', 'boxed', 'overset', 'underset', 'stackrel', 'substack',
  'binom', 'choose', 'over', 'atop', 'cr', 'hline', 'intop', 'mathop', 'mathbin',
  'mathrel', 'mathord', 'mathopen', 'mathclose', 'mathpunct', 'mathinner',
  // 大算符
  'int', 'iint', 'iiint', 'oint', 'sum', 'prod', 'coprod', 'bigcup', 'bigcap',
  'bigoplus', 'bigotimes', 'liminf', 'limsup',
  // 希腊字母
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
  'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron',
  'pi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi',
  'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi',
  'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
  // 运算符 / 关系
  'le', 'leq', 'ge', 'geq', 'ne', 'neq', 'approx', 'equiv', 'sim', 'simeq',
  'cong', 'propto', 'll', 'gg', 'cdot', 'times', 'div', 'pm', 'mp', 'ast',
  'star', 'circ', 'bullet', 'infty', 'partial', 'nabla', 'forall', 'exists',
  'emptyset', 'varnothing', 'in', 'notin', 'ni', 'subset', 'subseteq', 'supset',
  'supseteq', 'cup', 'cap', 'wedge', 'vee', 'neg', 'lor', 'land', 'to',
  'rightarrow', 'leftarrow', 'leftrightarrow', 'Rightarrow', 'Leftarrow',
  'Leftrightarrow', 'mapsto', 'implies', 'iff', 'therefore', 'because', 'angle',
  'perp', 'parallel', 'triangle', 'square', 'degree', 'prime', 'backslash',
  'ldots', 'dots', 'cdots', 'vdots', 'ddots', 'langle', 'rangle', 'lceil',
  'rceil', 'lfloor', 'rfloor', 'lbrace', 'rbrace', 'vert', 'Vert', 'mid',
]);

/** 长度降序：保证 `\arcsin` 优先于 `\arc`+`sin` 这类误拆 */
const FUNC_PREFIXES = [...FUNC_COMMANDS].sort((a, b) => b.length - a.length);

/**
 * 在按长度降序的函数名前缀中查找 name 的最长匹配前缀。
 * @param name 待拆的命令名（不含反斜杠）
 * @returns 命中时返回 { head: 前缀, rest: 剩余部分 }，否则 null
 */
function matchPrefix(name: string): { head: string; rest: string } | null {
  for (const p of FUNC_PREFIXES) {
    if (name.length > p.length && name.startsWith(p)) return { head: p, rest: name.slice(p.length) };
  }
  return null;
}

/**
 * 递归拆分剩余部分（可能仍是「函数名+参数」，如 \lnsinx 的 sinx）。
 * @param rest 剩余字符串
 * @param depth 递归深度，超过 4 层直接返回
 * @returns 插入反斜杠与空格后的可读文本
 */
function splitRest(rest: string, depth = 0): string {
  if (!rest || depth > 4) return ` ${rest}`;
  const m = matchPrefix(rest);
  if (!m) return ` ${rest}`;
  return `\\${m.head}${splitRest(m.rest, depth + 1)}`;
}

/**
 * 修掉粘连的命令名：`\lnsinx` → `\ln\sin x`、`\lnx` → `\ln x`。
 * 幂等，对正常公式不做任何改动。
 * @param tex 待修补的 TeX 文本
 * @returns 修补粘连命令后的文本
 */
export function repairTex(tex: string): string {
  if (!tex || tex.indexOf('\\') < 0) return tex;
  return tex.replace(/\\([a-zA-Z]+)/g, (whole, name: string) => {
    if (KNOWN_COMMANDS.has(name)) return whole;
    const m = matchPrefix(name);
    if (!m) return whole;
    return `\\${m.head}${splitRest(m.rest)}`;
  });
}
