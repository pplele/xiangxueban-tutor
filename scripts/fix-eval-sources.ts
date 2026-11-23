/**
 * 把评测集的 expected_source 从旧手写概要文件名迁移到教材转录的新文件名。
 * 依据：数学 kp 前缀即章号；英语 kp 前缀即题型板块。旧名仅作兜底。
 * 用法：npx tsx scripts/fix-eval-sources.ts [--dry]
 */
import fs from 'node:fs';

const MATH_BY_CH: Record<string, string[]> = {
  '1': ['01-函数与极限'],
  '2': ['02-导数与微分'],
  '3': ['03-微分中值定理与导数应用'],
  '4': ['04-不定积分'],
  '5': ['05-定积分及其应用'],
  '6': ['06-微分方程'],
  '7': ['07-向量代数与空间解析几何'],
  '8': ['08-多元函数微分法及其应用'],
  '9': ['09-重积分'],
  '10': ['10-无穷级数'],
};

function englishByKp(kp: string): string[] {
  const n = Number(kp.split('.')[1]);
  if (kp.startsWith('E1')) {
    return n <= 6 ? ['02-第一章-词法'] : ['03-第二章-句法上', '04-第二章-句法下'];
  }
  if (kp.startsWith('E2')) return ['07-第五章-阅读理解'];
  if (kp.startsWith('E3')) return ['06-第四章-完形填空'];
  if (kp.startsWith('E4')) return ['08-第六章-翻译'];
  if (kp.startsWith('E5')) return ['09-第七章-写作上-应用文', '10-第七章-写作下-提纲图画图表'];
  return [];
}

/** 旧 source 名关键词兜底 */
const LEGACY: { match: string; target: string[] }[] = [
  { match: '01-函数与极限', target: ['01-函数与极限'] },
  { match: '02-导数与微分', target: ['02-导数与微分'] },
  { match: '03-中值定理与导数应用', target: ['03-微分中值定理与导数应用'] },
  { match: '04-积分学', target: ['04-不定积分', '05-定积分及其应用'] },
  { match: '05-空间解析几何与多元微积分', target: ['07-向量代数与空间解析几何', '08-多元函数微分法及其应用'] },
  { match: '06-无穷级数与微分方程', target: ['06-微分方程', '10-无穷级数'] },
  { match: '01-语法核心', target: ['02-第一章-词法', '03-第二章-句法上'] },
  { match: '02-阅读与完形', target: ['06-第四章-完形填空', '07-第五章-阅读理解'] },
  { match: '03-翻译与写作', target: ['08-第六章-翻译', '09-第七章-写作上-应用文', '10-第七章-写作下-提纲图画图表'] },
  { match: '04-高频词汇与搭配', target: ['02-第一章-词法', '11-附录-构词法-不规则动词-词语搭配'] },
];

const dry = process.argv.includes('--dry');
const file = 'eval/questions.jsonl';
const lines = fs.readFileSync(file, 'utf8').split('\n');
const out: string[] = [];
let changed = 0;
let unresolved = 0;

for (const line of lines) {
  if (!line.trim()) {
    out.push(line);
    continue;
  }
  const q = JSON.parse(line) as {
    id: string;
    subject: string;
    query: string;
    expected_source?: string | string[];
    expected_kp?: string[];
  };
  const old = q.expected_source;
  const oldStr = Array.isArray(old) ? old.join('|') : old;
  let target: string[] | undefined;

  if (q.subject === 'math' && q.expected_kp?.length) {
    target = MATH_BY_CH[q.expected_kp[0].split('.')[0]];
  } else if (q.subject === 'english' && q.expected_kp?.length) {
    target = englishByKp(q.expected_kp[0]);
  }
  if (!target && oldStr) {
    target = LEGACY.find((l) => oldStr.includes(l.match))?.target;
  }
  if (!target && oldStr) {
    // cs 类：库中旧数据仍在，保持原样
    if (oldStr.startsWith(' cs') || /计算机|数据结构|网络|程序设计/.test(oldStr)) target = [oldStr.replace(/^\s+/, '')];
    else unresolved += 1;
  }

  if (target && JSON.stringify(target) !== JSON.stringify(old)) {
    q.expected_source = target.length === 1 ? target[0] : target;
    changed += 1;
  }
  out.push(JSON.stringify(q));
}

console.log(`共 ${lines.filter((l) => l.trim()).length} 题，改写 ${changed} 题，未解析 ${unresolved} 题`);
if (!dry) {
  fs.writeFileSync(file + '.bak', fs.readFileSync(file));
  fs.writeFileSync(file, out.join('\n'));
  console.log('已写回 eval/questions.jsonl（备份 questions.jsonl.bak）');
}
