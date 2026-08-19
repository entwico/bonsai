# @entwico/bonsai

CLI for shrinking Node.js Docker images. Computes the true runtime closure of your entrypoint(s) — including what static analysis misses (`__require`, literal `import.meta.resolve()`, native bindings, worker threads, loader patchers) — rebundles with [rolldown](https://rolldown.rs/), and deletes the rest of `node_modules/`.

Designed to be run via `npx` inside e. g. a Dockerfile — not a project dependency.

## Commands

### `install`

Full Docker-build cycle: install (with hoisted linker for pnpm) → rebundle → prune.

```bash
npx @entwico/bonsai install ./dist/server/entry.mjs
```

### `prune`

Rebundle + trace + delete pass on an existing `node_modules/`. For pnpm projects, the install that produced `node_modules/` must have used `--node-linker=hoisted` — symlinked layouts cannot be pruned reliably.

```bash
npx @entwico/bonsai prune ./dist/server/entry.mjs
```

## Arguments

Entrypoints are positional — pass one or more, space-separated (e.g. server + worker preload):

```bash
npx @entwico/bonsai prune ./dist/server/entry.mjs ./src/instrument.mjs
```

## Flags

| Flag                             | Description                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p <glob>`, `--preserve <glob>` | Extra files to keep regardless of trace output (fontsource woffs, locale JSONs, anything referenced via non-literal `import.meta.resolve(expr)` or `require(varName)` — literal calls are traced automatically). Repeatable. Patterns matching nothing throw. |
| `--no-rewrite`                   | Disable the rolldown rebundle and only trace + delete. Since 2.0, rewrite is on by default.                                                                                                                                                                   |
| `--no-minify`                    | Disable minification of the rewritten bundle. Default: on.                                                                                                                                                                                                    |
| `--no-sourcemap`                 | Skip emitting `.mjs.map` files. Default: on. With sourcemaps, run with `node --enable-source-maps` for symbolicated stack traces.                                                                                                                             |
| `-v`, `--verbose`                | Verbose logs                                                                                                                                                                                                                                                  |

## Dockerfile examples

### Build in CI, prune in Docker

```dockerfile
FROM node:24-alpine

RUN corepack enable pnpm
WORKDIR /srv
RUN addgroup -S app && adduser -S app -G app && apk add --no-cache tini

COPY package.json pnpm-lock.yaml /srv/
COPY dist/ /srv/dist/

RUN npx @entwico/bonsai install ./dist/server/entry.mjs

USER app
ENTRYPOINT ["tini", "--", "node", "--enable-source-maps", "./dist/server/entry.mjs"]
```

### Install, build, and prune inside Docker

```dockerfile
FROM node:24-alpine AS builder

RUN corepack enable pnpm
WORKDIR /srv

COPY package.json pnpm-lock.yaml /srv/
RUN pnpm install --frozen-lockfile --node-linker=hoisted

COPY . /srv/
RUN pnpm run build

RUN npx @entwico/bonsai prune ./dist/server/entry.mjs

# --- final image ---
FROM node:24-alpine
WORKDIR /srv
RUN addgroup -S app && adduser -S app -G app && apk add --no-cache tini

COPY --from=builder --chown=app:app /srv/node_modules /srv/node_modules/
COPY --from=builder --chown=app:app /srv/dist /srv/dist/

USER app
ENTRYPOINT ["tini", "--", "node", "--enable-source-maps", "./dist/server/entry.mjs"]
```

For npm projects, swap the lockfile and drop the corepack line.

### With `--preserve` for assets

```bash
npx @entwico/bonsai install \
  ./dist/server/main.mjs \
  -p './node_modules/@fontsource/poppins/**' \
  -p './node_modules/some-i18n-pack/locales/*.json'
```

### With `--no-rewrite` to trace only

Skip the rolldown rebundle and just trace + delete — larger images, but the entry files are left byte-for-byte as your build emitted them.

```bash
npx @entwico/bonsai prune --no-rewrite ./dist/server/entry.mjs
```

## License

MIT
