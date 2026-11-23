<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import NavIcon from '@/components/NavIcon.vue';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const showPassword = ref(false);
const localError = ref('');

/**
 * 登录表单提交处理器，点击「进入学习空间」或表单回车时触发。
 * 先做账号密码非空校验（为空则写入 localError 并终止），再调用 auth.signIn 发起登录请求；成功后跳转到 redirect 查询参数指定的路由，缺省为 /chat/math。
 */
async function submit() {
  localError.value = '';
  if (!username.value.trim() || !password.value) {
    localError.value = '请输入账号和密码';
    return;
  }
  const ok = await auth.signIn(username.value, password.value);
  if (ok) {
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/chat/math';
    router.replace(redirect);
  }
}

const subjects = [
  { name: '高等数学', note: '62 考点 · 极限到级数', mark: '数' },
  { name: '大学英语', note: '语法 · 阅读 · 写作', mark: '英' },
  { name: '计算机基础', note: '数据结构 · 网络 · 数据库', mark: '算' },
];
</script>

<template>
  <div class="login-shell">
    <section class="login-brand">
      <div class="brand-top">
        <div class="brand-seal large">湘</div>
        <div>
          <div class="brand-name light">湘学伴</div>
          <div class="brand-sub">Adaptive Tutor · 湖南专升本</div>
        </div>
      </div>

      <div class="hero-copy">
        <div class="eyebrow light">基于大语言模型 Agent</div>
        <h1>不是把答案递给你，<br />而是把下一步找出来。</h1>
        <p>
          答疑解惑带出处，错题自动生成 L1/L2/L5 变式，三科教师各有风格，
          全局画像跨科目记住你的薄弱与情绪。
        </p>
      </div>

      <div class="subject-list">
        <div v-for="s in subjects" :key="s.name" class="subject-chip">
          <span class="subject-mark">{{ s.mark }}</span>
          <div>
            <div class="subject-name">{{ s.name }}</div>
            <div class="subject-note">{{ s.note }}</div>
          </div>
        </div>
      </div>

      <div class="brand-foot">
        <span>湖南专升本 · 数学 / 英语 / 计算机</span>
        <span class="dot" />
        <span>知识库 + 错题闭环 + 消融评测</span>
      </div>
    </section>

    <section class="login-form-wrap">
      <form class="login-card" @submit.prevent="submit">
        <div class="lock-mark">
          <NavIcon name="spark" :size="22" />
        </div>
        <h2>登录学习空间</h2>
        <p class="login-sub">单账号系统，账号与密码由服务端 <code>.env</code> 配置。</p>

        <div v-if="localError || auth.error" class="banner banner-error login-error">
          {{ localError || auth.error }}
        </div>

        <div class="field">
          <label class="label" for="username">账号</label>
          <input
            id="username"
            v-model="username"
            class="input"
            type="text"
            autocomplete="username"
            placeholder="请输入账号"
            :disabled="auth.loading"
          />
        </div>

        <div class="field">
          <label class="label" for="password">密码</label>
          <div class="password-wrap">
            <input
              id="password"
              v-model="password"
              class="input"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder="请输入密码"
              :disabled="auth.loading"
            />
            <button type="button" class="peek" @click="showPassword = !showPassword">
              {{ showPassword ? '隐藏' : '显示' }}
            </button>
          </div>
        </div>

        <button class="btn btn-primary btn-lg submit" type="submit" :disabled="auth.loading">
          <span v-if="auth.loading" class="spinner spinner-light" />
          <span>{{ auth.loading ? '正在登录…' : '进入学习空间' }}</span>
          <NavIcon v-if="!auth.loading" name="arrow-right" :size="17" />
        </button>

        <div class="login-tips">
          <span>登录接口限流 10 次/分钟</span>
          <span>token 仅存于本机 localStorage</span>
        </div>
      </form>

      <p class="footer-note">湘学伴 · 让每一道错题都有下文</p>
    </section>
  </div>
</template>

<style scoped>
.login-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
}

