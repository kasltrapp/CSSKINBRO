FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install
CMD ["node", "cron/price_fetch.js"]
