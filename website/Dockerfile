FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs index.html start.html site.css site.js mark.svg social-card.svg social-card.png beacon.html beacon.css beacon.js city.js crossing.html crossing.css crossing.js ./
COPY --chown=node:node replay.html replay.css replay.js ./
COPY --chown=node:node assets ./assets
ENV NODE_ENV=production
ENV PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
