# Repository instructions

## Container image builds

Use the GitHub Actions `images` workflow to build and verify images. Push `images/**` changes to `main`, then inspect and watch the resulting workflow run. For non-publishing builds, use a pull request or `workflow_dispatch` with an appropriate tag. Do not build container images on this workstation; its local Docker build is unsuitable for this image's multi-architecture build and verification.
