FROM oven/bun:1.3.5

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ENTRYPOINT ["bun", "src/main.ts"]
