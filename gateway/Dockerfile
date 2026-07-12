# Multi-stage: compile TypeScript in a full image, ship only the compiled output
# and the production dependencies.
#
# `npm ci` installs exactly the lockfile, so an image rebuilt six months from now
# is the image we tested — this service sits on the request path and handles the
# API keys, so its dependency tree is not allowed to drift on its own.
#
# The build stage doubles as the test image (it is the only one carrying vitest):
#   docker build --target build -t llm-tollbooth/gateway-test ./gateway
#   docker run --rm llm-tollbooth/gateway-test npm test
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/server.js"]
