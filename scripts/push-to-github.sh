#!/usr/bin/env bash
# 一键创建 GitHub 仓库并推送当前项目
# 用法：GITHUB_TOKEN=你的token bash scripts/push-to-github.sh [仓库名]
# 仓库名默认是 xiangxueban-tutor
set -euo pipefail

TOKEN="${GITHUB_TOKEN:-}"
REPO="${1:-xiangxueban-tutor}"

if [ -z "$TOKEN" ]; then
  echo "错误：请设置 GITHUB_TOKEN 环境变量"
  echo "用法：GITHUB_TOKEN=ghp_xxx bash scripts/push-to-github.sh [仓库名]"
  exit 1
fi

# 从 token 推断用户名
USERNAME=$(curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/user | node -pe 'JSON.parse(require("fs").readFileSync(0)).login' 2>/dev/null || true)
if [ -z "$USERNAME" ]; then
  echo "错误：token 无效或无法读取用户名，请检查 token 权限（需要 repo 或 public_repo）"
  exit 1
fi
echo "GitHub 用户：$USERNAME，准备创建仓库：$REPO"

# 创建仓库（private 改为 false 即公开仓库）
curl -s -X POST https://api.github.com/user/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d "{\"name\":\"$REPO\",\"description\":\"湘学伴 - 基于大语言模型 Agent 的专升本个性化自适应学习系统\",\"private\":false}" \
  | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); d.html_url || (d.message ? "错误: "+d.message : "未知错误")'

# 配置远程并推送（含 embedded token，推送后清除）
git remote remove origin 2>/dev/null || true
git remote add origin "https://${TOKEN}@github.com/${USERNAME}/${REPO}.git"
git branch -M main
git push -u origin main

# 清除远程 URL 中的 token，避免明文存到 .git/config
git remote set-url origin "https://github.com/${USERNAME}/${REPO}.git"
echo ""
echo "✅ 推送完成！仓库地址：https://github.com/${USERNAME}/${REPO}"
