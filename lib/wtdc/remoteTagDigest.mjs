#!/usr/bin/env node
// Resolve the digest a registry currently assigns to an image tag.
//
// Buildx answers this with `docker buildx imagetools inspect`, but the binary
// is not always installed. This probes the OCI registry HTTP API directly —
// one HEAD request plus an anonymous bearer-token exchange when the registry
// asks for one — and prints the digest, or exits nonzero. Docker's own
// `manifest inspect --verbose` cannot produce this value: it reports the
// per-platform *manifest* digest, which is a different thing than the digest
// `docker pull` records in RepoDigests for a multi-arch tag.
//
// Stdout must stay clean JSON/digest output; diagnostics go to stderr.
//   node remoteTagDigest.mjs <image-ref>

import http from "node:http";
import https from "node:https";

const TIMEOUT_MS = 8000;

/** Parse image refs like registry/repo:tag, docker.io/library/debian:12. */
export function parseRef(ref) {
  if (!ref || ref.includes("@")) return null; // digests already are the answer
  const slash = ref.indexOf("/");
  let host, rest;
  if (slash === -1) {
    host = "docker.io";
    rest = ref;
  } else {
    const first = ref.slice(0, slash);
    // A first path segment with . or : (or localhost) is a registry host.
    if (/[.:]/.test(first) || first === "localhost") {
      host = first;
      rest = ref.slice(slash + 1);
    } else {
      host = "docker.io";
      rest = ref;
    }
  }
  const colon = rest.lastIndexOf(":");
  const name = colon > -1 ? rest.slice(0, colon) : rest;
  const tag = colon > -1 ? rest.slice(colon + 1) : "latest";
  if (!name || !tag) return null;
  const repo = host === "docker.io" && !name.includes("/") ? `library/${name}` : name;
  const apiHost =
    host === "docker.io" || host === "index.docker.io" ? "registry-1.docker.io" : host;
  const portSplit = apiHost.lastIndexOf(":");
  const port =
    portSplit > -1 && /^\d+$/.test(apiHost.slice(portSplit + 1))
      ? apiHost.slice(portSplit + 1)
      : "";
  const hostname = port ? apiHost.slice(0, portSplit) : apiHost;
  return { host: hostname, port, repo, tag };
}

function request({ protocol, method, host, port, path, headers }) {
  return new Promise((resolve, reject) => {
    const mod = protocol === "http:" ? http : https;
    const req = mod.request(
      { protocol, hostname: host, port, path, method, headers, timeout: TIMEOUT_MS },
      (res) => {
        res.resume();
        if (method === "GET") {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        } else {
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
        }
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Parse a Bearer realm=…,service=…,scope=… challenge. */
function parseChallenge(header) {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const params = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2];
  return params.realm ? params : null;
}

export async function remoteTagDigest(ref) {
  const parsed = parseRef(ref);
  if (!parsed) throw new Error(`cannot parse image ref: ${ref}`);
  const protocol = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/.test(parsed.host)
    ? "http:"
    : "https:";
  const manifestPath = `/v2/${parsed.repo}/manifests/${parsed.tag}`;
  const accept = { accept: MANIFEST_ACCEPT };

  let res = await request({
    protocol,
    method: "HEAD",
    host: parsed.host,
    port: parsed.port,
    path: manifestPath,
    headers: accept,
  });
  if (res.status === 401) {
    const challenge = parseChallenge(res.headers["www-authenticate"]);
    if (!challenge)
      throw new Error(
        `registry auth challenge unsupported: ${res.headers["www-authenticate"] || "none"}`,
      );
    const scope = challenge.scope || `repository:${parsed.repo}:pull`;
    const realm = new URL(challenge.realm);
    const tokenRes = await request({
      protocol: realm.protocol,
      method: "GET",
      host: realm.hostname,
      port: realm.port || undefined,
      path: `${realm.pathname}?service=${encodeURIComponent(challenge.service || "")}&scope=${encodeURIComponent(scope)}`,
      headers: {},
    });
    if (tokenRes.status !== 200 || !tokenRes.body)
      throw new Error(`anonymous token request failed: HTTP ${tokenRes.status}`);
    const token = JSON.parse(tokenRes.body).token || JSON.parse(tokenRes.body).access_token;
    if (!token) throw new Error("registry token response carried no token");
    res = await request({
      protocol,
      method: "HEAD",
      host: parsed.host,
      port: parsed.port,
      path: manifestPath,
      headers: { ...accept, authorization: `Bearer ${token}` },
    });
  }
  if (res.status !== 200) throw new Error(`registry manifest probe failed: HTTP ${res.status}`);
  const digest = res.headers["docker-content-digest"];
  if (!digest || typeof digest !== "string")
    throw new Error("registry returned no Docker-Content-Digest");
  return digest;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  remoteTagDigest(process.argv[2])
    .then((d) => process.stdout.write(`${d}\n`))
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}
