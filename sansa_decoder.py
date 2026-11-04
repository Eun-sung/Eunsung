"""산사(sansatemple.com) 프레젠스 메시지 디코더 예제.

클라이언트 JavaScript의 검증 코드를 읽고 정리한 형식을 바탕으로 한 오프라인 해석기입니다.
서버에는 연결하지 않으며, 샘플 바이트/JSON을 해석하는 용도로만 씁니다.
형식은 클라이언트가 받아들이는 규칙이며 서버의 실제 동작과 다를 수 있습니다.

실행: python3 sansa_decoder.py   (자체 테스트가 돈다)
"""
import json
import math
import struct

MAGIC = 0x534E5333  # "SNS3"
HEADER_SIZE = 28
MAX_VISITORS = 100
MAX_BYTES = 128 * 1024
POSES = ["walk", "kneel", "beads", "dance"]
INCENSE_TTL_MS = 120_000
INCENSE_START_SKEW_MS = 60_000
MAX_ID_LEN = 80

# header: magic u32 | json_len u32 | record_count u16 | reserved u16 | revision f64 | server_time f64
_HEADER = struct.Struct(">IIHHdd")
# record(30바이트): ">HhBBddd" = seat u16 | cushion i16 | pose u8 | has_bow u8 | x f64 | z f64 | yaw f64


class DecodeError(ValueError):
    pass


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _safe_int(v):
    return isinstance(v, int) and not isinstance(v, bool) and abs(v) < 2**53


def decode_delta(data: bytes) -> dict:
    """바이너리 delta(wire=3)를 해석한다."""
    if len(data) < HEADER_SIZE or len(data) > MAX_BYTES:
        raise DecodeError("Invalid delta size")
    magic, json_len, count, reserved, revision, server_time = _HEADER.unpack_from(data, 0)
    if (
        magic != MAGIC
        or reserved != 0
        or json_len > len(data) - HEADER_SIZE
        or count > MAX_VISITORS
        or not float(revision).is_integer()
        or revision < 0
        or not math.isfinite(server_time)
    ):
        raise DecodeError("Invalid delta header")

    body = json.loads(data[HEADER_SIZE:HEADER_SIZE + json_len].decode("utf-8"))
    if (
        not isinstance(body, dict)
        or not isinstance(body.get("room"), str)
        or not isinstance(body.get("profiles"), list)
        or len(body["profiles"]) > MAX_VISITORS
        or not isinstance(body.get("removed"), list)
        or len(body["removed"]) > MAX_VISITORS
        or any(not isinstance(r, str) or not r for r in body["removed"])
    ):
        raise DecodeError("Invalid delta profiles")

    profiles = {}  # seat -> profile
    for p in body["profiles"]:
        if (
            not isinstance(p, dict)
            or not isinstance(p.get("id"), str) or not p["id"]
            or not isinstance(p.get("name"), str)
            or not isinstance(p.get("color"), str)
            or not _safe_int(p.get("seat")) or not 0 <= p["seat"] < MAX_VISITORS
            or not _finite(p.get("joinedAt"))
        ):
            raise DecodeError("Invalid visitor profile")
        profiles[p["seat"]] = p

    offset = HEADER_SIZE + json_len
    upserts, seen = [], set()
    for _ in range(count):
        if offset + 30 > len(data):
            raise DecodeError("Truncated delta")
        seat, cushion, pose_i, has_bow, x, z, yaw = struct.unpack_from(">HhBBddd", data, offset)
        if seat in seen or pose_i >= len(POSES) or has_bow > 1 or cushion < -1 or cushion >= MAX_VISITORS:
            raise DecodeError("Invalid delta record")
        seen.add(seat)
        if not all(math.isfinite(v) for v in (x, z, yaw)):
            raise DecodeError("Invalid position")
        offset += 30
        rec = {
            "seat": seat,
            "profile": profiles.get(seat),  # 이번 delta에 프로필이 없으면 이전 상태에서 찾아야 한다
            "cushion": None if cushion == -1 else cushion,
            "pose": POSES[pose_i],
            "position": {"x": x, "z": z, "yaw": yaw},
        }
        if has_bow:
            if offset + 8 > len(data):
                raise DecodeError("Truncated bow")
            (bow_at,) = struct.unpack_from(">d", data, offset)
            offset += 8
            if not math.isfinite(bow_at):
                raise DecodeError("Invalid bow")
            rec["bowAt"] = bow_at
        upserts.append(rec)
    if offset != len(data):
        raise DecodeError("Invalid delta length")
    return {
        "type": "delta",
        "room": body["room"],
        "revision": int(revision),
        "serverTime": server_time,
        "removed": body["removed"],
        "upserts": upserts,
    }


