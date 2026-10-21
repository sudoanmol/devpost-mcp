FROM oven/bun:1.4.0-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
CMD ["bun", "src/index.ts"]
