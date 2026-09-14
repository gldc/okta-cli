# syntax=docker/dockerfile:1
FROM oven/bun:1.3.5 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build --compile src/main.ts --outfile /out/okta-cli

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/okta-cli /usr/local/bin/okta-cli
# The MCP server keeps OAuth access tokens in memory only; nothing is written to $HOME.
ENV OKTA_CLI_NO_TOKEN_CACHE=1 OKTA_MCP_HOST=0.0.0.0 OKTA_MCP_PORT=8000 OKTA_MCP_READ_ONLY=1 HOME=/tmp
USER 65532:65532
EXPOSE 8000
ENTRYPOINT ["okta-cli"]
CMD ["mcp", "serve"]
