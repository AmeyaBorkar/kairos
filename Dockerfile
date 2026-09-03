# syntax=docker/dockerfile:1

# One image for every Node service in the stack.
#
# They share a workspace, a lockfile and a build, so building them separately would mean four
# installs of the same dependency graph to produce four images that differ only in which file they
# start. The service is chosen by the command, not by the image.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# The whole workspace, because pnpm resolves `workspace:*` against the tree rather than a registry
# and a partial copy fails at install rather than at build. `.dockerignore` is what keeps this
# honest: node_modules, dist and the film never enter the context.
COPY . .

RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app

# Copied whole rather than reinstalled. pnpm's node_modules is a tree of symlinks into a store, and
# a second `install --prod` in this stage would resolve the graph again to save less than it costs.
COPY --from=build /app /app

# Nothing here writes to disk: every service logs to stdout and keeps its state in Postgres or in
# its own memory. So it does not need to own its files, and does not run as root.
USER node

# Overridden per service in compose. Named here so `docker run` on this image does something
# explicable rather than dropping into a shell.
CMD ["node", "apps/sentry/dist/main.js"]
