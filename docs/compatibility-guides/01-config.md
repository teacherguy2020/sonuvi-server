# Config

![Config tab](../images/01-config.jpg)

Use this page to set up how the app connects to your system.

## What this page is for
- Telling the app where moOde and MPD live
- Turning features on/off (Alexa, podcasts, notifications, animated art)
- Saving runtime settings

## What the main controls do
- **Save settings / Save configuration**: writes your changes to config.
- **Check SSH + Paths**: tests your SSH/path setup so jobs can run correctly.
- **Reload**: reloads current config values from disk.

## Common tasks
### First-time setup
1. Enter MPD host/port and web/API ports.
2. Enter moOde host/base URL.
3. Set your `trackKey`.
4. Click **Check SSH + Paths**.
5. Save settings.

### Turn features on/off
- Toggle feature checkboxes (Alexa, podcasts, etc.)
- Save settings

### Configure the moOde display, wake, and LED path
1. In moOde, open **Configure -> Peripherals -> Local Display**.
2. Set **Web UI target URL** to:
   `https://sonuvi.local/display.html?mode=index&kiosk=1`
3. Keep the URL on HTTPS and do not add `:8101`.
4. Apply the version-matched moOde maintenance patches to these existing files:
   - `/var/www/daemon/worker.php` (blanking/wake state)
   - `/var/www/daemon/watchdog.sh` (wake decisions)
   - `/usr/local/bin/rgb_moode_service.py` (Mills LED state)
5. Stage and syntax-check the three files before restarting their services. Do
   not replace a whole moOde daemon file from a different release, and do not
   copy the root-only authenticated curl configuration into source control.
6. Re-pair the display/LED session after a server or target-URL change if the
   current authenticated grant has expired.

The Config page checks the browser target and shows this procedure; it does
not edit root-owned moOde daemon files or move private pairing credentials.

## If something looks wrong
- API/Web badges wrong? Re-check host/port fields here.
- Alexa not behaving? Re-check Alexa/domain fields and save.
- Changes not taking effect? Restart API/webserver.
