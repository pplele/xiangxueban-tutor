<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { API_BASE, errorMessage, get, post, put, del } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useUserStore } from '@/stores/user';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';
import NavIcon from '@/components/NavIcon.vue';
import UserAvatar from '@/components/UserAvatar.vue';

interface Field {
  key: string;
  label: string;
  placeholder?: string;
  secret: boolean;
  hint?: string;
  value: string;
  masked: string;
  hasValue: boolean;
}
interface Group {
  key: string;
  title: string;
  desc: string;
  testTarget?: string;
  fields: Field[];
}
interface MobileAccess {
  url: string;
  qrDataUrl: string;
  lanIps: string[];
  frontPort: number;
}

const router = useRouter();
const auth = useAuthStore();
const user = useUserStore();

const loading = ref(true);
const error = ref('');
const saving = ref(false);
const notice = ref('');
const noticeOk = ref(false);

const groups = ref<Group[]>([]);
/** 只放用户在输入框里实际敲的值；密钥留空 = 不修改 */
const draft = ref<Record<string, string>>({});
const testState = ref<Record<string, { loading: boolean; ok: boolean; message: string }>>({});

const mobile = ref<MobileAccess | null>(null);
const mobileLoading = ref(false);

// ===== 昵称与头像 =====
const nicknameDraft = ref('');
const savingNickname = ref(false);
const uploadingAvatar = ref(false);

/**
 * 把用户资料中的昵称同步到昵称输入框草稿；昵称缺失时回退到登录账号名。
 */
function syncProfileDraft() {
  nicknameDraft.value = user.nickname || auth.username || '';
}

/**
 * 保存昵称处理器，点击昵称后的「保存」按钮或输入框回车时触发。
 * 调用 PUT /prefs/nickname 持久化新昵称，成功后同步到本地用户状态并提示。
 */
async function saveNickname() {
  if (savingNickname.value) return;
  savingNickname.value = true;
  try {
    const res = await put<{ nickname: string; avatar: unknown }>('/prefs/nickname', {
      nickname: nicknameDraft.value.trim(),
    });
    user.setLocal(res.nickname, user.avatar);
    flash('昵称已更新');
  } catch (err) {
    flash(errorMessage(err), false);
  } finally {
    savingNickname.value = false;
  }
}

/**
 * 选择预设 emoji 头像处理器，点击某个 emoji 头像按钮时触发。
 * 调用 PUT /prefs/avatar/emoji 将头像类型与取值、背景色保存到服务端。
 * @param emoji 选中的 emoji 字符
 * @param bg 头像背景色
 */
async function chooseEmoji(emoji: string, bg: string) {
  try {
    const res = await put<{ nickname: string; avatar: { type: 'emoji'; value: string; bg: string } }>(
      '/prefs/avatar/emoji',
      { emoji, bg },
    );
    user.setLocal(res.nickname, res.avatar);
    flash('头像已更新');
  } catch (err) {
    flash(errorMessage(err), false);
  }
}

/**
 * 上传自定义头像处理器，文件选择框 change 时触发。
 * 先校验类型（PNG/JPG/WEBP）与大小（≤1.5MB），再用 FileReader 读成 DataURL，调用 PUT /prefs/avatar/image 上传。
 * @param event 文件输入框的 change 事件
 */
async function onAvatarFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    flash('只支持 PNG / JPG / WEBP 图片', false);
    return;
  }
  if (file.size > 1.5 * 1024 * 1024) {
    flash('图片超过 1.5MB，请先压缩', false);
    return;
  }
  uploadingAvatar.value = true;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
    const res = await put<{ nickname: string; avatar: { type: 'image'; file: string; mime: string } }>(
      '/prefs/avatar/image',
      { dataUrl },
    );
    user.setLocal(res.nickname, res.avatar);
    flash('头像已更新');
  } catch (err) {
    flash(errorMessage(err), false);
  } finally {
    uploadingAvatar.value = false;
    input.value = '';
  }
}

/**
 * 恢复默认头像处理器，点击「恢复默认」按钮时触发。
 * 调用 DELETE /prefs/avatar 清除服务端头像配置并同步本地用户状态。
 */
async function resetAvatar() {
  try {
    const res = await del<{ nickname: string; avatar: null }>('/prefs/avatar');
    user.setLocal(res.nickname, res.avatar);
    flash('已恢复默认头像');
  } catch (err) {
    flash(errorMessage(err), false);
  }
}

