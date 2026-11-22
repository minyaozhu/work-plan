FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY core ./core
COPY mcp ./mcp
COPY ui/app.html ./ui/app.html

RUN mkdir -p /data

ENTRYPOINT ["node", "bin/run.mjs", "mcp/server.mjs", "--data-dir", "/data"]
