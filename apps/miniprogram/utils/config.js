module.exports = {
  // 电脑局域网地址：小程序真机预览必须用这个，不能用 localhost
  // 换电脑或换 Wi-Fi 后要同步改这里，并确保手机与电脑在同一网段
  BASE_URL: 'http://192.168.1.101:8849',

  // 演示账号：请在本机 .env 的 AUTH_USERNAME / AUTH_PASSWORD 配置，不要写进仓库
  DEMO_USER: {
    username: process.env.AUTH_USERNAME || 'student',
    password: process.env.AUTH_PASSWORD || 'change-me',
  },

  // 语音识别：需先在微信公众平台「设置-第三方设置-插件管理」添加"微信同声传译"，
  // 再把 app.json 的 plugins 段（见 README）加回来，最后把这里改成 true
  USE_VOICE_PLUGIN: false,

  SUBJECTS: [
    { key: 'math', label: '高等数学' },
    { key: 'english', label: '大学英语' },
    { key: 'cs', label: '计算机' },
  ],
}
