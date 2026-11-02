FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 4000
# Run migrations, then start the API, the web app and the background sync worker.
CMD ["sh", "-c", "npx knex migrate:latest --knexfile knexfile.js && node src/server.js"]
