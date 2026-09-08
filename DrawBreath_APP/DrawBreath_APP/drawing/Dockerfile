FROM node:20-bookworm-slim AS build
WORKDIR /app
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN mkdir -p /app/storage/uploads && chown -R node:node /app/storage
ENV NODE_ENV=production
EXPOSE 3300
CMD ["sh", "-c", "chown -R node:node /app/storage && npm run db:setup && su -s /bin/sh node -c 'npm start'"]