def validate_visitors(visitors) -> bool:
    if not isinstance(visitors, list) or len(visitors) > MAX_VISITORS:
        return False
    ids, seats, cushions = set(), set(), set()
    for v in visitors:
        if not isinstance(v, dict):
            return False
        if not isinstance(v.get("id"), str) or not v["id"] or not isinstance(v.get("name"), str):
            return False
        if not isinstance(v.get("color"), str) or not _safe_int(v.get("seat")):
            return False
        if not 0 <= v["seat"] < MAX_VISITORS or not _finite(v.get("joinedAt")):
            return False
        c = v.get("cushion")
        if c is not None and (not _safe_int(c) or not 0 <= c < MAX_VISITORS or c in cushions):
            return False
        if "pose" in v and v["pose"] not in POSES:
            return False
        if "position" in v:
            pos = v["position"]
            if not isinstance(pos, dict) or not all(_finite(pos.get(k)) for k in ("x", "z", "yaw")):
                return False
        if "bowAt" in v and not _finite(v["bowAt"]):
            return False
        if v["id"] in ids or v["seat"] in seats:
            return False
        ids.add(v["id"]); seats.add(v["seat"])
        if c is not None:
            cushions.add(c)
    return True


def validate_offering(o) -> bool:
    """향 한 개: 필드 4개, 유효 시간은 정확히 120초."""
    return (
        isinstance(o, dict) and set(o) == {"id", "visitorId", "at", "expiresAt"}
        and isinstance(o["id"], str) and 0 < len(o["id"]) <= MAX_ID_LEN
        and isinstance(o["visitorId"], str) and 0 < len(o["visitorId"]) <= MAX_ID_LEN
        and _safe_int(o["at"]) and o["at"] >= 0
        and _safe_int(o["expiresAt"]) and o["expiresAt"] - o["at"] == INCENSE_TTL_MS
    )


def read_incense(items, server_time) -> list:
    """snapshot의 향 목록: 중복(ID/방문객) 불가, 유효한 것만 최신순으로."""
    if not isinstance(items, list) or len(items) > MAX_VISITORS:
        raise DecodeError("Invalid incense list")
    ids, visitors = set(), set()
    for o in items:
        if not validate_offering(o) or o["id"] in ids or o["visitorId"] in visitors:
            raise DecodeError("Invalid incense offering")
        ids.add(o["id"]); visitors.add(o["visitorId"])
    live = [o for o in items if o["at"] <= server_time < o["expiresAt"]]
    return sorted(live, key=lambda o: (-o["at"], o["id"]))


def read_incense_queue(q) -> dict:
    """대기열: 필드 4개, activeId는 반드시 맨 앞 사람, 비면 activeId=None/expiresAt=0."""
    if q is None:
        return {"revision": 0, "members": [], "activeId": None, "expiresAt": 0}
    ok = (
        isinstance(q, dict) and set(q) == {"revision", "members", "activeId", "expiresAt"}
        and _safe_int(q["revision"]) and q["revision"] >= 0
        and isinstance(q["members"], list) and len(q["members"]) <= MAX_VISITORS
        and all(isinstance(m, str) and 0 < len(m) <= MAX_ID_LEN for m in q["members"])
        and len(set(q["members"])) == len(q["members"])
        and _safe_int(q["expiresAt"]) and q["expiresAt"] >= 0
    )
    if ok:
        ok = (
            (q["activeId"] == q["members"][0] and q["expiresAt"] != 0)
            if q["members"]
            else (q["activeId"] is None and q["expiresAt"] == 0)
        )
    if not ok:
        raise DecodeError("Invalid incense queue")
    return dict(q)


def read_incense_started(msg, queue, visitors, server_time):
    """의식 시작: {id, at} 정확히 2개. id는 activeId여야 하고 at은 [서버시각-60초, 서버시각]."""
    if msg is None:
        return None
    if (
        not isinstance(msg, dict) or set(msg) != {"id", "at"}
        or msg["id"] != queue["activeId"]
        or not any(v["id"] == msg["id"] for v in visitors)
        or not _safe_int(msg["at"])
        or msg["at"] > server_time or msg["at"] < server_time - INCENSE_START_SKEW_MS
    ):
        raise DecodeError("Invalid incense start")
    return {"id": msg["id"], "at": msg["at"]}


