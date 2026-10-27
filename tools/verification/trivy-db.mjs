// The pinned scanner and its vulnerability database sources for verification.
export const trivyScanner =
  "aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969";

// Trivy tries its default mirror first and moves to GHCR only on errors it
// treats as temporary; a plain 404 from the mirror ends the download (CI run
// 40492875814). A failed download is therefore retried against GHCR alone.
export const trivyFallbackDbRepository = "ghcr.io/aquasecurity/trivy-db:2";
