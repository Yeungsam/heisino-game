FROM node:20-alpine

WORKDIR /app
COPY data/cards.json /app/data/cards.json
COPY server /app/server

ENV PORT=80
EXPOSE 80
CMD ["node", "server/index.js"]