/**
 * 刷新手机拍题入口处理器，点击「刷新」按钮时触发。
 * 调用 GET /settings/mobile 由后端按当前局域网 IP 重新生成访问地址与二维码。
 */
async function loadMobile() {
  mobileLoading.value = true;
  try {
    mobile.value = await get<MobileAccess>('/settings/mobile');
  } catch {
    mobile.value = null;
  } finally {
    mobileLoading.value = false;
  }
}

/**
 * 页面数据加载函数，组件挂载后由 onMounted 调用，也用于错误态重试。
 * 并行请求系统配置、手机访问信息并强制刷新用户资料，随后填充配置草稿与昵称草稿。
 */
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [cfg, m] = await Promise.all([
      get<{ groups: Group[] }>('/settings'),
      get<MobileAccess>('/settings/mobile'),
      user.load(true),
    ]);
    groups.value = cfg.groups;
    draft.value = Object.fromEntries(
      cfg.groups.flatMap((g) => g.fields.filter((f) => !f.secret).map((f) => [f.key, f.value])),
    );
    mobile.value = m;
    syncProfileDraft();
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

/**
 * 在页面顶部显示一条临时提示，4 秒后自动消失（若期间出现新提示则不清除新内容）。
 * @param msg 提示文案
 * @param ok 是否为成功样式，默认 true；false 显示错误样式
 */
function flash(msg: string, ok = true) {
  notice.value = msg;
  noticeOk.value = ok;
  window.setTimeout(() => {
    if (notice.value === msg) notice.value = '';
  }, 4000);
}

/**
 * 保存模型 API 配置处理器，点击「保存修改」按钮时触发。
 * 汇总草稿中的配置项（密钥留空表示沿用原值不提交），调用 PUT /settings 使配置立即生效。
 */
async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    const values: Record<string, string> = {};
    for (const g of groups.value) {
      for (const f of g.fields) {
        const v = (draft.value[f.key] ?? '').trim();
        // 密钥：留空表示沿用原值，不提交
        if (f.secret && v === '') continue;
        values[f.key] = v;
      }
    }
    const res = await put<{ groups: Group[] }>('/settings', { values });
    groups.value = res.groups;
    draft.value = Object.fromEntries(res.groups.flatMap((g) => g.fields.filter((f) => !f.secret).map((f) => [f.key, f.value])));
    flash('已保存，配置立即生效');
  } catch (err) {
    flash(errorMessage(err), false);
  } finally {
    saving.value = false;
  }
}

/**
 * 测试模型 API 连通性处理器，点击某配置项分组的「测试连接」按钮时触发。
 * 调用 POST /settings/test 发起探测请求，并把加载态与结果写入 testState 对应条目。
 * @param target 待测配置项标识（取自分组的 testTarget）
 */
async function test(target: string | undefined) {
  if (!target) return;
  testState.value = { ...testState.value, [target]: { loading: true, ok: false, message: '测试中…' } };
  try {
    const data = await post<{ ok: boolean; status: number; message: string }>('/settings/test', { target });
    testState.value = { ...testState.value, [target]: { loading: false, ok: Boolean(data.ok), message: data.message || '' } };
  } catch (err) {
    testState.value = { ...testState.value, [target]: { loading: false, ok: false, message: errorMessage(err) } };
  }
}

/**
 * 退出登录处理器，点击「退出登录」按钮时触发。
 * 调用 auth.signOut 清除登录态，随后用 router.replace 跳转回登录页（不留历史记录）。
 */
async function signOut() {
  await auth.signOut();
  router.replace({ name: 'login' });
}

onMounted(load);
</script>

