import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../lib/logger';

/**
 * 全套学习流程视频库：递归扫描 data/ 下各课程目录
 * （库课数学课、库课英语课、刘晓燕单词课），三阶段按顺序组成完整备考流程。
 * 层级不固定（课程/模块/章节/视频），因此返回通用树而非写死 Unit/Lesson。
 */

export interface VideoLesson {
  /** 相对 data 根目录的路径，供流媒体接口取文件 */
  file: string;
  /** 展示名（去掉扩展名、数字编号前缀、下载重复后缀） */
  name: string;
  sizeMb: number;
}

export interface LessonGroup {
  /** 节点展示名（课程/模块/章节名） */
  name: string;
  /** 相对 data 根目录的路径，前端作为 key */
  path: string;
  /** 子目录分组 */
  children: LessonGroup[];
  /** 直接挂在该分组下的视频 */
  videos: VideoLesson[];
  /** 该节点（含子孙）视频总数 */
  count: number;
  /** 该节点（含子孙）视频总大小（MB） */
  totalMb: number;
}

export interface Course {
  /** 课程目录名，如「库课英语课」 */
  id: string;
  /** 展示名，如「库课英语」 */
  name: string;
  /** 学习流程中的阶段序号（1 起），未配置的课程排在后面 */
  stage: number;
  /** 学科，如「数学」「英语」「词汇」 */
  subject: string;
  /** 一句话简介 */
  tagline: string;
  /** 阶段配色 key：math / english / word */
  tone: string;
  /** 课程下视频总数 */
  count: number;
  /** 课程视频总大小（MB） */
  totalMb: number;
  /** 顶层分组（一般是「公共英语」这类类别） */
  groups: LessonGroup[];
}

/** 不参与扫描的非课程目录（词表/知识库/上传件等） */
const EXCLUDED = new Set(['kb', 'kp', 'vocab', 'exam-uploads', 'node_modules']);

/**
 * 三阶段学习流程配置：按目录名映射展示信息与顺序。
 * 后续若新增课程目录（如「库课语文课」），会自动作为「拓展课」排在后面。
 */
const COURSE_META: Record<string, { name: string; stage: number; subject: string; tagline: string; tone: string }> = {
  库课数学课: {
    name: '库课数学',
    stage: 1,
    subject: '高等数学',
    tagline: '从基础精讲到真题冲刺，系统过完考纲全部考点',
    tone: 'math',
  },
  库课英语课: {
    name: '库课英语',
    stage: 2,
    subject: '公共英语',
    tagline: '语法、真题、考前串讲，逐模块补齐英语短板',
    tone: 'english',
  },
  刘晓燕单词课: {
    name: '刘晓燕英语',
    stage: 3,
    subject: '英语',
    tagline: '单词打底，语法、解题、阅读逐个啃完',
    tone: 'word',
  },
};

/**
 * 外部课程根目录：直接读取 E:\刘晓燕，不复制视频到项目里（磁盘空间有限）。
 * 可用 EXTRA_COURSE_ROOT 覆盖；逐文件判断，不再因个别下载残留整块跳过。
 */
const EXTERNAL_COURSE_ROOT = process.env.EXTRA_COURSE_ROOT || 'E:/刘晓燕';
const EXTERNAL_PREFIX = 'external:';

/** 形如「xxx.mp4.baiduyun.p.downloading」：去掉临时后缀后其实就是完整 MP4 */
const TEMP_VIDEO_RE = /^(.+\.mp4)\.(?:qkdownloading|baiduyun\.p\.downloading|crdownload|part)$/i;

/**
 * 课程数据根目录：从 cwd 逐级向上找「含课程目录的 data」。
 * 注意 apps/server/data 存在（存 exam-uploads），不能只看 data 是否存在——
 * 必须以「里面有单词课或以「库课」开头的课程目录」为准，否则会命中错目录。
 * @returns 课程 data 目录绝对路径
 */
