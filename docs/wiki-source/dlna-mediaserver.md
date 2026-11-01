---
title: Native DLNA MediaServer
page_type: architecture
topics:
  - dlna
  - upnp
  - media-library
  - openhome
confidence: high
updated: 2026-11-01
---

# Native DLNA MediaServer

## Purpose and boundary

The optional native MediaServer makes the existing Sonuvi Browse Index v3
available to ordinary UPnP AV/DLNA controllers as **Sonuvi Music Library**.
It is a music source, not an OpenHome renderer and not a replacement for the
existing Sonuvi UPnP control point. A controller supplies its selected media
URLs and DIDL-Lite metadata to an OpenHome renderer; the renderer owns its
own persistent queue and fetches audio directly from Sonuvi Server.

The implementation must never modify MPD, moOde, BubbleUPnP, a renderer queue,
or music files. It reads the read-only `/mnt/SamsungMoode` mount and existing
Browse Index v3 only. In particular, DLNA browsing never runs ffprobe, scans
the filesystem, or changes the bounded quality-enrichment checkpoint.

## Configuration and lifecycle

`features.dlnaMediaServer` is an existing-runtime-config feature flag exposed
by **Enable DLNA MediaServer** in `config.html`. Its default is `false`.
Changing the setting is applied at the normal Sonuvi Server restart boundary:
when disabled, the server registers no DLNA HTTP routes and opens no SSDP
socket. When enabled, it persists a UDN below Sonuvi runtime state, registers
the standard HTTP service endpoints, and sends/responds to SSDP only on the
private LAN address.

No `.local` hostname is used in advertised device or media URLs. The service
uses the configured API private IPv4 address (or a detected private interface)
so legacy renderers can retrieve durable `http://<LAN-IP>:3101/dlna/media/...`
references without the originating controller remaining open.

## Catalog and protocol surface

`src/lib/dlna-media-server.mjs` is the service implementation. It reuses the
normalized v3 records and derives opaque stable IDs from catalog keys/file
paths. The hierarchy is:

`0` → Artists / Albums / Genres → artist/album/genre containers → tracks.

The ContentDirectory service supports `Browse`, metadata/direct-children
navigation, pagination, and DIDL-Lite output. Its declared search/sort
capabilities are empty; it does not claim proprietary search behavior.
ConnectionManager advertises the original supported local audio MIME types.
There is no transcode path.

## Media delivery and security

`/dlna/media/:trackId` accepts only an opaque ID for a current Browse Index
track. It resolves the corresponding MPD file through the existing local mount
mapper, requires it to remain beneath the mount, requires an allowlisted audio
extension, and serves only existing files. It supports `GET`, `HEAD`, and a
single RFC 7233 byte range with correct `206`, `Content-Range`,
`Content-Length`, and `Accept-Ranges` headers. Invalid IDs, unavailable files,
unsupported formats, and traversal attempts receive `404` (or `416` for an
invalid range); nothing permits arbitrary host file reads or writes.

## Validation boundary

Unit coverage in `test/dlna-media-server.test.mjs` covers disabled isolation,
private LAN selection, durable UDNs, Browse/DIDL pagination and escaping,
range delivery, and path isolation. Physical controller/OpenHome validation
requires a separately authorized test activation because it would advertise a
live Sonuvi source on the home LAN. moOde's existing MediaServer remains
enabled until that acceptance sequence passes.
