import {alexaHostname} from './alexa-readiness.mjs';
export const alexaPublicReadPaths=['/now-playing','/track','/art/current.jpg','/art/track_640.jpg','/alexa/was-playing','/config/runtime'];
export const alexaPublicWritePaths=['/queue/advance','/queue/mix','/rating/current','/mpd/prime','/mpd/play-artist','/mpd/artist-alias-suggestion','/mpd/alexa-heard-artist','/mpd/play-album','/mpd/album-alias-suggestion','/mpd/alexa-heard-album','/mpd/play-track','/mpd/play-playlist','/mpd/playlist-alias-suggestion','/mpd/alexa-heard-playlist','/mpd/play-file','/config/queue-wizard/vibe-nowplaying','/config/queue-wizard/vibe-start','/config/queue-wizard/vibe-seed','/config/queue-wizard/vibe-seed-start','/config/queue-wizard/apply','/alexa/was-playing','/alexa/natural-finish'];
// Separate high port preserves the private browser listener. Router external
// TCP443 maps to this port; TLS-ALPN-01 needs no port80/DNS-provider credential.
export function alexaPublicCaddyfile(document){
 const settings=document?.plugins?.alexa;
 if(!settings?.enabled)return null;
 const host=alexaHostname(settings.publicDomain),port=document?.core?.ports?.api;
 if(!host)throw new Error('alexa_public_domain_invalid');
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('alexa_api_port_invalid');
 return `{
 admin off
 https_port 9443
 auto_https disable_redirects
}
https://${host} {
 tls {
  issuer acme {
   ca https://acme-v02.api.letsencrypt.org/directory
   disable_http_challenge
  }
 }
 @read {
  method GET HEAD
  path ${alexaPublicReadPaths.join(' ')}
 }
 handle @read {
  reverse_proxy 127.0.0.1:${port}
 }
 @write {
  method POST
  path ${alexaPublicWritePaths.join(' ')}
 }
 handle @write {
  reverse_proxy 127.0.0.1:${port}
 }
 respond 404
}
`;
}
