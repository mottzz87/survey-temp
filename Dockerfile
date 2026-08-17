FROM node:20-alpine

WORKDIR /app

# Zero-dependency runtime: no npm install needed.
COPY package.json server.js config.json ./
COPY public ./public

# Survey data is stored in /app/data. Mount a named volume or bind mount
# ./data on the host so votes survive container rebuilds.
RUN mkdir -p /app/data

ENV NODE_ENV=production

EXPOSE 6533

CMD ["node", "server.js"]
