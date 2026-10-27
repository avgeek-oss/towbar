FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
WORKDIR /app
RUN mkdir /app/uploads && chown node:node /app/uploads
COPY --chown=node:node server.mjs ./server.mjs
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
