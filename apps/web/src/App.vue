<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useUserStore } from '@/stores/user';
import NavIcon from '@/components/NavIcon.vue';
import UserAvatar from '@/components/UserAvatar.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const user = useUserStore();

const isPublic = computed(() => Boolean(route.meta.public));
const currentPath = computed(() => route.path);

const navItems = [
  { key: 'chat', to: '/chat/math', label: '答疑解惑', icon: 'chat', match: (p: string) => p.startsWith('/chat') },
  { key: 'wrongbook', to: '/wrongbook', label: '错题本', icon: 'book', match: (p: string) => p.startsWith('/wrongbook') || p.startsWith('/practice') },
  { key: 'exam', to: '/exam', label: '模拟卷', icon: 'exam', match: (p: string) => p.startsWith('/exam') },
  { key: 'vocab', to: '/vocab', label: '单词', icon: 'word', match: (p: string) => p.startsWith('/vocab') },
  { key: 'listen', to: '/listen', label: '全套学习流程', icon: 'play', match: (p: string) => p.startsWith('/listen') },
  { key: 'notes', to: '/notes', label: '学习笔记', icon: 'note', match: (p: string) => p.startsWith('/notes') },
  { key: 'profile', to: '/profile', label: '学习画像', icon: 'profile', match: (p: string) => p.startsWith('/profile') },
  { key: 'eval', to: '/eval', label: '科目考试评测', icon: 'eval', match: (p: string) => p.startsWith('/eval') },
];

function onForcedLogout() {
  auth.handleForcedLogout();
  router.replace({ name: 'login' });
}

async function signOut() {
  await auth.signOut();
  router.replace({ name: 'login' });
}

onMounted(() => {
  auth.sync();
  void user.load();
  window.addEventListener('tutor:logout', onForcedLogout);
});
// 登录成功后加载昵称/头像偏好（含首次登录后进入主界面）
watch(
  () => auth.authenticated,
  (authed) => {
    if (authed) void user.load(true);
  },
);
onBeforeUnmount(() => {
  window.removeEventListener('tutor:logout', onForcedLogout);
});
</script>

<template>
  <router-view v-if="isPublic" />

  <div v-else class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-seal">湘</div>
        <div class="brand-text">
          <div class="brand-name">湘学伴</div>
          <div class="brand-sub">Adaptive Tutor</div>
        </div>
      </div>

      <nav class="nav" aria-label="主导航">
        <div class="nav-label">学习空间</div>
        <router-link
          v-for="item in navItems"
          :key="item.key"
          :to="item.to"
          class="nav-item"
          :class="{ 'router-link-active': item.match(currentPath) }"
        >
          <span class="nav-icon"><NavIcon :name="item.icon" :size="19" /></span>
          <span class="nav-text">{{ item.label }}</span>
        </router-link>
      </nav>

      <div class="sidebar-foot">
        <router-link to="/settings" class="user-chip" :class="{ active: currentPath.startsWith('/settings') }">
          <UserAvatar :size="34" class="user-avatar" />
          <div class="user-meta">
            <div class="user-name">{{ user.displayName }}</div>
            <div class="user-role">湖南专升本 · 三科备考</div>
          </div>
          <NavIcon name="arrow-right" :size="14" class="chip-arrow" />
        </router-link>
        <button class="logout-btn" type="button" @click="signOut">
          <NavIcon name="logout" :size="15" />
          <span>退出登录</span>
        </button>
      </div>
    </aside>

    <main class="main">
      <router-view v-slot="{ Component }">
        <transition name="page" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
  </div>
</template>
