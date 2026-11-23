/**
 * 知识库入库：解析 md / txt / pdf → 500 字切块（50 字重叠）→ 考点标注 → Embedding → PostgreSQL。
 *
 * 用法：
 *   npm run ingest
 *   npm run ingest -- --dir data/kb --no-tag
 *   npm run ingest -- --file data/kb/math/极限.md --subject math
 */
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../apps/server/src/db/pool';
import { ingestDocument } from '../apps/server/src/services/rag';
import { logger } from '../apps/server/src/lib/logger';

const SUBJECTS = new Set(['math', 'english', 'cs']);

interface Args {
  dir: string;
  file?: string;
  subject?: string;
  tagging: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { dir: 'data/kb', tagging: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' && argv[i + 1]) args.dir = argv[++i];
    else if (a.startsWith('--dir=')) args.dir = a.slice(6);
    else if (a === '--file' && argv[i + 1]) args.file = argv[++i];
    else if (a.startsWith('--file=')) args.file = a.slice(7);
    else if (a === '--subject' && argv[i + 1]) args.subject = argv[++i];
    else if (a.startsWith('--subject=')) args.subject = a.slice(10);
    else if (a === '--no-tag') args.tagging = false;
  }
  return args;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(md|txt|pdf)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

async function readDocument(file: string): Promise<string> {
  if (/\.pdf$/i.test(file)) {
    // pdf-parse 的入口在无父模块时会执行调试代码，这里直接引用内部实现
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (buf: Buffer) => Promise<{ text: string }>;
    const parsed = await pdfParse(fs.readFileSync(file));
    return parsed.text ?? '';
  }
  return fs.readFileSync(file, 'utf8');
}

function inferSubject(file: string, root: string, explicit?: string): string | null {
  if (explicit) return explicit;
  const rel = path.relative(root, file).split(path.sep);
  if (rel.length > 1 && SUBJECTS.has(rel[0])) return rel[0];
  const name = path.basename(file).toLowerCase();
  for (const s of SUBJECTS) if (name.includes(s)) return s;
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const root = path.resolve(process.cwd(), args.dir);
  if (!fs.existsSync(root)) {
    console.error(`[ingest] 目录不存在：${root}`);
    process.exitCode = 1;
    return;
  }

  const files = args.file ? [path.resolve(process.cwd(), args.file)] : walk(root);
  if (files.length === 0) {
    console.warn(`[ingest] ${root} 下没有 md/txt/pdf 文件`);
    return;
  }

  console.log(`[ingest] 准备处理 ${files.length} 个文件，考点标注=${args.tagging ? '开启' : '关闭'}`);
  let totalChunks = 0;
  let totalTagged = 0;
  let failed = 0;

  for (const file of files) {
    const subject = inferSubject(file, root, args.subject);
    if (!subject || !SUBJECTS.has(subject)) {
      console.warn(`[ingest] 无法判断科目，跳过：${path.relative(process.cwd(), file)}（可用 --subject 指定）`);
      continue;
    }
    try {
      const content = await readDocument(file);
      if (!content.trim()) {
        console.warn(`[ingest] 文档为空，跳过：${file}`);
        continue;
      }
      const sourceName = path.relative(root, file).split(path.sep).join('/');
      const result = await ingestDocument({
        subject,
        content,
        sourceName,
        tagging: args.tagging,
      });
      totalChunks += result.chunks;
      totalTagged += result.kpTagged;
      console.log(
        `[ingest] ${subject} · ${sourceName} → ${result.chunks} 块（${result.kpTagged} 块已标考点）`,
      );
    } catch (err) {
      failed += 1;
      logger.error(
        { event: 'kb.ingest_failed', file, err: (err as Error).message },
        '[ingest] document failed',
      );
      console.error(`[ingest] 失败：${path.relative(process.cwd(), file)}：${(err as Error).message}`);
    }
  }

  console.log(`\n===== 入库结果 =====`);
  console.log(`切块总数：${totalChunks}，已标注考点：${totalTagged}，失败文件：${failed}`);
  if (failed > 0) process.exitCode = 1;
}

void main()
  .catch((err) => {
    console.error('[ingest] 致命错误：', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
