# Gate C lab distribution contract

## Scope

`sonuvi.gate-c-lab-distribution.v1` is a temporary Mac mini service for the
already-signed lab kit. It is not a Sonuvi production service and has no
release publishing, upload, shell, directory-listing, or arbitrary-file API.

Brian approved the temporary lab bind after verifying the intended Mac mini
owns `10.0.0.210` on `en0`. The service binds **only** to
`10.0.0.210:9443` (IPv4): no wildcard, loopback companion, or IPv6 listener.
It rejects every peer outside the trusted `10.0.0.0/16` LAN before resolving
an artifact path. This source restriction complements—rather than replaces—
TLS authentication and the signed-release verification. Do not use a
production Sonuvi listener or make a router/firewall change for this lab
service.

## Fixed endpoint shape

iOS uses the exact host identity and prefix:

```text
https://M4-Mac-mini.local:9443/v1/gate-c/releases/sonuvi-7bfc8c4eb23ef0e00c7718bb4ae5089c42eb6c65fa29c2eb1ea097a080d5c5e7/
```

No redirects, query strings, alternate hosts, release IDs, or endpoint paths
are accepted. The only `GET`/`HEAD` artifacts are:

- `release-envelope.json` — `application/json; charset=utf-8`
- `sonuvi-7bfc8c4eb23ef0e00c7718bb4ae5089c42eb6c65fa29c2eb1ea097a080d5c5e7-linux-arm64.tar` — `application/x-tar`, 53,431,808 bytes
- `sonuvi-bootstrap-kit-v1.tar` — `application/x-tar`, 129,536 bytes
- `release-trust-anchors.json` — `application/json; charset=utf-8`
- `sonuvi-lab-gate-c-20261105-public.pem` — `application/x-pem-file`
- `CHECKSUMS.sha256` — `text/plain; charset=utf-8`
- `ios-integration-handoff.json` — `application/json; charset=utf-8`
- `LAB-README.md` — `text/markdown; charset=utf-8`

### Current signed kit identity

The currently served immutable lab kit is separate from the preserved,
superseded B2-era and pre-status-fix lab releases. It was built from Server
commit `2cba896fdbdd7039600a7331e78cebcfc4b45da9`:

```text
release ID: sonuvi-7bfc8c4eb23ef0e00c7718bb4ae5089c42eb6c65fa29c2eb1ea097a080d5c5e7
release manifest SHA-256: 6ee2231ea7ef2514647ea1c6d1643ceffe09cb1d0137c1718af1777fcf5cefa0
release archive SHA-256: f5375a722c4e82666577899231215f387c2e96751461d1383d3ac3d29ff06f97
bootstrap kit SHA-256: 27b691657e4d8fd12f281b115c700e937072b83fa31da529ddc7bca08874b252
release envelope SHA-256: e33de519d689ad050f27a93a53de4e458e00ec63950b6b0bffa9adc3d78e3f0d
activation capsule SHA-256: 56ccc9df3888b4360da44939bf26a26384cf5219bd076130437b5741713a8bfd
signed metadata validity: 2026-11-05T22:17:52.694Z through 2026-12-05T22:17:52.695Z
```

The capsule accepts the exact `sonuvi.gate-c-bootstrap-kit.v1` inventory
documented in the SFTP contract, including the durable status helper and its
closure. The iOS client still verifies the signed envelope and both payload
digests before any SSH staging or fixed activation.

All other paths return `404`; methods other than `GET`/`HEAD` return `405`.
Range is deliberately unsupported (`416`, `Accept-Ranges: none`), so an
interrupted transfer restarts from byte zero after iOS discards partial bytes.
The client streams the archive to a bounded temporary file and rejects sizes
above the signed `artifact.bytes` (and the 8 GiB hard cap) before SSH staging.

## Independent trust checks

The HTTPS server is authenticated by a lab-only TLS SPKI pin. The signed
release identity is authenticated independently by the published Ed25519
anchor. A valid TLS connection is never sufficient to stage or execute bytes:

Current lab TLS identity:

- subject/SAN hostname: `M4-Mac-mini.local`
- port: `9443`
- TLS SPKI SHA-256 (base64url): `v5i8HdltMqwPlQJa8D1niB1NnqogY3CIbrKf5_4iLpc`
- certificate SHA-256: `0f60a0d502ff5fd397f6f14db9ab0680de26595e368072d46abadcfd546cec76`
- validity: 2026-11-05T15:05:38Z through 2026-12-05T15:05:38Z

The TLS private key is stored only in local lab credential storage. It is not
part of the release kit, source repository, or iOS application.

The matching public leaf DER for the lab iOS build is the fixed local input:

```text
/Volumes/SammySSD/Sonuvi-iOS-Guided-Setup-Lab/ios-inputs/sonuvi-gate-c-lab-distribution-tls-server-cert.der
```

Its SHA-256 is the certificate digest above. It is exported from the
protected local certificate source, not retrieved from this endpoint.

The endpoint is self-signed by design. The reviewed, application-scoped
Security.framework anchor/hostname/validity/leaf/SPKI policy is
[`sonuvi-ios-gate-c-sftp-and-lab-tls.md`](sonuvi-ios-gate-c-sftp-and-lab-tls.md).
It applies only to this literal lab endpoint and never disables normal system
certificate validation for other app traffic.

1. Require TLS 1.3, hostname `M4-Mac-mini.local`, and the configured TLS SPKI pin.
2. Fetch the fixed envelope and public anchor only from the fixed prefix.
3. Verify envelope signature, signer key ID, expiry, ARM64/Linux target,
   manifest hash, archive byte count/digest, and bootstrap digest.
4. Stream each fixed archive once; verify its exact size/digest and the
   published checksum manifest.
5. Only then use the pinned SSH transport to transfer the bootstrap kit,
   invoke fixed prerequisite operations, stream the framed release archive,
   and poll the fixed status operation.

No client authorization secret is used in this local lab mode: server
authentication is the pinned TLS identity, while release authorization is the
signed metadata. The service contains no signing private key.

## Failure behavior

- TLS identity/hostname/pin failure: stop; do not fall back to another host.
- `404`, `405`, `416`, timeout, disconnect, or response length mismatch:
  discard partial bytes and restart the same fixed artifact from zero.
- Expired/bad envelope, unknown release signer, digest/checksum mismatch, or
  unexpected content type: stop before any SSH staging or execution.
- iOS must not construct URLs from envelope fields; envelope metadata carries
  no host, URL, command, or destination path.
