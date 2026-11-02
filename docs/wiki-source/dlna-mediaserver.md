---
title: Native DLNA MediaServer
page_type: architecture
topics:
  - dlna
  - upnp
  - media-library
  - openhome
confidence: high
updated: 2026-11-02
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
or music files. The production mount intentionally remains read-write for
separate Library Health metadata-editing capability, but DLNA is strictly
application-level read-only and reads the existing Browse Index v3 only. In
particular, DLNA browsing never runs ffprobe, scans
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
capabilities are empty; it does not claim proprietary search behavior. Its
SCPD declares each action's arguments, directions, related state variables,
data types, and Browse flag constraints. ConnectionManager likewise exposes a
complete SCPD, reports connection ID `0`, and supplies limited standard
MediaServer output connection information for that ID; invalid IDs return the
UPnP `706 No Such Connection` fault. It advertises the original supported
local audio MIME types. There is no transcode path.

For a track whose existing Server artwork resolver returns a valid image,
DIDL-Lite includes the standard, namespace-qualified
`upnp:albumArtURI` element. The URI is an absolute renderer-facing
`http://<LAN-IP>:3101/dlna/artwork/<opaque-track-id>` reference. Native
ContentDirectory responses and the authenticated mobile DLNA resource payload
use the same serializer, so an OpenHome controller receives the identical
metadata it would receive from native Browse. Tracks with no resolved artwork
omit the element rather than advertising a placeholder or broken URI.

When enabled, DLNA SOAP control requests produce one narrowly scoped service
log event containing only service name, action, and HTTP status. The logger
never records SOAP bodies, music metadata, paths, or credentials. This is for
bounded interoperability diagnostics and is not an access log.

## Media delivery and security

`/dlna/media/:trackId` accepts only an opaque ID for a current Browse Index
track. It resolves the corresponding MPD file through the existing local mount
mapper, requires it to remain beneath the mount, requires an allowlisted audio
extension, and serves only existing files. It supports `GET`, `HEAD`, and a
single RFC 7233 byte range with correct `206`, `Content-Range`,
`Content-Length`, and `Accept-Ranges` headers. Invalid IDs, unavailable files,
unsupported formats, and traversal attempts receive `404` (or `416` for an
invalid range); nothing permits arbitrary host file reads or writes.

`/dlna/artwork/:trackId` is intentionally separate from the bearer-protected
mobile artwork API: a renderer must retrieve an advertised cover without a
mobile token. It accepts only `GET` and `HEAD` for an opaque ID that resolves
to a current Browse Index track, never a filesystem path or arbitrary artwork
URL. The Server resolves that approved track through the existing moOde cover
cache/resizer and returns a JPEG only when an image is available; absent or
unknown artwork returns `404`. The route is registered only while the optional
DLNA MediaServer is enabled. Artwork resolution has a bounded 64-entry,
five-minute cache, and a Browse response performs no more than 24 uncached
album-art lookups, so large catalog browsing cannot trigger an unbounded burst
of image work. Audio delivery, byte-range behavior, and mobile bearer
authentication are unchanged.

## Validation boundary

Unit coverage in `test/dlna-media-server.test.mjs` covers disabled isolation,
private LAN selection, durable UDNs, complete SCPD/action consistency,
ConnectionManager ID-0 and invalid-ID faults, SOAP diagnostics privacy,
Browse/DIDL pagination and escaping, range delivery, and path isolation.
It also verifies standard artwork metadata in both native Browse and the
mobile DLNA resource payload; the renderer-facing image route supports
`GET`/`HEAD`, rejects unsupported methods and unknown IDs, and omits artwork
cleanly when unavailable.
Physical controller/OpenHome validation
requires a separately authorized test activation because it would advertise a
live Sonuvi source on the home LAN. moOde's existing MediaServer remains
enabled until that acceptance sequence passes.

## Compatibility status

UnPlay on Apple TV has verified Sonuvi FLAC playback and track title/artist
display. Before this Server correction, read-only inspection of its active
OpenHome queue showed no `upnp:albumArtURI`; physical Apple TV artwork
acceptance remains pending after an authorized deployment and feature-enabled
test.
