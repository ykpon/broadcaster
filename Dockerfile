FROM node:24-alpine AS web
WORKDIR /src/web
RUN npm install -g pnpm@11.19.0 --fetch-retries=5
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm test && pnpm run build

FROM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN go test ./... && go vet ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /broadcast ./cmd/server

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
WORKDIR /app
COPY --from=server /broadcast /app/broadcast
COPY --from=web /src/web/dist /app/web/dist
USER app
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s CMD ["/app/broadcast", "healthcheck"]
ENTRYPOINT ["/app/broadcast"]
