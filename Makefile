.PHONY: install check test build clean release

install:
	bun install

check:
	bun run check

test:
	bun test

build:
	bun run build

clean:
	rm -rf dist

release:
	git tag v$(shell bun -p "require('./package.json').version")
	git push --tags
