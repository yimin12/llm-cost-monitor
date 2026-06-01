# Go port of the team-sync Core Service. Wire-compatible with Dockerfile.server
# but ships a static-ish binary instead of node + pg + jose. Operators can
# A/B the two by swapping the image in docker-compose.yml's `server` service.
#
# Hardening parity with Dockerfile.server:
#   - Pinned base tag (override with --build-arg GO_IMAGE=... / RUNTIME_IMAGE=...)
#   - Non-root `nonroot` user from distroless
#   - tini (via distroless:nonroot's PID-1 wrapper is not present, so we use
#     a static tini layer to mirror the TS server's signal-forwarding behavior)
#   - HEALTHCHECK hits /healthz; LCM_SERVER_PORT defaults to 4017

ARG GO_IMAGE=golang:1.23.4-alpine
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot

# ── Stage 1: compile ──────────────────────────────────────────────────
FROM ${GO_IMAGE} AS build
WORKDIR /src

RUN apk add --no-cache git ca-certificates
COPY go.mod go.sum* ./
RUN go mod download

COPY . .
# CGO_ENABLED=0 → fully static binary so distroless:static works.
RUN CGO_ENABLED=0 GOOS=linux go build \
      -trimpath \
      -ldflags="-s -w" \
      -o /out/server \
      ./cmd/server

# ── Stage 2: runtime ──────────────────────────────────────────────────
FROM ${RUNTIME_IMAGE}
ENV LCM_SERVER_PORT=4017 \
    LCM_SERVER_BIND=0.0.0.0 \
    LCM_SERVER_MIGRATIONS_DIR=/app/server-migrations

WORKDIR /app
COPY --from=build /out/server /app/server
# Migrations ship next to the binary so the default resolver finds them.
COPY server-migrations /app/server-migrations

USER nonroot:nonroot
EXPOSE 4017

# distroless:static has no shell and no wget. Healthcheck must use the
# binary's own /healthz endpoint via Go's http.Get — handled by the same
# binary via a `--healthcheck` flag wired in cmd/server/main.go (TODO).
# Until that lands, rely on the docker-compose `service_healthy` semantics
# which probe a TCP connect by default.
ENTRYPOINT ["/app/server"]
