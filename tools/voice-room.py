#!/usr/bin/env python3
# Who is in the voice room, read-only: each LiveKit participant's identity (the character's actor id in hex), when it
# joined, its tracks, and whether its microphone is open. For "Double Voice" style reports (1 Oct): a participant twice,
# or two audio tracks, means a ghost; a mic open sample after sample is a player on voice activation, and if they are
# on speakers with no echo cancellation they send nearby voices back.
#   sudo python3 tools/voice-room.py            one listing
#   sudo python3 tools/voice-room.py --watch 8  eight samples, 10 s apart
# It reads server-settings.json's voiceChat (root only), signs a 60-second roomList token in memory, never prints a key
# or token, and calls only ListRooms and ListParticipants.
import base64, hashlib, hmac, json, sys, time, urllib.request
from collections import Counter

SETTINGS = '/opt/alduinak/build/dist/server/server-settings.json'


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def main():
    vc = json.load(open(SETTINGS)).get('voiceChat') or {}
    url, key, secret, room = vc.get('url', ''), vc.get('apiKey', ''), vc.get('apiSecret', ''), vc.get('room', 'dragonbreak')
    if not (url and key and secret):
        sys.exit('voiceChat has no url/apiKey/apiSecret: voice is off here')
    base = url.replace('wss://', 'https://').replace('ws://', 'http://').rstrip('/')

    def call(method, body):
        now = int(time.time())
        head = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
        claims = b64(json.dumps({'iss': key, 'sub': 'staff-voice-room', 'nbf': now - 10, 'exp': now + 60,
                                 'video': {'roomList': True, 'roomAdmin': True, 'room': room}}).encode())
        sig = b64(hmac.new(secret.encode(), f'{head}.{claims}'.encode(), hashlib.sha256).digest())
        req = urllib.request.Request(f'{base}/twirp/livekit.RoomService/{method}', data=json.dumps(body).encode(),
                                     headers={'Authorization': f'Bearer {head}.{claims}.{sig}', 'Content-Type': 'application/json'})
        return json.load(urllib.request.urlopen(req, timeout=10))

    samples = 1
    if '--watch' in sys.argv:
        i = sys.argv.index('--watch')
        samples = max(1, min(60, int(sys.argv[i + 1]) if i + 1 < len(sys.argv) else 8))
    opened = Counter()
    for n in range(samples):
        parts = call('ListParticipants', {'room': room}).get('participants', [])
        stamp = time.strftime('%H:%M:%SZ', time.gmtime())
        if n == 0:
            rooms = call('ListRooms', {}).get('rooms', [])
            print(f'{stamp} rooms: ' + ', '.join(f"{r.get('name')} ({r.get('num_participants', 0)} in)" for r in rooms))
            for p in sorted(parts, key=lambda x: x.get('identity', '')):
                tracks = [f"{t.get('type')}/{t.get('source')}{'' if t.get('muted') else ' OPEN'}" for t in p.get('tracks', [])]
                joined = time.strftime('%H:%M:%SZ', time.gmtime(int(p.get('joined_at', 0) or 0)))
                print(f"  {p.get('identity')}  joined {joined}  {p.get('state')}  tracks: {', '.join(tracks) or 'none'}")
            twice = [i for i, c in Counter(p.get('identity') for p in parts).items() if c > 1]
            many = [p.get('identity') for p in parts if sum(1 for t in p.get('tracks', []) if t.get('type') == 'AUDIO') > 1]
            print(f'  in the room twice: {twice or "nobody"}; more than one audio track: {many or "nobody"}')
        for p in parts:
            if any(not t.get('muted') for t in p.get('tracks', [])):
                opened[p.get('identity')] += 1
        if samples > 1:
            print(f"{stamp} open: {' '.join(sorted(i for i in opened if any(not t.get('muted') for p in parts if p.get('identity') == i for t in p.get('tracks', [])))) or '-'}")
            if n + 1 < samples:
                time.sleep(10)
    if samples > 1:
        print('mic open in samples: ' + ', '.join(f'{i} {c}/{samples}' for i, c in opened.most_common()) if opened else 'no mic opened')


if __name__ == '__main__':
    main()
