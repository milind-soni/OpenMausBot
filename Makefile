SHELL := /bin/bash
.DEFAULT_GOAL := help

PNPM ?= pnpm
UPSTREAM_URL ?= https://github.com/milind-soni/OpenMausBot.git

.PHONY: help configure-remotes pull pull-main check-node install dev desktop server web lint typecheck test check build package-mac package-win package-linux

help:
	@printf '%s\n' \
		'OpenMausBot development shortcuts' \
		'' \
		'  make pull           Alias for make pull-main' \
		'  make pull-main      Fetch and merge upstream/main' \
		'  make install        Install dependencies' \
		'  make dev            Run the harness and browser app' \
		'  make desktop        Run the harness, browser app, and Electron' \
		'  make server         Run only the harness server' \
		'  make web            Run only the Vite app' \
		'  make lint           Run the linter' \
		'  make typecheck      Type-check the app and server' \
		'  make test           Run the test suite' \
		'  make check          Run typecheck, tests, and Electron syntax checks' \
		'  make build          Create a production build' \
		'  make package-mac    Build macOS packages' \
		'  make package-win    Build Windows packages' \
		'  make package-linux  Build Ubuntu packages'

# Keep the fork as the only push destination. Upstream remains fetch-only,
# including for an explicit `git push upstream` made from this checkout.
configure-remotes:
	@if ! git remote get-url origin >/dev/null 2>&1; then \
		printf '%s\n' 'Missing origin remote; refusing to configure or push.' >&2; \
		exit 1; \
	fi
	@if git remote get-url upstream >/dev/null 2>&1; then \
		actual="$$(git remote get-url upstream)"; \
		if [[ "$$actual" != "$(UPSTREAM_URL)" ]]; then \
			printf 'Unexpected upstream URL: %s\nExpected: %s\n' "$$actual" '$(UPSTREAM_URL)' >&2; \
			exit 1; \
		fi; \
	else \
		git remote add upstream '$(UPSTREAM_URL)'; \
	fi
	@git config remote.pushDefault origin
	@branch="$$(git branch --show-current)"; \
	if [[ -n "$$branch" ]]; then git config "branch.$$branch.pushRemote" origin; fi
	@git remote set-url --push upstream DISABLED

# A clean tree keeps a failed merge easy to inspect and prevents Make from
# hiding local work in an automatic stash. Diverged fork commits are retained
# in a normal merge; a fork with no local commits simply fast-forwards.
pull: pull-main

pull-main: configure-remotes
	@if [[ -n "$$(git status --porcelain)" ]]; then \
		printf '%s\n' 'Working tree is not clean. Commit or stash changes before make pull-main.' >&2; \
		exit 1; \
	fi
	git fetch upstream main
	git merge --no-edit upstream/main

check-node:
	@node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 24) { console.error(`OpenMausBot requires Node 24 or newer (current: $${process.version}). Run \`nvm use\` or activate another Node 24 runtime.`); process.exit(1); }'

install dev desktop server web lint typecheck test check build package-mac package-win package-linux: check-node

install:
	$(PNPM) install

# Browser development uses one harness and one Vite process. If either exits,
# stop the other so a failed or interrupted run never leaves a stale server.
dev:
	@set -Eeuo pipefail; \
	server_pid=''; web_pid=''; \
	cleanup() { \
		trap - EXIT; \
		for pid in "$$server_pid" "$$web_pid"; do \
			if [[ -n "$$pid" ]] && kill -0 "$$pid" 2>/dev/null; then kill "$$pid" 2>/dev/null || true; fi; \
		done; \
		wait 2>/dev/null || true; \
	}; \
	trap cleanup EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	$(PNPM) dev:server & server_pid=$$!; \
	$(PNPM) dev & web_pid=$$!; \
	printf '%s\n' 'OpenMausBot browser mode: http://127.0.0.1:5199'; \
	wait -n "$$server_pid" "$$web_pid"

# Electron loads the Vite URL in development, so wait for both endpoints
# before opening its window. Closing any process tears down the other two.
desktop:
	@set -Eeuo pipefail; \
	server_pid=''; web_pid=''; desktop_pid=''; \
	cleanup() { \
		trap - EXIT; \
		for pid in "$$desktop_pid" "$$web_pid" "$$server_pid"; do \
			if [[ -n "$$pid" ]] && kill -0 "$$pid" 2>/dev/null; then kill "$$pid" 2>/dev/null || true; fi; \
		done; \
		wait 2>/dev/null || true; \
	}; \
	trap cleanup EXIT; \
	trap 'exit 130' INT; \
	trap 'exit 143' TERM; \
	$(PNPM) dev:server & server_pid=$$!; \
	$(PNPM) dev & web_pid=$$!; \
	node -e 'const urls=["http://127.0.0.1:8799/api/health","http://127.0.0.1:5199"]; const deadline=Date.now()+30000; (async()=>{ for (;;) { try { const responses=await Promise.all(urls.map((url)=>fetch(url))); if (responses.every((response)=>response.ok)) return; } catch {} if (Date.now()>=deadline) throw new Error("Timed out waiting for the local server and Vite"); await new Promise((resolve)=>setTimeout(resolve,250)); } })().catch((error)=>{ console.error(error.message); process.exit(1); });'; \
	$(PNPM) dev:desktop & desktop_pid=$$!; \
	wait -n "$$server_pid" "$$web_pid" "$$desktop_pid"

server:
	$(PNPM) dev:server

web:
	$(PNPM) dev

lint:
	$(PNPM) lint

typecheck:
	$(PNPM) typecheck

test:
	$(PNPM) test

check:
	$(PNPM) typecheck
	$(PNPM) test
	$(PNPM) check:electron

build:
	$(PNPM) build

package-mac:
	$(PNPM) package:mac

package-win:
	$(PNPM) package:win

package-linux:
	$(PNPM) package:linux
