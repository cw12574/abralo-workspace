FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs index.html site.css site.js mark.svg social-card.svg social-card.png ./
COPY --chown=node:node assets ./assets
ENV NODE_ENV=production
ENV PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
