// A first deployment for each project, not a list of optional production add-ons.
// Values are saved in Towbar's runtime secret form; none of the example passwords
// or tokens belong in the repository.
export const ossRecipes = {
  1: {
    image:
      "ghcr.io/umami-software/umami:3.4@sha256:6cd9d24a836fac5c226c3c90cb25141d4560b7270b7827f393ccf09bf3f83b18",
    port: 3000,
    datastores: ["postgres"],
    values: {
      DATABASE_URL:
        "`postgresql://umami:PASSWORD@umami-postgres:5432/umami` (replace `PASSWORD` with `POSTGRES_PASSWORD`)",
    },
    why: "Umami needs PostgreSQL for accounts, websites, and analytics events. Deploy its Datastore first, then save a connection URL on the Umami Service; Towbar does not copy database credentials between them.",
    check:
      "Sign in, change the default administrator password, add a site, and verify a test visit appears. Redeploy Umami and confirm the site and visit remain.",
  },
  2: {
    image: "grafana/grafana:12.4.0",
    port: 3000,
    volumes: ["/var/lib/grafana"],
    values: {
      GF_SECURITY_ADMIN_PASSWORD: "Generate a unique administrator password.",
    },
    why: "Grafana starts with SQLite. The named volume keeps users, dashboards, and its SQLite database across deployments, so a separate Datastore is not needed for this first instance.",
    check:
      "Sign in, add a data source, and confirm the dashboard remains after a redeploy. Back up the Service volume; a PostgreSQL Datastore is an optional later migration, not a first-run requirement.",
  },
  3: {
    image: "docker.gitea.com/gitea:1",
    port: 3000,
    volumes: ["/data"],
    values: { GITEA__server__ROOT_URL: "https://gitea.example.com/" },
    why: "The smallest Gitea installation uses its built-in SQLite database in `/data`. This recipe exposes the web interface only; Git over SSH needs a separately planned port and DNS setup.",
    check:
      "Complete the web installer with SQLite, confirm clone links use the HTTPS domain, create a repository, and verify it remains after redeployment. Back up `/data` before upgrading Gitea.",
  },
  4: {
    image: "codeberg.org/forgejo/forgejo:16",
    port: 3000,
    volumes: ["/data"],
    values: { FORGEJO__server__ROOT_URL: "https://forgejo.example.com/" },
    why: "Forgejo can initialize SQLite in `/data`, so a separate database is not necessary for a small first installation. Towbar's HTTP route does not expose the embedded SSH server.",
    check:
      "Finish the installer with SQLite, create a repository, and confirm it survives redeployment. Arrange a separate SSH route before advertising SSH clone URLs.",
  },
  5: {
    image: "vaultwarden/server:1.34.3",
    port: 80,
    volumes: ["/data"],
    values: { DOMAIN: "https://vaultwarden.example.com" },
    why: "Vaultwarden uses SQLite in `/data` by default. Keep the public URL in `DOMAIN` and enable HTTPS before adding accounts; the volume holds the database and attachments.",
    check:
      "Create an account over HTTPS, lock and unlock the vault, then verify the account survives a redeploy. Back up `/data` separately.",
  },
  6: {
    image: "louislam/uptime-kuma:2",
    port: 3001,
    volumes: ["/app/data"],
    why: "Uptime Kuma stores users, monitors, and status pages in its SQLite database under `/app/data`. It does not need a separate Datastore for a small instance; keep the Service volume on local storage that supports file locking.",
    check:
      "Create a monitor and a status page, redeploy, and verify both and their history remain. Keep a backup of the `/app/data` volume.",
  },
  7: {
    image: "metabase/metabase:v0.57.6",
    port: 3000,
    datastores: ["postgres"],
    values: {
      MB_DB_TYPE: "postgres",
      MB_DB_HOST: "metabase-postgres",
      MB_DB_PORT: "5432",
      MB_DB_DBNAME: "Same value as the Datastore's POSTGRES_DB.",
      MB_DB_USER: "Same value as the Datastore's POSTGRES_USER.",
      MB_DB_PASS: "Same value as the Datastore's POSTGRES_PASSWORD.",
    },
    why: "This PostgreSQL Datastore is Metabase's application database: it stores users, collections, dashboards, and settings. It is separate from any analytics databases you later connect in the Metabase UI.",
    check:
      "Complete the setup wizard, create a collection, and verify it remains after redeploying Metabase. Back up the application database before upgrading.",
  },
  8: {
    image: "ghcr.io/paperless-ngx/paperless-ngx:2.18.4",
    port: 8000,
    datastores: ["postgres", "redis"],
    volumes: [
      "/usr/src/paperless/data",
      "/usr/src/paperless/media",
      "/usr/src/paperless/consume",
    ],
    values: {
      PAPERLESS_REDIS:
        "`redis://:PASSWORD@paperless-ngx-redis:6379/0` (replace `PASSWORD` with `REDIS_PASSWORD`)",
      PAPERLESS_DBENGINE: "postgresql",
      PAPERLESS_DBHOST: "paperless-ngx-postgres",
      PAPERLESS_DBNAME: "Same value as POSTGRES_DB.",
      PAPERLESS_DBUSER: "Same value as POSTGRES_USER.",
      PAPERLESS_DBPASS: "Same value as POSTGRES_PASSWORD.",
      PAPERLESS_SECRET_KEY: "Generate a long random key.",
      PAPERLESS_URL: "https://paperless-ngx.example.com",
    },
    why: "Paperless needs a Redis-compatible broker for background work. PostgreSQL stores document metadata; the Service volumes keep its index and document files. OCR of Office documents is an optional later Tika/Gotenberg addition.",
    check:
      "Upload a PDF and wait for processing. Confirm the document and its searchable text remain after redeployment. Back up both PostgreSQL and the Service volumes together.",
  },
  9: {
    image: "getmeili/meilisearch:v1.15.2",
    port: 7700,
    volumes: ["/meili_data"],
    values: {
      MEILI_MASTER_KEY: "Generate a strong key; never put it in browser code.",
      MEILI_ENV: "production",
    },
    why: "Meilisearch stores its indexes under `/meili_data`; it does not need a SQL Datastore. The master key is required for production mode.",
    check:
      "Create an index with an administrator key, add a document, and verify it remains after redeployment. Use a restricted search key for clients.",
  },
  10: {
    image: "jellyfin/jellyfin:10.10.7",
    port: 8096,
    volumes: ["/config", "/cache", "/media"],
    why: "Jellyfin keeps its library database in `/config` and transcode/cache files in `/cache`. `/media` is a separate volume; an empty volume has no films or music, so import files before creating a library.",
    steps: [
      "After deployment, transfer a sample media file to the server and use `docker cp` to place it under `/media` in the running Jellyfin container. The named media volume retains it when the container is replaced.",
    ],
    check:
      "Add a small media file to `/media`, scan the library, and play it over HTTP. This example does not configure DLNA or hardware transcoding.",
  },
  102: {
    image: "matomo:5.5.0-apache",
    port: 80,
    datastores: ["mariadb"],
    volumes: ["/var/www/html"],
    values: {
      MATOMO_DATABASE_HOST: "matomo-mariadb",
      MATOMO_DATABASE_DBNAME: "Same value as MYSQL_DATABASE.",
      MATOMO_DATABASE_USERNAME: "Same value as MYSQL_USER.",
      MATOMO_DATABASE_PASSWORD: "Same value as MYSQL_PASSWORD.",
    },
    why: "Matomo needs MariaDB/MySQL for site and reporting data. The Service volume preserves its configuration, plugins, and uploaded assets. Add a scheduled archive task after the first site is working; relying only on browser-triggered archiving is not a long-term plan.",
    check:
      "Complete the installer, add a site, and verify its tracking request appears. Set up Matomo's `core:archive` schedule before collecting regular traffic.",
  },
  103: {
    image: "glitchtip/glitchtip:6",
    port: 8000,
    datastores: ["postgres"],
    volumes: ["/code/uploads"],
    values: {
      DATABASE_URL:
        "`postgres://glitchtip:PASSWORD@glitchtip-postgres:5432/glitchtip` (replace `PASSWORD` with `POSTGRES_PASSWORD`)",
      SECRET_KEY: "Generate with `openssl rand -hex 32`.",
      GLITCHTIP_DOMAIN: "https://glitchtip.example.com",
      ALLOWED_HOSTS: "glitchtip.example.com",
      CSRF_TRUSTED_ORIGINS: "https://glitchtip.example.com",
      SERVER_ROLE: "all_in_one",
      VALKEY_URL: "Leave empty for the small PostgreSQL-backed setup.",
      EMAIL_URL:
        "Your SMTP URL, or `consolemail://` for a test that does not send email.",
    },
    why: "GlitchTip 6 can run its web and background work in one container with PostgreSQL. Valkey is optional for a small instance; `SERVER_ROLE=all_in_one` and an empty `VALKEY_URL` select that path. The uploads volume keeps attachments.",
    check:
      "Create a project, send a test event, and verify it appears. Configure real SMTP before relying on invitations or email alerts; back up PostgreSQL and uploads.",
  },
  105: {
    image: "victoriametrics/victoria-metrics:v1.152.0",
    port: 8428,
    volumes: ["/victoria-metrics-data"],
    public: false,
    why: "Single-node VictoriaMetrics stores metrics in its own data directory; no SQL Datastore is needed. Keep ingestion private unless an external agent must reach it.",
    check:
      "From a trusted client on the same application network, write a sample metric and query it back. Add an authenticated route only if external agents need access; check retention and the volume before treating this as a production metrics store.",
  },
  109: {
    image: "ghost:6-alpine",
    port: 2368,
    datastores: ["mysql"],
    volumes: ["/var/lib/ghost/content"],
    values: {
      url: "https://ghost.example.com",
      database__client: "mysql",
      database__connection__host: "ghost-mysql",
      database__connection__user: "Same value as MYSQL_USER.",
      database__connection__password: "Same value as MYSQL_PASSWORD.",
      database__connection__database: "Same value as MYSQL_DATABASE.",
    },
    why: "A basic Ghost publication needs MySQL and a persistent content directory. This example omits Ghost's optional ActivityPub and Tinybird analytics services; add them only when you need those features.",
    check:
      "Complete Ghost's setup at `/ghost`, publish a post with an image, and verify the post and upload survive redeployment. Back up MySQL and the content volume together.",
  },
  110: {
    image: "wordpress:6.9.0-php8.4-apache",
    port: 80,
    datastores: ["mariadb"],
    volumes: ["/var/www/html/wp-content"],
    values: {
      WORDPRESS_DB_HOST: "wordpress-mariadb:3306",
      WORDPRESS_DB_NAME: "Same value as MYSQL_DATABASE.",
      WORDPRESS_DB_USER: "Same value as MYSQL_USER.",
      WORDPRESS_DB_PASSWORD: "Same value as MYSQL_PASSWORD.",
    },
    why: "MariaDB stores posts and accounts; the `wp-content` volume holds uploads, themes, and plugins. Both need a consistent backup.",
    check:
      "Finish the installer, upload an image, create a post, and confirm both remain after redeployment.",
  },
  111: {
    image: "requarks/wiki:2",
    port: 3000,
    datastores: ["postgres"],
    values: {
      DB_TYPE: "postgres",
      DB_HOST: "wiki-js-postgres",
      DB_PORT: "5432",
      DB_NAME: "Same value as POSTGRES_DB.",
      DB_USER: "Same value as POSTGRES_USER.",
      DB_PASS: "Same value as POSTGRES_PASSWORD.",
    },
    why: "Wiki.js stores its pages and settings in PostgreSQL. No Service data volume is needed for the basic database-backed installation.",
    check:
      "Complete the installer, publish a test page, and verify it remains after redeployment.",
  },
  112: {
    image: "deluan/navidrome:0.58.0",
    port: 4533,
    volumes: ["/data", "/music"],
    why: "Navidrome stores its catalog and settings in `/data` and reads files from `/music`. Populate the music volume before scanning; an empty named volume is an empty library.",
    steps: [
      "After deployment, transfer a test album to the server and use `docker cp` to place it under `/music` in the running Navidrome container. The named music volume retains those files across redeployments.",
    ],
    check:
      "Add an album to `/music`, run a scan, play a track, and confirm the catalog survives redeployment.",
  },
  113: {
    image: "nodered/node-red:4.1.1",
    port: 1880,
    volumes: ["/data"],
    public: false,
    why: "Node-RED stores flows, encrypted credentials, and its generated encryption key in `/data`. The editor has no default login, so this first Service stays private. Add Node-RED admin authentication or an access gateway before assigning a public domain.",
    check:
      "Open the editor from a trusted connection, create a test flow, redeploy, and confirm it still runs. Back up the whole `/data` volume, including its generated credential key.",
  },
  114: {
    image: "typesense/typesense:28.0",
    port: 8108,
    volumes: ["/data"],
    public: false,
    values: {
      TYPESENSE_API_KEY: "Generate a strong server-side administrator key.",
      TYPESENSE_DATA_DIR: "/data",
    },
    why: "Typesense stores collections under `/data`; no separate SQL Datastore is needed. Keep its administration API private and the master key server-side. Public search clients should use a restricted search-only key.",
    check:
      "From an authorized client on the application network, create a collection, index a document, query it, and confirm the collection survives redeployment.",
  },
  115: {
    image:
      "searxng/searxng@sha256:5286edb35782454ab8a102c5eff6b54bff745853191b46aeead95f225aa6dfb6",
    port: 8080,
    volumes: ["/var/cache/searxng"],
    public: false,
    values: {
      SEARXNG_SECRET: "Generate a long random signing key.",
      SEARXNG_BASE_URL: "https://searxng.example.com/",
      SEARXNG_LIMITER: "false",
    },
    why: "SearXNG can load its bundled default settings and override the signing key and URL through environment variables, so a configuration file is not needed for this first instance. The cache volume keeps its local cache. Public bot protection needs Valkey and an explicitly configured limiter; do not treat this minimal setup as a public search service.",
    check:
      "Run a search from a trusted connection. Before assigning a public domain, configure the upstream Valkey-backed limiter or an access gateway and verify that the base URL matches the route.",
  },
  116: {
    image: "freshrss/freshrss:1.27.1",
    port: 80,
    volumes: ["/var/www/FreshRSS/data", "/var/www/FreshRSS/extensions"],
    values: {
      CRON_MIN:
        "13,43 (refresh feeds twice per hour using the image's built-in scheduler)",
    },
    why: "For a first single-user installation, FreshRSS can keep its SQLite database and feed data in the named data volume. The extensions volume preserves installed extensions. `CRON_MIN` starts the image's built-in feed refresh schedule.",
    check:
      "Complete setup with SQLite, subscribe to a feed, and verify new articles arrive on the next scheduled refresh and remain after redeployment.",
  },
  118: {
    image: "quay.io/hedgedoc/hedgedoc:1.12.0",
    port: 3000,
    datastores: ["postgres"],
    volumes: ["/hedgedoc/public/uploads"],
    values: {
      CMD_DB_URL:
        "`postgres://hedgedoc:PASSWORD@hedgedoc-postgres:5432/hedgedoc` (replace `PASSWORD` with `POSTGRES_PASSWORD`)",
      CMD_DOMAIN: "hedgedoc.example.com",
      CMD_PROTOCOL_USESSL: "true",
    },
    why: "PostgreSQL holds notes and accounts; the Service volume preserves uploaded assets. Both must be backed up.",
    check:
      "Create a note and upload an image, then verify both survive a redeploy.",
  },
  119: {
    image:
      "ghcr.io/huginn/huginn@sha256:5bb5bdd17b49b7cf0ccd7ffdd5535abe1c8a684272037b34b438c4739908bf01",
    port: 3000,
    datastores: ["mysql"],
    values: {
      HUGINN_DATABASE_ADAPTER: "mysql2",
      HUGINN_DATABASE_HOST: "huginn-mysql",
      HUGINN_DATABASE_PORT: "3306",
      HUGINN_DATABASE_NAME: "Same value as MYSQL_DATABASE.",
      HUGINN_DATABASE_USERNAME: "Same value as MYSQL_USER.",
      HUGINN_DATABASE_PASSWORD: "Same value as MYSQL_PASSWORD.",
      DO_NOT_CREATE_DATABASE: "true",
      SEED_USERNAME: "Choose the first administrator username.",
      SEED_PASSWORD: "Generate the first administrator password.",
      APP_SECRET_TOKEN:
        "Generate with `openssl rand -hex 64` and keep it unchanged across restarts.",
      DOMAIN: "huginn.example.com",
    },
    why: "The official multi-process Huginn image runs its web app and agent workers together. Point it at a Towbar MySQL Datastore so the built-in database is not lost with the container.",
    check:
      "Sign in with the seeded account, create a test agent, and confirm it runs after a redeploy. Back up the MySQL Datastore.",
  },
  120: {
    image: "ghcr.io/dgtlmoon/changedetection.io:0.50.14",
    port: 5000,
    volumes: ["/datastore"],
    why: "The `/datastore` volume holds watch definitions and history. The base installation checks ordinary pages; JavaScript-heavy sites may need a browser sidecar later.",
    check:
      "Add a watch and confirm its history and configuration survive redeployment.",
  },
  121: {
    image: "nextcloud:32-apache",
    port: 80,
    datastores: ["mariadb"],
    volumes: ["/var/www/html"],
    values: {
      MYSQL_HOST: "nextcloud-mariadb",
      MYSQL_DATABASE: "Same value as the Datastore's MYSQL_DATABASE.",
      MYSQL_USER: "Same value as the Datastore's MYSQL_USER.",
      MYSQL_PASSWORD: "Same value as the Datastore's MYSQL_PASSWORD.",
      NEXTCLOUD_TRUSTED_DOMAINS: "nextcloud.example.com",
      OVERWRITEPROTOCOL: "https",
      NEXTCLOUD_ADMIN_USER: "Choose the initial administrator username.",
      NEXTCLOUD_ADMIN_PASSWORD: "Generate the initial administrator password.",
    },
    why: "MariaDB stores Nextcloud metadata; the Service volume keeps configuration, apps, and uploaded files. Configure Nextcloud's background jobs after first login.",
    check:
      "Upload a file, redeploy, and verify it is still available. Back up the database and `/var/www/html` together.",
  },
  123: {
    image: "lscr.io/linuxserver/bookstack:25.07.3",
    port: 80,
    datastores: ["mariadb"],
    volumes: ["/config"],
    values: {
      APP_URL: "https://bookstack.example.com",
      APP_KEY: "Generate with the image's `appkey` command.",
      DB_HOST: "bookstack-mariadb",
      DB_PORT: "3306",
      DB_DATABASE: "Same value as MYSQL_DATABASE.",
      DB_USERNAME: "Same value as MYSQL_USER.",
      DB_PASSWORD: "Same value as MYSQL_PASSWORD.",
    },
    why: "MariaDB stores books and users; `/config` holds application files and uploads. Keep the generated `APP_KEY` stable after first deployment.",
    check:
      "Sign in with the upstream initial account and change its password. Create a page with an attachment, redeploy, and confirm both are still available.",
  },
  124: {
    image: "lscr.io/linuxserver/calibre-web:0.6.24",
    port: 8083,
    volumes: ["/config", "/books"],
    why: "Calibre-Web needs an existing Calibre library (`metadata.db`) in `/books`. The `/config` volume holds Calibre-Web's own users and settings; a separate Towbar Datastore is not used.",
    steps: [
      "After deployment, transfer an existing Calibre library to the server and use `docker cp` to place the whole library, including `metadata.db`, under `/books` in the running container.",
    ],
    check:
      "Sign in and change the initial administrator password. Import a real Calibre library into `/books`, point the first-run form at `/books/metadata.db`, and open a book. An empty volume cannot be used as a library.",
  },
  125: {
    image: "photoprism/photoprism:250707",
    port: 2342,
    datastores: ["mariadb"],
    volumes: ["/photoprism/originals", "/photoprism/storage"],
    values: {
      PHOTOPRISM_ADMIN_PASSWORD:
        "Generate a unique initial administrator password.",
      PHOTOPRISM_SITE_URL: "https://photoprism.example.com/",
      PHOTOPRISM_DATABASE_DRIVER: "mysql",
      PHOTOPRISM_DATABASE_SERVER: "photoprism-mariadb:3306",
      PHOTOPRISM_DATABASE_NAME: "Same value as MYSQL_DATABASE.",
      PHOTOPRISM_DATABASE_USER: "Same value as MYSQL_USER.",
      PHOTOPRISM_DATABASE_PASSWORD: "Same value as MYSQL_PASSWORD.",
    },
    why: "MariaDB stores the index; the Service volumes store photo originals and generated files. Back up the database and both volumes together.",
    steps: [
      "After deployment, transfer a test photo to the server and use `docker cp` to place it under `/photoprism/originals` in the running container. The named originals volume retains it across redeployments.",
    ],
    check:
      "Import a small album into `/photoprism/originals`, index it, and verify both originals and thumbnails survive redeployment.",
  },
  126: {
    image: "miniflux/miniflux:2.2.12",
    port: 8080,
    datastores: ["postgres"],
    values: {
      DATABASE_URL:
        "`postgres://miniflux:PASSWORD@miniflux-postgres:5432/miniflux?sslmode=disable` (replace `PASSWORD` with `POSTGRES_PASSWORD`)",
      RUN_MIGRATIONS: "1",
      CREATE_ADMIN: "1",
      ADMIN_USERNAME: "Choose the initial username.",
      ADMIN_PASSWORD: "Generate the initial password.",
    },
    why: "Miniflux requires PostgreSQL for feeds, accounts, and read state. `RUN_MIGRATIONS=1` initializes schema; the first-run administrator values should be removed after creation.",
    check:
      "Add a feed, refresh it, and confirm subscription and read state survive redeployment. After the administrator exists, remove `CREATE_ADMIN`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` from the manifest and Service secrets, sync, and redeploy; they are first-run values only.",
  },
  128: {
    image: "jenkins/jenkins:2.528.1-lts-jdk21",
    port: 8080,
    volumes: ["/var/jenkins_home"],
    why: "Jenkins keeps jobs, plugins, and credentials in `/var/jenkins_home`. The controller is not a Docker build worker; add dedicated agents instead of mounting the host Docker socket.",
    check:
      "Complete the unlock wizard, create a small job, and verify it remains after redeployment. Back up Jenkins home before upgrades.",
  },
  129: {
    image:
      "vikunja/vikunja@sha256:417ada6f94e81f0267aa2f007d0a811fc82d38dd2aa58351e3ea520ca01c2ea5",
    port: 3456,
    volumes: ["/db", "/app/vikunja/files"],
    values: {
      VIKUNJA_SERVICE_SECRET:
        "Generate a long random signing key and keep it stable.",
      VIKUNJA_SERVICE_PUBLICURL: "https://vikunja.example.com/",
    },
    why: "The official image uses SQLite at `/db/vikunja.db` by default and stores uploads in `/app/vikunja/files`. Both paths need persistent volumes. SQLite is suitable for a small installation; use PostgreSQL or MySQL for a larger team.",
    check:
      "Create a project and task, attach a file, and verify all three survive redeployment. If the database cannot be opened, check that the container's UID 1000 can write to both volumes.",
  },
  130: {
    image:
      "kanboard/kanboard@sha256:8df6c4339134b6c196da9a262daa42ab8ce395f528a48d4a3dd7038c296f34c1",
    port: 80,
    volumes: ["/var/www/app/data", "/var/www/app/plugins"],
    why: "Kanboard's default SQLite database and attachments live in `/var/www/app/data`; plugins use a separate directory. A dedicated SQL Datastore is optional for a small first installation.",
    check:
      "Change the initial administrator credentials, create a board and task, and confirm they remain after redeployment. Back up the data and plugins volumes together.",
  },
  131: {
    image:
      "excalidraw/excalidraw@sha256:f7ee194addd607bf831d2af0f0a34463dd4225e426cf35199ef0b12a803398e9",
    port: 80,
    why: "The official image serves only Excalidraw's browser client. It needs no Datastore or Service volume, but the self-hosted client does not provide Excalidraw's sharing and live collaboration services.",
    check:
      "Create a diagram and export it. Test in another browser before assuming drawings or collaboration are shared across users; this recipe deploys only the client.",
  },
  132: {
    image:
      "neosmemo/memos@sha256:24c2707ddd8fbd2ceaa7a61ecab86a53cdcde640b24ce572b73da14b00b5785f",
    port: 5230,
    volumes: ["/var/opt/memos"],
    values: { MEMOS_INSTANCE_URL: "https://memos.example.com" },
    why: "Memos uses SQLite for a simple first deployment and stores its database and local assets under `/var/opt/memos`. Set the external URL to the same HTTPS address as Towbar's route.",
    check:
      "Create a note and attach a small file, then redeploy and confirm both remain. Include the Service volume in backups.",
  },
  133: {
    image:
      "gotify/server@sha256:44fc5bbd1c0618878e33073d38c2c13126b48f245c3fe12236b1da48eb203b86",
    port: 80,
    volumes: ["/app/data"],
    values: {
      GOTIFY_DEFAULTUSER_PASS:
        "Generate a strong password for the initial administrator account.",
    },
    why: "Gotify uses SQLite by default. Its `/app/data` directory contains the database and uploaded application images. Supply the first administrator password before deployment rather than using a default credential.",
    check:
      "Sign in, create an application token, send a test message, and verify the message and account remain after redeployment. Back up `/app/data`.",
  },
  134: {
    image:
      "filebrowser/filebrowser@sha256:a469ea076d4a1b4b1d86a41d130f2f536cd9da996a2b1fb39c0d7635f9d89b9a",
    port: 80,
    public: false,
    networkAlias: true,
    volumes: ["/srv", "/database", "/config"],
    why: "File Browser stores shared files in `/srv`, its user database in `/database`, and settings in `/config`. The official image generates an administrator password on first boot and prints it only once in the container logs, so start with a private route.",
    check:
      "Retrieve and save the one-time administrator password from the deployment logs, upload a test file over a trusted connection, and verify it remains after redeployment. Add a public domain only after securing the accounts and permissions.",
  },
  135: {
    image:
      "actualbudget/actual-server@sha256:552beab3dec8c93d46b8b9245612d63c3f123b8a45063a474f53e229b17621d3",
    port: 5006,
    volumes: ["/data"],
    why: "Actual stores its server files and user budgets under `/data`. The example HTTPS route provides the secure browser context its web app needs; no external Datastore is required.",
    check:
      "Create a budget and sample transaction, redeploy, and confirm both remain. Back up the `/data` volume before changing versions.",
  },
  136: {
    image:
      "ghcr.io/advplyr/audiobookshelf@sha256:3528a93b6442ffe54bd46771bbbab7c97084e1101071586d9dc2254f30bb4358",
    port: 80,
    volumes: ["/config", "/metadata", "/audiobooks", "/podcasts"],
    why: "Audiobookshelf keeps its SQLite database in `/config`, artwork and backups in `/metadata`, and media in the other volumes. No separate SQL Datastore is needed. Keep `/config` on local storage rather than a network filesystem.",
    steps: [
      "Transfer a test audiobook to the server and use `docker cp` to place it under `/audiobooks` in the running container. The named volume retains the file when the container is replaced.",
    ],
    check:
      "Create a library for `/audiobooks`, scan and play the test file, then verify the library and listening progress survive redeployment.",
  },
  137: {
    image:
      "docker.stirlingpdf.com/stirlingtools/stirling-pdf@sha256:66b6edb8ee62e307a8b335166e8931a6e65b39c9bf73b5e517fbfe9c613ba221",
    port: 8080,
    volumes: ["/configs", "/storage"],
    resources: { cpus: 2, memory: "4g" },
    values: {
      SECURITY_INITIALLOGIN_USERNAME:
        "Choose the first administrator username.",
      SECURITY_INITIALLOGIN_PASSWORD:
        "Generate a strong first administrator password.",
    },
    why: "Stirling PDF keeps its settings, generated keys, and embedded database in `/configs`. `/storage` holds files saved on the server. Set the initial login values before first deployment; they are ignored once users exist.",
    check:
      "Sign in, process and save a sample PDF, then verify the account and saved file remain after redeployment. Back up both volumes. The standard image needs about 4 GB of memory; OCR and large documents may need more.",
  },
  138: {
    image:
      "ghcr.io/gchq/cyberchef@sha256:f04a39926344faf8e4cbbc8c92fb125d2b466f9be62db09aff23c7c406101a51",
    port: 8080,
    why: "The official CyberChef image serves the web application directly. This recipe has no server-side database, user accounts, or persistent Service volume.",
    check:
      "Open the page, run a simple Base64 encode/decode operation, and confirm it also works after redeployment.",
  },
  139: {
    image:
      "ghcr.io/corentinth/it-tools@sha256:8b8128748339583ca951af03dfe02a9a4d7363f61a216226fc28030731a5a61f",
    port: 80,
    why: "IT-Tools serves a collection of browser utilities from one image. It needs no SQL Datastore or persistent server volume for the basic site.",
    check:
      "Open the site and try a converter or generator, then verify the page still loads after redeployment.",
  },
  140: {
    image:
      "ollama/ollama@sha256:8262851b2846b87c649eddf3e76beb270c52f4d1bc94559f47efde16b0841551",
    port: 11434,
    public: false,
    networkAlias: true,
    volumes: ["/root/.ollama"],
    resources: { cpus: 4, memory: "8g" },
    why: "This CPU-only image stores downloaded models under `/root/.ollama`. Ollama's API has no built-in authentication, so the example stays on the server's private application network. Model size and speed depend on available RAM and CPU.",
    check:
      "From a trusted shell on the server, pull a small model in the running container and query `/api/tags`. Redeploy and confirm the model is still listed.",
  },
  141: {
    image:
      "localai/localai@sha256:0632c21ddbe440bb71bc7aa744796c227a51658641b216290e86d6894e1c705b",
    port: 8080,
    public: false,
    networkAlias: true,
    volumes: ["/models", "/backends", "/configuration", "/data"],
    resources: { cpus: 4, memory: "8g" },
    why: "LocalAI's CPU image needs persistent locations for models, backend files, configuration, and application data. Keep its API private until you configure authentication and choose a model that fits the server's hardware.",
    check:
      "Access the private UI from a trusted connection, install a small compatible model, and query `/v1/models`. Verify the model remains installed after redeployment.",
  },
  142: {
    image:
      "copyparty/ac@sha256:0e276e2ca595d1b45df613573f094b789b9a8b41ff87cc55130db1ec9763c164",
    port: 3923,
    public: false,
    networkAlias: true,
    volumes: ["/w", "/cfg"],
    why: "Copyparty shares `/w` through its web server and reads optional configuration files from `/cfg`. Its default share is writable without authentication, so this first Service has no public domain.",
    check:
      "Upload and download a test file over a trusted connection, then verify it remains after redeployment. Configure accounts and access rules in `/cfg` before adding a public route.",
  },
};
