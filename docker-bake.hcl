# Release images. .github/workflows/release-images.yml bakes the release group
# once per platform on a native runner, so the three images share one builder,
# its base image pulls and its pnpm store cache. Each image is pushed by digest
# only; the manifest job tags the multi-platform indexes.

# The workflow passes repository.json's imageRegistry.
variable "REGISTRY" {
  default = ""
}

variable "PLATFORM" {
  default = "amd64"
}

variable "SOURCE_COMMIT" {
  default = "development"
}

variable "CREATED" {
  default = ""
}

variable "VERSION" {
  default = ""
}

variable "SOURCE_URL" {
  default = ""
}

group "release" {
  targets = ["api", "worker", "web-app"]
}

target "release-image" {
  context   = "."
  platforms = ["linux/${PLATFORM}"]
  attest    = ["type=provenance,mode=max", "type=sbom"]
  args = {
    SOURCE_COMMIT = SOURCE_COMMIT
  }
  labels = {
    "org.opencontainers.image.created"  = CREATED
    "org.opencontainers.image.revision" = SOURCE_COMMIT
    "org.opencontainers.image.source"   = SOURCE_URL
    "org.opencontainers.image.version"  = VERSION
  }
}

target "api" {
  inherits   = ["release-image"]
  dockerfile = "apps/towbar-api/Dockerfile"
  output     = ["type=image,name=${REGISTRY}/towbar-api,push-by-digest=true,name-canonical=true,push=true"]
}

target "worker" {
  inherits   = ["release-image"]
  dockerfile = "apps/towbar-worker/Dockerfile"
  output     = ["type=image,name=${REGISTRY}/towbar-worker,push-by-digest=true,name-canonical=true,push=true"]
}

target "web-app" {
  inherits   = ["release-image"]
  dockerfile = "apps/towbar-web-app/Dockerfile"
  output     = ["type=image,name=${REGISTRY}/towbar-web-app,push-by-digest=true,name-canonical=true,push=true"]
}
