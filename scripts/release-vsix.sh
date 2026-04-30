#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "用法: ./scripts/release-vsix.sh <version>"
  echo "示例: ./scripts/release-vsix.sh 0.4.14"
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "版本号格式无效: $VERSION"
  echo "支持: x.y.z 或 x.y.z-beta.1"
  exit 1
fi

echo "==> 更新 package.json 版本: $VERSION"
node -e "
const fs = require('fs');
const path = 'package.json';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.version = process.argv[1];
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
" "$VERSION"

echo "==> 安装依赖（若已安装会很快跳过）"
npm install

echo "==> 编译 TypeScript"
npm run compile

OUT_FILE="traderx-${VERSION}.vsix"
echo "==> 打包 VSIX: ${OUT_FILE}"
npx @vscode/vsce package --out "$OUT_FILE"

echo
echo "完成: ${ROOT_DIR}/${OUT_FILE}"
