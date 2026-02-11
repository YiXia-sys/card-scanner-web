#!/bin/bash
# ============================================
#  名片扫描助手 - 阿里云一键部署脚本
#  使用方法：登录服务器后粘贴执行
# ============================================
set -e

echo "========================================"
echo "  名片扫描助手 - 开始部署"
echo "========================================"

# 1. 安装 Node.js 20.x
echo "[1/5] 安装 Node.js..."
if command -v node &> /dev/null; then
  echo "  Node.js 已安装: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  echo "  Node.js 安装完成: $(node -v)"
fi

# 2. 安装 PM2（进程管理，开机自启）
echo "[2/5] 安装 PM2 进程管理器..."
npm install -g pm2 2>/dev/null || true
echo "  PM2 版本: $(pm2 -v)"

# 3. 创建应用目录
echo "[3/5] 创建应用目录..."
APP_DIR=/opt/card-scanner
mkdir -p $APP_DIR
cd $APP_DIR

# 4. 从 GitHub 拉取代码
echo "[4/5] 拉取代码..."
if [ -d ".git" ]; then
  git pull origin master
else
  git clone https://github.com/YiXia-sys/card-scanner-web.git .
fi

# 5. 启动服务
echo "[5/5] 启动服务..."
pm2 delete card-scanner 2>/dev/null || true
pm2 start server.js --name card-scanner
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# 获取公网 IP
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "你的公网IP")

echo ""
echo "========================================"
echo "  部署完成！"
echo "  访问地址: http://${PUBLIC_IP}:3200"
echo "========================================"
echo "  常用命令:"
echo "    pm2 logs card-scanner   # 查看日志"
echo "    pm2 restart card-scanner # 重启服务"
echo "    pm2 status              # 查看状态"
echo "========================================"