export function dataRoot(): string {
  const isCourseData = (d: string): boolean => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).some(
        (e) => e.isDirectory() && (e.name === '刘晓燕单词课' || /^库课/.test(e.name)),
      );
    } catch {
      return false;
    }
  };
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const p = path.join(dir, 'data');
    if (isCourseData(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromDist = path.resolve(__dirname, '../../../data');
  if (isCourseData(fromDist)) return fromDist;
  throw new Error(`找不到课程 data 目录（cwd=${process.cwd()}）`);
}

/** 清洗视频展示名：去扩展名、数字编号前缀、下载重复后缀 */
function cleanName(filename: string): string {
  return filename
    .replace(/\.mp4$/i, '')
    .replace(/^\s*\d+[.、_-]\s*/, '')
    .replace(/\(\d+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 自然排序：【01】基础精讲 < 【02】… < part10 而非 part2 乱入 */
function naturalKey(s: string): Array<number | string> {
  return s.split(/(\d+)/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

/** 用自然排序键比较两个名字（数字段按数值、其余按中文 locale） */
function cmpName(a: string, b: string): number {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
    const x = ka[i] ?? 0;
    const y = kb[i] ?? 0;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else {
      const c = String(x).localeCompare(String(y), 'zh-CN');
      if (c) return c;
    }
  }
  return 0;
}

/** 下载临时文件对应的正式文件名；不是这类文件返回 null */
function tempVideoBase(name: string): string | null {
  const m = TEMP_VIDEO_RE.exec(name);
  return m ? m[1] : null;
}

/** 完整 mp4，或「内容已是完整 MP4、只是百度网盘还没重命名」的临时文件 */
function isVideo(name: string): boolean {
  if (name.startsWith('.')) return false;
  return /\.mp4$/i.test(name) || tempVideoBase(name) !== null;
}

/**
 * 递归扫描目录生成课程树：纳入完整 mp4 与「已下载完整、只是没重命名」的临时文件，
 * 跳过 0 字节、仍在写入、已有正式版的残留，并递归统计每组的视频数与总大小。
 */
async function scan(absDir: string, relDir: string): Promise<LessonGroup> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const children: LessonGroup[] = [];
  const videos: VideoLesson[] = [];
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      // 目录名以「.」开头的（下载临时目录）跳过
      if (!e.name.startsWith('.')) children.push(await scan(abs, rel));
    } else if (e.isFile() && isVideo(e.name)) {
      const tempBase = tempVideoBase(e.name);
      try {
        const st = await fsp.stat(abs);
        // 0 字节占位（还没开始下）不展示
        if (!st.size) continue;
        // 正式 mp4 已经存在时，别把下载残留再算成一节课
        if (tempBase && fs.existsSync(path.join(absDir, tempBase))) continue;
        // 仍在被写入的临时文件不展示，避免点开播不动；静置 2 分钟以上视为已下载完
        if (tempBase && Date.now() - st.mtimeMs < 2 * 60_000) continue;
        videos.push({
          file: rel,
          name: cleanName(tempBase ?? e.name),
          sizeMb: Math.round(st.size / 1024 / 1024),
        });
      } catch {
        /* 文件正在被写、stat 失败：跳过，下次扫描会出现 */
      }
    }
  }

  children.sort((a, b) => cmpName(a.name, b.name));
  videos.sort((a, b) => cmpName(a.name, b.name));
  const count = videos.length + children.reduce((sum, c) => sum + c.count, 0);
  const totalMb = videos.reduce((sum, v) => sum + v.sizeMb, 0) + children.reduce((sum, c) => sum + c.totalMb, 0);
  return { name: path.basename(relDir), path: relDir, children, videos, count, totalMb };
}

/** 递归去掉没有任何视频的空分组（例如只放 PDF 讲义的目录） */
function pruneEmptyGroups(g: LessonGroup): LessonGroup | null {
  const children = g.children.map(pruneEmptyGroups).filter((x): x is LessonGroup => x !== null);
  if (!children.length && !g.videos.length) return null;
  return { ...g, children };
}

/**
 * 扫描外部 E 盘课程目录，路径带 external: 前缀以区别于项目内 data 目录。
 * @returns 外部课程的分组、视频数与总大小；目录不存在或无视频返回 null
 */
async function scanExternalCourse(): Promise<{ groups: LessonGroup[]; count: number; totalMb: number } | null> {
  try {
    if (!fs.existsSync(EXTERNAL_COURSE_ROOT)) return null;
    const tree = await scan(EXTERNAL_COURSE_ROOT, `${EXTERNAL_PREFIX}刘晓燕英语`);
    const groups: LessonGroup[] = tree.children
      .map(pruneEmptyGroups)
      .filter((x): x is LessonGroup => x !== null);
    if (tree.videos.length) {
      groups.unshift({
        name: '课程视频',
        path: tree.path,
        children: [],
        videos: tree.videos,
        count: tree.videos.length,
        totalMb: tree.videos.reduce((s, v) => s + v.sizeMb, 0),
      });
    }
    if (!groups.length) return null;
    return { groups, count: tree.count, totalMb: tree.totalMb };
  } catch (err) {
    logger.warn({ err: String(err), root: EXTERNAL_COURSE_ROOT }, '[lessons] external course scan failed');
    return null;
  }
}

/**
 * 扫描全部课程：项目内 data 三阶段课程 + E 盘外部课程（并入「刘晓燕英语」），
 * 按 stage 顺序返回课程树（含分组、视频数、总大小）。
 * @returns 课程列表
 */
export async function listCourses(): Promise<Course[]> {
  const external = await scanExternalCourse();
  const root = dataRoot();
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const courses: Course[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || EXCLUDED.has(e.name)) continue;
    const rel = e.name;
    // 空目录（还没下载完）也保留，让前端展示「整理中」状态
    const tree = await scan(path.join(root, rel), rel);
    const meta = COURSE_META[rel];
    // 去掉「课程根目录」这一层冗余：目录树直接从子分类开始展示
    const groups: LessonGroup[] = [...tree.children];
    if (tree.videos.length) {
      groups.unshift({
        name: '课程视频', path: tree.path, children: [], videos: tree.videos,
        count: tree.videos.length, totalMb: tree.videos.reduce((s, v) => s + v.sizeMb, 0),
      });
    }
    let count = tree.count;
    let totalMb = tree.totalMb;
    // E 盘的刘晓燕语法/解题/阅读等内容并入同一门「刘晓燕英语」
    if (rel === '刘晓燕单词课' && external) {
      groups.push(...external.groups);
      // 按「单词打底 → 语法 → 解题 → 阅读」的学习顺序：单词 Unit 在前，E 盘分组在后
      groups.sort((a, b) => {
        const aExt = a.path.startsWith(EXTERNAL_PREFIX);
        const bExt = b.path.startsWith(EXTERNAL_PREFIX);
        if (aExt !== bExt) return aExt ? 1 : -1;
        return cmpName(a.name, b.name);
      });
      count += external.count;
      totalMb += external.totalMb;
    }
    courses.push({
      id: rel,
      name: meta?.name ?? cleanName(rel),
      stage: meta?.stage ?? 99,
      subject: meta?.subject ?? '拓展',
      tagline: meta?.tagline ?? '',
      tone: meta?.tone ?? 'extra',
      count,
      totalMb,
      groups,
    });
  }
  // 三阶段按 stage 排列，未配置的新课程排在后面（同名再按名称稳定排序）
  courses.sort((a, b) => a.stage - b.stage || cmpName(a.name, b.name));
  return courses;
}

/** 只放行 mp4；百度网盘没重命名的「xxx.mp4.xxx.downloading」内容也是 MP4，同样可播 */
function isPlayableVideo(abs: string): boolean {
  return /\.mp4$/i.test(abs) || TEMP_VIDEO_RE.test(path.basename(abs));
}

/**
 * 把前端传来的相对路径解析成绝对路径，挡住目录穿越和非视频文件；external: 前缀走 E 盘根目录。
 * @param rel 相对 data（或 external:）的视频路径
 * @returns 合法存在的绝对路径，否则 null
 */
export function resolveLessonFile(rel: string): string | null {
  if (!rel) return null;
  if (rel.startsWith(EXTERNAL_PREFIX)) {
    const rest = rel.slice(EXTERNAL_PREFIX.length).replace(/^[^/]+\//, '');
    const root = path.resolve(EXTERNAL_COURSE_ROOT);
    const abs = path.resolve(root, rest);
    if (!abs.startsWith(root + path.sep)) return null;
    if (!isPlayableVideo(abs)) return null;
    return fs.existsSync(abs) ? abs : null;
  }
  const root = dataRoot();
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (!isPlayableVideo(abs)) return null;
  return fs.existsSync(abs) ? abs : null;
}
