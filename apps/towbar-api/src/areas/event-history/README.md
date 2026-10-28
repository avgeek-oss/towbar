# Notification delivery history

`GET /v1/core/notifications/deliveries` requires notification management and a browser session. Queries are scoped to the current workspace. Repository-scoped routes additionally constrain the repository. Delivery history is excluded from the public API and MCP catalog.

Results use bounded keyset pagination ordered by `(created_at DESC, id DESC)`. Cursors preserve PostgreSQL microseconds so closely timed deliveries are not skipped. Search is parameterized and treats `%`, `_`, and backslashes literally.

Results select display fields and omit encrypted destination configuration, full webhook URLs, raw event payloads, and raw provider error messages. Successful delivery means provider acceptance, not recipient receipt. Transactional account and team emails use a separate outbox.
