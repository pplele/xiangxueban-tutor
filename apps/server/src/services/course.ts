import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface CourseLesson {
  /** 相对课程根目录的路径（如 `Unit 2/Lesson 1-1.mp4`），流媒体接口按它取文件 */
  file: string;
  /** 清洗后的展示名（去掉「01.」编号前缀和「(2)」下载重复后缀） */
  name: string;
  sizeMb: number;
}

/** 单词课的一个 Unit（课程目录） */
export interface CourseUnit {
  unit: number;
  title: string;
  lessons: CourseLesson[];
}

/**
 * 课程资源根目录（启动方式不同 cwd 会变）：从 cwd 逐级向上找 data/刘晓燕单词课，最多 5 层。
 * @returns 课程根目录绝对路径
 */
export function courseDir(): string {
  const rel = path.join('data', '刘晓燕单词课');
  let dir = process.cwd();
  for (let i = 0; i < 5; i += 1) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已到盘符根
    dir = parent;
  }
  // 兜底：构建产物（dist）里 __dirname 层级不同，从源码位置再试一次
  const fromDir = path.resolve(__dirname, '../../../data/刘晓燕单词课');
  if (fs.existsSync(fromDir)) return fromDir;
  throw new Error(`找不到 data/刘晓燕单词课（cwd=${process.cwd()}）`);
}

/**
 * 展示名清洗：「01.Lesson 1-1(2).mp4」→「Lesson 1-1」。
 * @param filename 视频文件名
 * @returns 清洗后的展示名
 */
function lessonTitle(filename: string): string {
  return filename
    .replace(/\.mp4$/i, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\(\d+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 排序键：优先按「01.」这类编号前缀；没有前缀的（如「Lesson 3-1(2).mp4」）
 * 依次取文件名里出现的数字（Lesson 3-1 → [3, 1]）。
 */
function lessonKey(filename: string): number[] {
  const prefix = /^(\d+)\./.exec(filename);
  const nums = [...filename.matchAll(/\d+/g)].map((m) => Number(m[0]));
  return prefix ? [Number(prefix[1]), ...nums] : [Infinity, ...nums];
}

/** 比较两个数字数组（自然排序键），逐位比较返回大小 */
function cmpNum(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 扫描课程根目录：按 Unit 分组列出所有 mp4，清洗展示名并自然排序。
 * @returns Unit 列表（含课程视频）
 */
export async function listCourse(): Promise<CourseUnit[]> {
  const root = courseDir();
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const units: CourseUnit[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = /Unit\s*(\d+)/i.exec(e.name);
    if (!m) continue;
    const files = (await fsp.readdir(path.join(root, e.name))).filter((f) => /\.mp4$/i.test(f));
    const lessons = await Promise.all(
      files.map(async (f) => {
        const st = await fsp.stat(path.join(root, e.name, f));
        const lesson: CourseLesson = {
          file: `${e.name}/${f}`,
          name: lessonTitle(f),
          sizeMb: Math.round(st.size / 1024 / 1024),
        };
        return { lesson, key: lessonKey(f) };
      }),
    );
    lessons.sort((a, b) => cmpNum(a.key, b.key));
    units.push({
      unit: Number(m[1]),
      title: `Unit ${Number(m[1])}`,
      lessons: lessons.map((l) => l.lesson),
    });
  }
  units.sort((a, b) => a.unit - b.unit);
  return units;
}

/**
 * 把前端传来的相对路径解析成绝对路径，挡住目录穿越和非 mp4。
 * @param rel 相对课程根目录的视频路径
 * @returns 合法存在的绝对路径，否则 null
 */
export function resolveCourseFile(rel: string): string | null {
  if (!rel) return null;
  const root = courseDir();
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (!/\.mp4$/i.test(abs)) return null;
  return fs.existsSync(abs) ? abs : null;
}
