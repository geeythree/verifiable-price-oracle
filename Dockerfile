FROM node:22.16.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./

RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

EXPOSE 8080

CMD ["node", "dist/index.js"]
