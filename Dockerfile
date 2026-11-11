FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p data/prices data/reports data/media && chown -R node:node data
# 线上模式：服务器不存任何 key，全部由使用者在网页上填
ENV HOSTED=1 NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