.login-brand {
  position: relative;
  padding: 44px clamp(32px, 5vw, 78px) 36px;
  background:
    radial-gradient(800px 500px at 85% 12%, rgba(180, 95, 59, 0.2), transparent 60%),
    radial-gradient(700px 500px at 0% 100%, rgba(63, 130, 108, 0.18), transparent 65%),
    #172522;
  color: #ece6d8;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.login-brand::after {
  content: "";
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.02) 0 1px, transparent 1px 4px);
  pointer-events: none;
}

.brand-top {
  display: flex;
  align-items: center;
  gap: 13px;
  position: relative;
  z-index: 1;
}

.brand-seal.large {
  width: 48px;
  height: 48px;
  font-size: 26px;
  background: #f0e8d6;
}
.brand-name.light {
  color: #f4efe4;
}

.hero-copy {
  margin: auto 0;
  padding: 48px 0 36px;
  max-width: 560px;
  position: relative;
  z-index: 1;
}

.eyebrow.light {
  color: #d5a184;
}

.hero-copy h1 {
  color: #f6f1e5;
  font-size: clamp(30px, 3.6vw, 46px);
  line-height: 1.28;
  letter-spacing: -0.02em;
  margin: 10px 0 20px;
}

.hero-copy p {
  color: rgba(236, 230, 216, 0.68);
  font-size: 14.5px;
  line-height: 1.9;
  max-width: 460px;
  margin: 0;
}

.subject-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  position: relative;
  z-index: 1;
}

.subject-chip {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 13px 12px;
  border: 1px solid rgba(236, 230, 216, 0.14);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
}

.subject-mark {
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-family: var(--serif);
  background: rgba(240, 232, 214, 0.12);
  color: #f0e8d6;
}

.subject-name {
  font-size: 13px;
  color: #f0eadc;
}
.subject-note {
  font-size: 11px;
  color: rgba(236, 230, 216, 0.48);
  margin-top: 2px;
}

.brand-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 30px;
  font-size: 11px;
  color: rgba(236, 230, 216, 0.4);
  letter-spacing: 0.04em;
  position: relative;
  z-index: 1;
}
.dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
}

.login-form-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 24px;
  background:
    radial-gradient(700px 400px at 80% 0%, rgba(180, 95, 59, 0.08), transparent 60%),
    var(--bg);
}

.login-card {
  width: 100%;
  max-width: 420px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 38px 36px 30px;
  box-shadow: var(--shadow-lift);
  animation: fade-up 0.45s ease both;
}

.lock-mark {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-dark);
  margin-bottom: 18px;
}

.login-card h2 {
  font-size: 25px;
  letter-spacing: -0.01em;
}

.login-sub {
  color: var(--muted);
  font-size: 13px;
  margin: 7px 0 24px;
}
.login-sub code {
  font-family: var(--mono);
  font-size: 11.5px;
  background: #f1ece1;
  padding: 1px 5px;
  border-radius: 4px;
}

.login-error {
  margin-bottom: 16px;
}

.password-wrap {
  position: relative;
}
.password-wrap .input {
  padding-right: 58px;
}
.peek {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 6px;
}
.peek:hover {
  color: var(--accent);
}

.submit {
  width: 100%;
  margin-top: 6px;
}

.login-tips {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 18px;
  font-size: 10.5px;
  color: #9aa19b;
  border-top: 1px dashed var(--line);
  padding-top: 14px;
}

.footer-note {
  margin-top: 22px;
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: 0.08em;
}

@media (max-width: 920px) {
  .login-shell {
    grid-template-columns: 1fr;
  }
  .login-brand {
    padding: 30px 26px 26px;
    min-height: auto;
  }
  .hero-copy {
    padding: 32px 0 26px;
    margin: 0;
  }
  .hero-copy h1 {
    font-size: 31px;
  }
  .subject-list {
    display: none;
  }
  .brand-foot {
    display: none;
  }
  .login-form-wrap {
    padding: 30px 18px 46px;
  }
  .login-card {
    padding: 28px 24px 24px;
  }
}
</style>
