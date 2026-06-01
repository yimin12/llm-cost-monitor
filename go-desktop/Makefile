# Thin wrapper over `go build` / `go test`. The full layered build (wails
# packaging, plugin scaffolds, multi-arch dist) belongs in Taskfile.yml; this
# Makefile is for the inner-loop developer flows that don't need Task installed.

VERSION ?= $(shell git describe --tags --dirty --always 2>/dev/null || echo "dev")
LDFLAGS := -X github.com/yimin12/llm-cost-monitor/go-desktop/internal/version.Version=$(VERSION) -s -w

.PHONY: build build-cli test lint dev clean tidy run-mockcache

build:
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/lcmbar ./cmd/lcmbar

build-cli:
	go build -trimpath -tags nogui -ldflags "$(LDFLAGS)" -o bin/lcmbar-cli ./cmd/lcmbar-cli

test:
	go test ./...

lint:
	go vet ./...

dev: build
	./bin/lcmbar daemon start --foreground

run-mockcache:
	go run ./tools/mockcache

tidy:
	go mod tidy

clean:
	rm -rf bin/
