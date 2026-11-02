# gqy-plugins-GitHubAccount-default：零依赖 Node 插件仓库的本地检查入口。
# 只依赖 Node ≥18；CI 用 Node 20（见 .github/workflows/ci.yml）。

SHELL := /bin/bash
NODE  ?= node

JS_FILES  := $(shell find . -name '*.js'  -not -path './node_modules/*' -not -path './.git/*' | sort)
MJS_FILES := $(shell find . -name '*.mjs' -not -path './node_modules/*' -not -path './.git/*' | sort)

.PHONY: help check syntax test fmt-check clean

help:
	@echo "用法：make <目标>"
	@echo "  check      语法检查全部 .js/.mjs，再跑 npm test（验收入口）"
	@echo "  syntax     node --check 全部 .js 与 .mjs"
	@echo "  test       npm test（manifest / 握手 / 隔离 / 真实上游四组测试）"
	@echo "  fmt-check  行尾与结尾换行检查（零依赖，不自动格式化）"
	@echo "  clean      删掉 node_modules 与临时目录"

check: syntax test

syntax:
	@set -e; for f in $(JS_FILES) $(MJS_FILES); do echo "node --check $$f"; $(NODE) --check "$$f"; done

test:
	npm test

fmt-check:
	@set -e; \
	bad=0; \
	files=$$(find . \( -name '*.js' -o -name '*.mjs' -o -name '*.json' -o -name '*.yml' -o -name '*.md' -o -name 'Makefile' \) -not -path './node_modules/*' -not -path './.git/*'); \
	for f in $$files; do \
	  if grep -q $$'\r' "$$f"; then echo "$$f: 含 CRLF 行尾"; bad=1; fi; \
	  if [ -n "$$(tail -c 1 "$$f")" ]; then echo "$$f: 结尾缺少换行"; bad=1; fi; \
	done; \
	if [ $$bad -ne 0 ]; then echo "fmt-check 未通过"; exit 1; fi; \
	echo "fmt-check OK"

clean:
	rm -rf node_modules tmp test/.tmp
	@echo "已清理 node_modules/、tmp/、test/.tmp/ 与本机 .DS_Store"
