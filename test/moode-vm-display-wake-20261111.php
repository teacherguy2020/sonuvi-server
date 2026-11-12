<?php
// Run on the moOde target after stage-vm-display-wake-20261111.sh succeeds.
if ($argc !== 2) { fwrite(STDERR, "usage: php $argv[0] STAGED_DIRECTORY\n"); exit(64); }
$worker = file_get_contents($argv[1] . '/worker.php');
$start = strpos($worker, 'function chkAttachedDisplayPlaybackActive');
$end = strpos($worker, "\n}\n\nfunction chkPeppyScnBlank", $start);
if ($start === false || $end === false) { throw new RuntimeException('could not extract patched playback function'); }
$commands = [];
$stubResponse = '';
function sysCmd($command) { global $commands, $stubResponse; $commands[] = $command; return [$stubResponse]; }
eval(substr($worker, $start, $end - $start + 2));
function checkCase($name, $mpdState, $url, $response, $expected, $expectsVmConfig = null) {
    global $commands, $stubResponse;
    $_SESSION = ['local_display' => '1', 'local_display_url' => $url]; $commands = []; $stubResponse = $response;
    if (chkAttachedDisplayPlaybackActive($mpdState) !== $expected) { throw new RuntimeException("$name: unexpected activity"); }
    $joined = implode("\n", $commands);
    if ($expectsVmConfig === true && !str_contains($joined, '--config /etc/sonuvi-moode-vm/led-curl.conf')) { throw new RuntimeException("$name: VM config was not used"); }
    if ($expectsVmConfig === false && str_contains($joined, '--config /etc/sonuvi-moode-vm/led-curl.conf')) { throw new RuntimeException("$name: VM config leaked"); }
    if ($mpdState === 'play' && $commands !== []) { throw new RuntimeException("$name: local MPD was not authoritative"); }
}
$vm = 'https://10.0.0.65:8443/display.html?mode=index&kiosk=1';
$other = 'https://display.example:8443/display.html?kiosk=1';
checkCase('local play health', 'play', $vm, '{"state":"health"}', true, false);
checkCase('local play paused', 'play', $vm, '{"state":"pause"}', true, false);
checkCase('local play error', 'play', $vm, '401 unauthorized', true, false);
checkCase('pretty play', 'pause', $vm, "{\n  \"state\": \"play\"\n}", true, true);
checkCase('AirPlay', 'pause', $vm, '{"state":"pause","isAirplay":true}', true, true);
checkCase('UPnP', 'pause', $vm, '{"state":"pause","isUpnp":true}', true, true);
checkCase('Mills', 'pause', $vm, '{"state":"pause","displayMode":"mills"}', true, true);
checkCase('paused', 'pause', $vm, '{"state":"pause"}', false, true);
checkCase('stopped', 'stop', $vm, '{"state":"stop"}', false, true);
checkCase('health only', 'pause', $vm, '{"state":"health"}', false, true);
checkCase('malformed', 'pause', $vm, '{not json', false, true);
checkCase('HTTP 401', 'pause', $vm, '401 unauthorized', false, true);
checkCase('non-VM host', 'pause', $other, '{"state":"play"}', true, false);
echo "PASS: patched worker playback cases\n";
