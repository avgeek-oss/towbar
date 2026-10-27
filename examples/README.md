# Hello Towbar

This is Towbar's ready-to-copy starter application. It lives in the main
Towbar repository so its manifest, Docker image, tests, and documentation stay
compatible with each release.

The example includes a small Node.js server, a Dockerfile that runs as a
non-root user, a health endpoint, and a v2 Towbar manifest. It has no runtime
dependencies or application secrets.

## Use the example

Create a repository for your application and copy these starter files into its
root:

- `.dockerignore`
- `.towbar/`
- `Dockerfile`
- `package.json`
- `src/`
- `test/`
- `towbar.yml`

Then:

1. Replace the example server addresses and domains in
   `.towbar/services/hello-towbar.service.yml`.
2. Push the repository to GitHub or GitLab.
3. Connect the repository in Towbar and map `production` and `staging` to the
   branches you want to deploy.
4. Prepare the target servers, deploy **Hello Towbar**, and verify `/health`.

See [Your first deployment](https://www.towbar.dev/docs/getting-started) for the
complete walkthrough.

## Run locally

From this directory, with Node.js 26 or newer:

```bash
npm start
```

Open <http://localhost:3000>. Set `PORT` to use another local port.

Or use Docker:

```bash
docker build -t hello-towbar .
docker run --rm -p 127.0.0.1:3000:3000 hello-towbar
```

## Verify the example

```bash
npm test
curl --fail http://localhost:3000/health
```

`/health` returns `{"status":"ok"}`. The tests cover the homepage, health
endpoint, missing routes, request methods, and graceful shutdown.

The `persistent-files`, `platform-modes`, and [independent-oci](independent-oci/README.md) directories contain additional
examples for more advanced deployment features.

Never commit credentials. Store application secrets through Towbar instead of
exposing them in the source tree or health response.