<template>
  <div class="page page-wide settings-page">
    <header class="page-header">
      <div>
        <div class="eyebrow">账号与配置</div>
        <h1 class="page-title">个人主页</h1>
        <p class="page-desc">换模型 API、生成手机拍题二维码，都在这一页。</p>
      </div>
    </header>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error && !groups.length" :message="error" @retry="load" />

    <template v-else>
      <div v-if="notice" class="banner" :class="noticeOk ? 'banner-success' : 'banner-error'">{{ notice }}</div>

      <div class="settings-grid">
        <!-- 账号 -->
        <section class="card card-pad account-card">
          <UserAvatar :size="64" class="account-avatar" />
          <div class="account-name">{{ user.displayName }}</div>
          <div class="account-role">湖南专升本 · 三科备考</div>

          <!-- 昵称 -->
          <div class="profile-edit">
            <div class="profile-field-label">昵称</div>
            <div class="nickname-row">
              <input
                v-model="nicknameDraft"
                class="input"
                type="text"
                maxlength="24"
                placeholder="输入昵称"
                @keyup.enter="saveNickname"
              />
              <button class="btn btn-sm btn-primary" type="button" :disabled="savingNickname" @click="saveNickname">
                {{ savingNickname ? '…' : '保存' }}
              </button>
            </div>
          </div>

          <!-- 头像：预设 emoji -->
          <div class="profile-edit">
            <div class="profile-field-label">选择头像</div>
            <div class="avatar-presets">
              <button
                v-for="p in user.presets"
                :key="p.value"
                type="button"
                class="avatar-preset"
                :class="{ on: user.avatar?.type === 'emoji' && user.avatar.value === p.value }"
                :style="{ background: p.bg }"
                :title="p.value"
                @click="chooseEmoji(p.value, p.bg)"
              >
                {{ p.value }}
              </button>
            </div>
          </div>

          <!-- 头像：上传图片 -->
          <div class="profile-edit">
            <div class="profile-field-label">或上传图片</div>
            <label class="btn btn-sm avatar-upload">
              <NavIcon name="camera" :size="14" />
              {{ uploadingAvatar ? '上传中…' : '上传图片' }}
              <input type="file" accept="image/png,image/jpeg,image/webp" :disabled="uploadingAvatar" @change="onAvatarFile" />
            </label>
            <button
              v-if="user.avatar"
              class="btn btn-sm btn-danger-ghost avatar-reset"
              type="button"
              @click="resetAvatar"
            >
              恢复默认
            </button>
          </div>

          <div class="rule"></div>
          <dl class="account-meta">
            <dt>账号</dt>
            <dd class="mono">{{ auth.username }}</dd>
            <dt>后端地址</dt>
            <dd class="mono">{{ API_BASE }}</dd>
          </dl>
          <button class="btn logout" type="button" @click="signOut">
            <NavIcon name="logout" :size="15" />
            退出登录
          </button>
        </section>

        <!-- 模型 API -->
        <section class="card card-pad api-card">
          <div class="section-title">
            <h3>模型 API</h3>
            <button class="btn btn-sm btn-primary" type="button" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存修改' }}
            </button>
          </div>
          <p class="muted-note">改完点保存立即生效，不需要重启服务；密钥留空表示沿用原来的。</p>

          <div v-for="g in groups" :key="g.key" class="setting-group">
            <div class="group-head">
              <b>{{ g.title }}</b>
              <div class="group-actions">
                <span v-if="testState[g.testTarget || '']" class="test-result" :class="testState[g.testTarget || ''].ok ? 'ok' : 'bad'">
                  {{ testState[g.testTarget || ''].message }}
                </span>
                <button
                  v-if="g.testTarget"
                  class="btn btn-sm"
                  type="button"
                  :disabled="testState[g.testTarget]?.loading"
                  @click="test(g.testTarget)"
                >
                  测试连接
                </button>
              </div>
            </div>
            <p class="group-desc">{{ g.desc }}</p>
            <label v-for="f in g.fields" :key="f.key" class="field-row">
              <span class="field-label">{{ f.label }}</span>
              <input
                v-model="draft[f.key]"
                class="input"
                :type="f.secret ? 'password' : 'text'"
                :placeholder="f.secret && f.hasValue ? `已配置 ${f.masked}（留空不改）` : f.placeholder"
                autocomplete="off"
                spellcheck="false"
              />
            </label>
          </div>
        </section>

        <!-- 手机拍题（局域网网页版） -->
        <section class="card card-pad mini-card">
          <div class="section-title">
            <h3>手机拍题 · 局域网</h3>
            <button class="btn btn-sm" type="button" :disabled="mobileLoading" @click="loadMobile">
              {{ mobileLoading ? '生成中…' : '刷新' }}
            </button>
          </div>

          <div class="qr-wrap">
            <img v-if="mobile?.qrDataUrl" :src="mobile.qrDataUrl" class="qr-img" alt="手机拍题二维码" />
            <div v-else class="qr-empty">没能生成二维码<br /><span>检查电脑是否连着 Wi-Fi / 网线</span></div>
            <div class="qr-side">
              <p class="qr-title">手机扫码，直接打开拍题页</p>
              <p class="muted-note mono">{{ mobile?.url || '—' }}</p>
              <p class="qr-tip">
                二维码由本机局域网地址实时生成，<b>不会过期</b>；换 Wi-Fi 或电脑 IP 变了，点「刷新」重新生成即可。
                微信扫、系统相机扫都行，浏览器打开就能用，不需要装任何东西。
              </p>
            </div>
          </div>

          <ul class="mini-hints">
            <li>手机和电脑连<b>同一个 Wi-Fi</b>；电脑防火墙放行前端端口 {{ mobile?.frontPort || 5173 }}。</li>
            <li>手机上首次打开需登录一次，之后会记住；拍题、追问、存错题本和电脑端数据完全同步。</li>
            <li v-if="mobile?.lanIps.length">本机局域网地址：{{ mobile.lanIps.join(' / ') }}</li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.settings-page {
  padding-bottom: 40px;
}
.settings-grid {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  margin-top: 4px;
}
@media (max-width: 980px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
/* 小程序卡片占右栏第二行，别挤进左侧账号那一列 */
@media (min-width: 981px) {
  .mini-card {
    grid-column: 2;
  }
}
.account-card {
  text-align: center;
}
.account-avatar {
  width: 64px;
  height: 64px;
  margin: 4px auto 10px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-family: var(--serif);
  font-size: 28px;
  font-weight: 700;
}
.profile-edit {
  margin-top: 14px;
  text-align: left;
}
.profile-field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
  margin-bottom: 6px;
}
.nickname-row {
  display: flex;
  gap: 6px;
}
.nickname-row .input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  font-size: 13px;
}
.avatar-presets {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 6px;
}
.avatar-preset {
  aspect-ratio: 1;
  border: 2px solid transparent;
  border-radius: 10px;
  background: var(--accent-soft);
  font-size: 18px;
  cursor: pointer;
  transition: transform 0.14s ease, border-color 0.14s ease;
}
.avatar-preset:hover {
  transform: translateY(-2px);
}
.avatar-preset.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(30, 107, 87, 0.18);
}
.avatar-upload {
  position: relative;
  cursor: pointer;
}
.avatar-upload input[type='file'] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.avatar-reset {
  margin-left: 6px;
}
.account-name {
  font-size: 17px;
  font-weight: 600;
}
.account-role {
  font-size: 12.5px;
  color: var(--muted);
  margin-top: 3px;
}
.account-meta {
  margin: 16px 0;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 10px;
  text-align: left;
  font-size: 12.5px;
}
.account-meta dt {
  color: var(--muted);
}
.account-meta dd {
  margin: 0;
  color: var(--ink-2);
  word-break: break-all;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.mild {
  color: var(--muted);
  font-weight: 400;
}
.logout {
  width: 100%;
  justify-content: center;
}
.api-card {
  min-width: 0;
}
.setting-group {
  padding: 14px 0;
  border-top: 1px dashed var(--line);
}
.setting-group:first-of-type {
  border-top: 0;
  padding-top: 6px;
}
.group-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 14px;
}
.group-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.test-result {
  font-size: 12px;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.test-result.ok {
  color: #2f7d52;
}
.test-result.bad {
  color: #a83c33;
}
.group-desc {
  font-size: 12.5px;
  color: var(--muted);
  margin: 4px 0 10px;
}
.field-row {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}
@media (max-width: 620px) {
  .field-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
.field-label {
  font-size: 12.5px;
  color: var(--ink-2);
}
.qr-wrap {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  flex-wrap: wrap;
  padding: 6px 0 14px;
  border-bottom: 1px dashed var(--line);
}
.qr-img {
  width: 168px;
  height: 168px;
  object-fit: contain;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
  padding: 6px;
}
.qr-empty {
  width: 168px;
  height: 168px;
  display: grid;
  place-items: center;
  text-align: center;
  border: 1px dashed var(--line-strong);
  border-radius: 10px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}
.qr-empty span {
  font-size: 12px;
}
.qr-side {
  flex: 1;
  min-width: 220px;
}
.qr-title {
  font-size: 13.5px;
  font-weight: 600;
  margin-bottom: 2px;
}
.qr-tip {
  margin-top: 10px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.65;
}
.mini-hints {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.75;
}
</style>