def decode_message(raw):
    """텍스트(JSON) 또는 바이너리(delta) 한 건을 해석한다."""
    if isinstance(raw, (bytes, bytearray)):
        return decode_delta(bytes(raw))
    msg = json.loads(raw)
    if not isinstance(msg, dict):
        raise DecodeError("Message must be an object")
    t = msg.get("type")
    server_time = msg.get("serverTime")
    st = server_time if _finite(server_time) else 0
    if t in ("snapshot", "update"):
        if not validate_visitors(msg.get("visitors")):
            raise DecodeError("Invalid visitors")
        if "revision" in msg and not (_safe_int(msg["revision"]) and msg["revision"] >= 0):
            raise DecodeError("Invalid revision")
        if t == "snapshot":
            if not isinstance(msg.get("selfId"), str) or not any(v["id"] == msg["selfId"] for v in msg["visitors"]):
                raise DecodeError("selfId missing from visitors")
            msg["incense"] = read_incense(msg.get("incense", []), st)
            msg["incenseQueue"] = read_incense_queue(msg.get("incenseQueue"))
            msg["incenseStarted"] = read_incense_started(
                msg.get("incenseStarted"), msg["incenseQueue"], msg["visitors"], st)
    elif t == "incense":
        if not validate_offering(msg.get("offering")):
            raise DecodeError("Invalid offering")
        r = msg.get("removedId")
        if r is not None and (not isinstance(r, str) or not 0 < len(r) <= MAX_ID_LEN or r == msg["offering"]["id"]):
            raise DecodeError("Invalid removedId")
    elif t == "incense-queue":
        msg["queue"] = read_incense_queue(msg.get("queue"))
    elif t in ("incense-result", "incense-queue-result"):
        if not isinstance(msg.get("accepted"), bool):
            raise DecodeError("accepted must be boolean")
    elif t == "event":
        e = msg.get("event")
        if not isinstance(e, dict) or e.get("type") not in ("hello", "bow", "bead", "tap"):
            raise DecodeError("Invalid event")
    return msg


# ---------------------------------------------------------------- 자체 테스트
def _build_delta(room, revision, server_time, profiles, removed, records):
    body = json.dumps({"room": room, "profiles": profiles, "removed": removed}).encode()
    out = _HEADER.pack(MAGIC, len(body), len(records), 0, float(revision), server_time) + body
    for r in records:
        out += struct.pack(">HhBBddd", r["seat"], r.get("cushion", -1), POSES.index(r["pose"]),
                           1 if "bowAt" in r else 0, r["x"], r["z"], r["yaw"])
        if "bowAt" in r:
            out += struct.pack(">d", r["bowAt"])
    return out


def _selftest():
    prof = [{"id": "v1", "name": "나그네", "color": "#a33", "seat": 3, "joinedAt": 1.0}]
    raw = _build_delta("room-1", 7, 1000.0, prof, ["v9"],
                       [{"seat": 3, "cushion": 5, "pose": "kneel", "x": 1.5, "z": -2.0, "yaw": 0.25, "bowAt": 990.0}])
    d = decode_delta(raw)
    assert d["revision"] == 7 and d["removed"] == ["v9"]
    u = d["upserts"][0]
    assert u["pose"] == "kneel" and u["cushion"] == 5 and u["bowAt"] == 990.0 and u["profile"]["name"] == "나그네"

    for bad in (raw[:-1], raw + b"\0", b"\0" * 27):
        try:
            decode_delta(bad)
        except DecodeError:
            pass
        else:
            raise AssertionError("잘못된 delta가 통과함")

    now = 1_000_000
    snap = {
        "type": "snapshot", "room": "room-1", "selfId": "v1", "revision": 7, "serverTime": now,
        "visitors": [{"id": "v1", "name": "나그네", "color": "#a33", "seat": 3, "cushion": None,
                      "joinedAt": 1.0, "pose": "walk", "position": {"x": 0, "z": 4, "yaw": 0}}],
        "incense": [{"id": "i1", "visitorId": "v1", "at": now - 1000, "expiresAt": now - 1000 + INCENSE_TTL_MS},
                    {"id": "i0", "visitorId": "v2", "at": now - 500_000, "expiresAt": now - 500_000 + INCENSE_TTL_MS}],
        "incenseQueue": {"revision": 2, "members": ["v1"], "activeId": "v1", "expiresAt": now + 30_000},
        "incenseStarted": {"id": "v1", "at": now - 5000},
    }
    m = decode_message(json.dumps(snap))
    assert [o["id"] for o in m["incense"]] == ["i1"]  # 만료된 향(i0)은 제외
    assert m["incenseStarted"]["id"] == "v1"

    bad_queue = dict(snap, incenseQueue={"revision": 2, "members": ["v1"], "activeId": "zzz", "expiresAt": 1})
    try:
        decode_message(json.dumps(bad_queue))
    except DecodeError:
        pass
    else:
        raise AssertionError("activeId 불일치가 통과함")

    inc = {"type": "incense", "serverTime": now,
           "offering": {"id": "i2", "visitorId": "v3", "at": now, "expiresAt": now + INCENSE_TTL_MS}, "removedId": "i1"}
    assert decode_message(json.dumps(inc))["offering"]["id"] == "i2"
    print("모든 자체 테스트 통과")


if __name__ == "__main__":
    _selftest()
