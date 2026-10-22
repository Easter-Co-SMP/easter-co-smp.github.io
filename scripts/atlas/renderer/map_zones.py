# VENDORED -- do not edit by hand.
#
# Copied from e-server's core/map_zones.py by scripts/atlas/renderer/vendor.py, which is the only
# writer of this file. Upstream sha256 f2111177e19f391fc252a5ae231c154765e3ec7abdac50ff9623d6ccd7eeb50e.
# Re-vendor with `python3 scripts/atlas/renderer/vendor.py --upstream /root/e-server --write`;
# tests/test_atlas_renderer_vendor.py fails when this copy and that script disagree.
"""Versioned Overworld polygons shared with the game; atomic writes, never console commands."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

ZONE_FILE = Path(os.environ.get('E_SERVER_MAP_ZONES','/etc/minecraft/map-zones.json'))
ZONE_STATUS = Path(os.environ.get('E_SERVER_MAP_ZONES_STATUS','/run/minecraft/map-zones-status.json'))
LIMIT = 29_999_984
MAX_BYTES = 262144


class ZoneConflict(ValueError):
    pass


def cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def on_segment(a, b, p):
    return cross(a, b, p) == 0 and min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])


def intersects(a, b, c, d):
    x, y, u, v = cross(a,b,c), cross(a,b,d), cross(c,d,a), cross(c,d,b)
    return (x*y < 0 and u*v < 0) or any((n == 0 and on_segment(p,q,r)) for n,p,q,r in ((x,a,b,c),(y,a,b,d),(u,c,d,a),(v,c,d,b)))


def contains(points, x, z):
    inside = False
    for i, a in enumerate(points):
        b = points[(i+1) % len(points)]
        if on_segment(a, b, (x,z)):
            return True
        if (a[1] > z) != (b[1] > z) and x < (b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]:
            inside = not inside
    return inside


def validate_zones(zones):
    if not isinstance(zones, list) or len(zones) > 128:
        raise ValueError('Use at most 128 regions')
    ids = set()
    result = []
    for zone in zones:
        if not isinstance(zone, dict) or set(zone) != {'id','name','short_name','pvp_protection','pve_protection','edit_protection','navy_controlled','guard_patrols','navy_patrols','points'}:
            raise ValueError('A region needs ID, full name, short name, protection flags and points')
        ident = zone['id']
        if not isinstance(ident, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', ident) or ident in ids:
            raise ValueError('Region IDs must be unique lowercase identifiers')
        ids.add(ident)
        for key, limit in [('name',80),('short_name',24)]:
            value = zone[key]
            if not isinstance(value,str) or not value.strip() or len(value)>limit or any(not c.isprintable() for c in value):
                raise ValueError(f'{key} must contain 1–{limit} printable characters')
        if any(type(zone[key]) is not bool for key in ('pvp_protection','pve_protection','edit_protection','navy_controlled','guard_patrols','navy_patrols')):
            raise ValueError('Protection and patrol settings must be true or false')
        if not zone['navy_controlled']:
            zone={**zone,'guard_patrols':False,'navy_patrols':False}
        points = zone['points']
        if not isinstance(points,list) or not 3 <= len(points) <= 256:
            raise ValueError('A region needs 3–256 anchor points')
        if any(not isinstance(p,list) or len(p)!=2 or any(type(n) is not int or abs(n)>LIMIT for n in p) for p in points):
            raise ValueError('Anchor points must be whole-block X/Z coordinates within the world')
        if len({tuple(p) for p in points}) != len(points):
            raise ValueError('Anchor points must be distinct')
        area = sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points,points[1:]+points[:1]))
        if abs(area) < 2:
            raise ValueError('A region must cover at least one square block')
        n = len(points)
        for i in range(n):
            a,b = points[i],points[(i+1)%n]
            c = points[(i+2)%n]
            if cross(a,b,c)==0 and (b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1]) < 0:
                raise ValueError('Border edges cannot double back')
            for j in range(i+1,n):
                if j==i+1 or (i==0 and j==n-1):
                    continue
                if intersects(a,b,points[j],points[(j+1)%n]):
                    raise ValueError('Border edges cannot cross or touch themselves')
        result.append({**zone,'name':zone['name'].strip(),'short_name':zone['short_name'].strip()})
    return result


def read_document(path=None):
    path = path or ZONE_FILE
    blob = path.read_bytes()
    if len(blob)>MAX_BYTES:
        raise ValueError('Region configuration exceeds 256 KiB')
    doc = json.loads(blob)
    if not isinstance(doc,dict) or set(doc)!={'schema','revision','zones'} or type(doc['schema']) is not int or doc['schema']!=1 or type(doc['revision']) is not int or not 1<=doc['revision']<9_007_199_254_740_991:
        raise ValueError('Invalid region configuration version')
    # New boolean properties have explicit defaults for existing saved regions.
    if not isinstance(doc['zones'],list) or any(not isinstance(zone,dict) for zone in doc['zones']):
        raise ValueError('Invalid region list')
    for zone in doc['zones']:
        zone.setdefault('navy_controlled',zone.get('id')=='spawn-island')
        zone.setdefault('guard_patrols',zone.get('id')=='spawn-island')
        zone.setdefault('navy_patrols',False)
    doc['zones'] = validate_zones(doc['zones'])
    return doc, hashlib.sha256(blob).hexdigest()


def game_status(digest):
    try:
        state = json.loads(ZONE_STATUS.read_text())
        if not isinstance(state,dict):
            raise ValueError('Invalid acknowledgement')
        pid = int(state.get('pid',0))
        running = pid>0 and Path('/proc',str(pid)).exists()
        return {'applied':running and state.get('sha256')==digest and not state.get('error'),
                'running':running,'revision':state.get('revision'), 'error':state.get('error')}
    except (OSError,ValueError,TypeError):
        return {'applied':False,'running':False,'revision':None,'error':None}


def view():
    doc,digest = read_document()
    return {**doc,'game':game_status(digest)}


def save(expected_revision, zones):
    if type(expected_revision) is not int:
        raise ValueError('Supply the current revision')
    zones = validate_zones(zones)
    with (ZONE_FILE.parent / (ZONE_FILE.name+'.lock')).open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        old,_ = read_document()
        if old['revision']!=expected_revision:
            raise ZoneConflict('Regions changed in another session. Reload before saving.')
        doc = {'schema':1,'revision':expected_revision+1,'zones':zones}
        blob = (json.dumps(doc,ensure_ascii=False,separators=(',',':'))+'\n').encode()
        if len(blob)>MAX_BYTES:
            raise ValueError('Region configuration exceeds 256 KiB')
        stat = ZONE_FILE.stat()
        fd,temporary = tempfile.mkstemp(prefix='.map-zones-',dir=ZONE_FILE.parent)
        try:
            with os.fdopen(fd,'wb') as stream:
                os.fchmod(stream.fileno(),stat.st_mode & 0o777)
                os.fchown(stream.fileno(),stat.st_uid,stat.st_gid)
                stream.write(blob);stream.flush();os.fsync(stream.fileno())
            os.replace(temporary,ZONE_FILE)
            directory = os.open(ZONE_FILE.parent,os.O_DIRECTORY)
            try: os.fsync(directory)
            finally: os.close(directory)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
    return view()
