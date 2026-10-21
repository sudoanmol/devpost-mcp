FROM oven/bun:1.4.0-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
# bake the embedding model into the image so the server never downloads it at runtime
RUN bun -e 'import { embed } from "./src/embeddings"; await embed(["warm up"])'
CMD ["bun", "src/index.ts"]
