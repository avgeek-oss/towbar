FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS source
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./

FROM source AS runtime
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
