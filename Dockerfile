# 名片扫描助手 - Docker 镜像
FROM node:18-alpine

WORKDIR /app

# 只复制必需文件
COPY package.json package-lock.json ./
RUN npm ci --production

COPY server.js index.html ./

EXPOSE 3200

CMD ["node", "server.js"]
