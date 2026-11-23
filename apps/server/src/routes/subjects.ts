import type { FastifyInstance } from 'fastify';
import { listSubjects } from '../services/meta';

/**
 * 科目路由注册：科目字典列表
 */
export async function subjectRoutes(app: FastifyInstance): Promise<void> {
  /** GET /subjects - 返回系统支持的科目列表；鉴权：需登录 */
  app.get('/subjects', async () => {
    const subjects = await listSubjects();
    return { subjects };
  });
}
