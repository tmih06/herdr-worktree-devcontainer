#!/usr/bin/env bash
# Run on GitHub Actions runners with Docker and the Dev Container CLI installed.
set -euo pipefail

image=${1:?usage: dind-smoke.sh IMAGE}
workspace=$(mktemp -d)
raw_container="wtdc-dind-$(basename "$workspace" | tr '[:upper:]' '[:lower:]')"
dev_container=

cleanup() {
  local container inspection
  local -a volumes
  if [ -z "$dev_container" ]; then
    dev_container=$(docker ps -aq --filter "label=devcontainer.local_folder=$workspace")
  fi
  while read -r container; do
    inspection=$(docker inspect "$container" 2>/dev/null) || continue
    mapfile -t volumes < <(jq -r '.[0].Mounts[] | select(.Type == "volume") | .Name' <<< "$inspection")
    if [ "${failed:-1}" -ne 0 ]; then
      docker logs "$container" || true
      docker exec -u root "$container" cat /var/log/dockerd.log || true
    fi
    docker rm -f "$container" >/dev/null
    if [ "${#volumes[@]}" -gt 0 ]; then
      # Only remove volumes attached to this test's containers.
      docker volume rm "${volumes[@]}" >/dev/null
    fi
  done < <(printf '%s\n' "$raw_container" "$dev_container")
  rm -rf "$workspace"
}
trap cleanup EXIT

wait_for_docker() {
  local container=$1
  for ((attempt = 0; attempt < 90; attempt++)); do
    if docker exec "$container" docker info >/dev/null 2>&1; then
      return
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
      break
    fi
    sleep 1
  done
  echo "Docker did not become ready in $container" >&2
  return 1
}

check_nested_docker() {
  docker exec "$1" bash -euc '
    test "$(id -un)" = dev
    test "$(docker info --format "{{.DockerRootDir}}")" = /var/lib/docker
    build_dir=$(mktemp -d)
    cd "$build_dir"
    printf "%s\n" "FROM busybox:1.37.0" "RUN echo nested-docker-works > /proof" "CMD [\"cat\", \"/proof\"]" > Dockerfile
    docker buildx build --load --tag wtdc-dind-smoke:local .
    test "$(docker run --rm wtdc-dind-smoke:local)" = nested-docker-works
    printf "%s\n" "services:" "  smoke:" "    image: wtdc-dind-smoke:local" > compose.yaml
    test "$(docker compose run --rm smoke)" = nested-docker-works
    docker compose down
    rm -rf "$build_dir"
  '
}

# Plain Docker uses the image entrypoint and keeps the workspace command as dev.
docker run -d --privileged --init --name "$raw_container" "$image" >/dev/null
wait_for_docker "$raw_container"
check_nested_docker "$raw_container"
docker restart "$raw_container" >/dev/null
wait_for_docker "$raw_container"
test "$(docker exec "$raw_container" docker run --rm wtdc-dind-smoke:local)" = nested-docker-works

# No features or explicit runtime flags: startup and privileges come from metadata.
mkdir -p "$workspace/.devcontainer"
jq -n --arg image "$image" '{image: $image, remoteUser: "dev", updateRemoteUserUID: false}' \
  > "$workspace/.devcontainer/devcontainer.json"
devcontainer up --workspace-folder "$workspace" --log-level error > "$workspace/up.json"
dev_container=$(jq -r .containerId "$workspace/up.json")
test "$(docker inspect --format '{{.HostConfig.Privileged}}' "$dev_container")" = true
test "$(docker inspect --format '{{.HostConfig.Init}}' "$dev_container")" = true
test "$(docker inspect --format '{{.Config.Image}}' "$dev_container")" = "$image"
docker inspect "$dev_container" | jq -e '.[0].Mounts | any(.[]; .Type == "volume" and .Destination == "/var/lib/docker" and (.Name | startswith("wtdc-dind-docker-")))' >/dev/null
docker inspect "$dev_container" | jq -e '.[0].Mounts | any(.[]; .Type == "volume" and .Destination == "/var/lib/containerd" and (.Name | startswith("wtdc-dind-containerd-")))' >/dev/null
wait_for_docker "$dev_container"
check_nested_docker "$dev_container"
devcontainer exec --workspace-folder "$workspace" docker info

failed=0
echo 'Docker-in-Docker smoke checks passed.'
