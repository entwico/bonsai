# @entwico/bonsai

## 3.0.0

### Major Changes

- c33c09b: rewrite each entrypoint in place next to its original — preloads and worker paths that pointed at files relocated into the first entry's directory must now use the original entry paths

### Patch Changes

- c33c09b: no longer bundle packages already classified as external (native bindings, NFT warnings) into the rewritten output
- c33c09b: trace `import.meta.resolve()` and `__require()` specifiers that minifiers turned into template literals
- c33c09b: keep bare imports the rewrite cannot resolve external and preserved instead of failing the build

## 2.1.0

### Minor Changes

- e97ff92: properly trace literal `import.meta.resolve()` references

## 2.0.1

### Patch Changes

- edeb233: correctly resolve the dependency closure under pnpm's isolated (.pnpm) node_modules layout

## 2.0.0

### Major Changes

- dfe88d6: renamed from @entwico/nft-docker; entrypoints are now positional (drop `-e`) and rewrite is the default (pass `--no-rewrite` to opt out)

## 1.3.4

### Patch Changes

- 8c5068c: keep packages that bundled chunks reference only through rolldown's `__require(...)` helper

## 1.3.3

### Patch Changes

- 2e7fe56: preserve class and function names in the rewritten output

## 1.3.2

### Patch Changes

- a171ad4: fix deep CJS detection

## 1.3.1

### Patch Changes

- 157e8e4: safer `--rewrite` by keeping cjs modules out of shimming
- 157e8e4: always strip `@types/*` from `node_modules`
- 157e8e4: improve recognition of `.fork()` method calls

## 1.3.0

### Minor Changes

- 7d3963d: remove the preinstall command; install now passes --node-linker=hoisted to pnpm directly

## 1.2.0

### Minor Changes

- 8fc8bef: add pnpm 11 support

## 1.1.2

### Patch Changes

- fix `--rewrite` crashing on packages that shadow node builtins (e.g. `punycode`)

## 1.1.1

### Patch Changes

- fix `MODULE_NOT_FOUND` at runtime for some packages under `--rewrite`

## 1.1.0

### Minor Changes

- f0f5a1b: new `-p` / `--preserve` flag for declaring extra files NFT cannot statically resolve (e.g. fontsource woffs, locale JSON files)
- f0f5a1b: new experimental `--rewrite` flag that rebundles entries with rolldown before NFT trims, producing significantly smaller production images

## [1.0.1](https://github.com/entwico/nft-docker/compare/v1.0.0...v1.0.1) (2026-03-20)

### Bug Fixes

- updated deps ([869985a](https://github.com/entwico/nft-docker/commit/869985a61b26523f73a34be6435fa718222ddfc8))
