#!/usr/bin/env python3
import os, time, json, urllib.request, configparser

CFG = '/etc/peppyspectrum/config.txt'
FIFO_DEFAULT = '/tmp/peppyspectrum'


def load_cfg():
    cp = configparser.ConfigParser()
    cp.read(CFG)
    size = cp.getint('current', 'size', fallback=30)
    maxv = cp.getint('current', 'max.value', fallback=100)
    fifo = cp.get('current', 'pipe.name', fallback=FIFO_DEFAULT)
    target = cp.get('http.interface', 'target.url', fallback='').strip()
    period = cp.getfloat('http.interface', 'update.period', fallback=0.05)
    if period <= 0:
        period = 0.05
    return fifo, size, maxv, target, period


def put_json(url, payload):
    if not url:
        return
    payload.pop("ts", None)  # Server assigns receipt timestamps.
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='PUT', headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + open('/etc/sonuvi-peppy-token').read().strip()})
    with urllib.request.urlopen(req, timeout=0.35):
        pass


def main():
    fifo, size, maxv, target, period = load_cfg()
    if not os.path.exists(fifo):
        os.mkfifo(fifo, 0o666)

    frame_bytes = max(1, 4 * int(size))
    last_sent = 0.0
    data = bytes([0]) * frame_bytes

    while True:
        try:
            fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
            break
        except Exception:
            time.sleep(0.25)

    while True:
        try:
            while True:
                chunk = os.read(fd, frame_bytes)
                if len(chunk) == frame_bytes:
                    data = chunk
                else:
                    break
        except Exception:
            pass

        now = time.time()
        if now - last_sent >= period:
            bins = []
            for i in range(size):
                base = i * 4
                v = data[base] + (data[base+1] << 8) + (data[base+2] << 16) + (data[base+3] << 24)
                if v < 0: v = 0
                if v > maxv: v = maxv
                bins.append(int(v))
            try:
                put_json(target, {
                    'bins': bins,
                    'size': int(size),
                    'maxValue': int(maxv),
                    'ts': int(time.time() * 1000)
                })
            except Exception:
                pass
            last_sent = now

        time.sleep(min(0.02, period / 2))


if __name__ == '__main__':
    main()
