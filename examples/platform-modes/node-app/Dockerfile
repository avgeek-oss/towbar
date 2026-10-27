FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS source
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./

FROM source AS runtime
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
