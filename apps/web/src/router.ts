import { createRouter, createWebHistory } from 'vue-router';
import { getAccessToken } from '@/api/client';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true, title: '登录' },
    },
    {
      path: '/m/snap',
      name: 'snap',
      component: () => import('@/views/SnapView.vue'),
      meta: { public: true, title: '拍题' },
    },
    {
      path: '/m/exam/:id',
      name: 'exam-snap',
      component: () => import('@/views/ExamSnapView.vue'),
      meta: { public: true, title: '答题卡上传' },
    },
    { path: '/', redirect: '/chat/math' },
    {
      path: '/chat/:subject(math|english|cs)',
      name: 'chat',
      component: () => import('@/views/ChatView.vue'),
      meta: { title: '答疑解惑' },
    },
    {
      path: '/wrongbook',
      name: 'wrongbook',
      component: () => import('@/views/WrongbookView.vue'),
      meta: { title: '错题本' },
    },
    {
      path: '/practice/:id',
      name: 'practice',
      component: () => import('@/views/PracticeView.vue'),
      meta: { title: '做题' },
    },
    {
      path: '/exam',
      name: 'exam',
      component: () => import('@/views/ExamView.vue'),
      meta: { title: '模拟卷' },
    },
    {
      path: '/vocab',
      name: 'vocab',
      component: () => import('@/views/VocabView.vue'),
      meta: { title: '单词' },
    },
    {
      path: '/listen',
      name: 'listen',
      component: () => import('@/views/ListenView.vue'),
      meta: { title: '全套学习流程' },
    },
    {
      path: '/notes',
      name: 'notes',
      component: () => import('@/views/NotesView.vue'),
      meta: { title: '学习笔记' },
    },
    {
      path: '/profile',
      name: 'profile',
      component: () => import('@/views/ProfileView.vue'),
      meta: { title: '学习画像' },
    },
    {
      path: '/eval',
      name: 'eval',
      component: () => import('@/views/EvalView.vue'),
      meta: { title: '科目考试评测' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { title: '个人主页' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/chat/math' },
  ],
  /** 路由切换后滚动回顶部 */
  scrollBehavior() {
    return { top: 0 };
  },
});

/** 全局守卫：按 meta.title 设置页面标题，未登录访问非公开页跳转登录并记录 redirect */
router.beforeEach((to) => {
  const authed = Boolean(getAccessToken());
  document.title = `${String(to.meta.title ?? '学习')} · 湘学伴`;
  if (!to.meta.public && !authed) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'login' && authed) {
    return { path: '/chat/math' };
  }
  return true;
});

export default router;
