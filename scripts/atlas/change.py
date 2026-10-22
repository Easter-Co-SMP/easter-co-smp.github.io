"""Question one: has the world changed since the last snapshot?

The answer costs two reads -- one `DescribeInstances` and one `GetObject` of the pointer --
and it uses no store of its own. EC2 already knows when the instance was launched and when
it last changed state; the pointer knows those two facts as of the capture we published. If
neither has moved the world cannot have been written since, because the only thing that
writes it is the server on that instance.

The two fields, and why each is compared:

* `LaunchTime` changes only when the instance is replaced or rebuilt. A different launch
  time means we are looking at a different machine from the one the pointer describes.
* the timestamp inside `StateTransitionReason` (`User initiated (2026-10-21 12:00:00 GMT)`)
  changes on every start and every stop, which is exactly the granularity we need: the
  pointer records the transition that ended the session we captured, so any later start or
  stop -- a player playing, the launcher waking it, a lifecycle policy -- is visible even
  though `LaunchTime` never moves for a stopped-then-started instance.

A running instance is never captured here. If it is running, somebody is using it (a
player, or the launcher's wake path), and waking is not ours to interrupt: the run defers
and says so. That also means the pipeline never stops a host it did not start.

Everything is deliberately biased towards capture. An unparseable state transition, a
missing launch time, a pointer we cannot read: all of them mean "capture", because the cost
of a needless capture is one hour of an already-cheap render, and the cost of a wrongly
skipped one is a public map that silently stops changing.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import re

#: `User initiated (2026-10-21 12:00:00 GMT)`, which is the shape EC2 actually emits.
_TRANSITION_STAMP = re.compile(r"\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) GMT\)")


class ChangeError(RuntimeError):
    """EC2 or the pointer said something the pipeline cannot trust."""


@dataclass(frozen=True)
class Decision:
    """What the run should do next, and the one line that says why."""

    action: str          # 'capture' | 'unchanged' | 'defer'
    reason: str
    line: str
    instance: dict

    @property
    def needs_capture(self):
        return self.action == "capture"


def parse_transition_reason(reason):
    """The UTC instant inside a `StateTransitionReason`, or None when it has none.

    Returns None rather than raising: a reason without a timestamp is not an error, it is a
    machine that never transitioned (`-` on a fresh launch) and the caller decides.
    """
    if not isinstance(reason, str):
        return None
    match = _TRANSITION_STAMP.search(reason)
    if not match:
        return None
    return datetime.strptime(match.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def normalize_instant(value):
    """An ISO-8601 instant as UTC seconds, or None. Tolerates `Z`, offsets and EC2's form."""
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        match = _TRANSITION_STAMP.search(text)
        if not match:
            return None
        return datetime.strptime(match.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def describe(ec2, instance_id):
    """The three fields this module compares, from one DescribeInstances call."""
    try:
        response = ec2.describe_instances(InstanceIds=[instance_id])
    except Exception as error:  # noqa: BLE001 - a refusal with a name beats a traceback
        raise ChangeError(f"DescribeInstances failed for {instance_id}: {error}") from error
    reservations = response.get("Reservations") or []
    if len(reservations) != 1 or len(reservations[0].get("Instances") or []) != 1:
        raise ChangeError(f"DescribeInstances returned no single instance for {instance_id}: "
                          f"{len(reservations)} reservations")
    instance = reservations[0]["Instances"][0]
    state = (instance.get("State") or {}).get("Name")
    if state not in {"pending", "running", "shutting-down", "stopped", "stopping", "terminated"}:
        raise ChangeError(f"instance {instance_id} reported an unknown state {state!r}")
    return {
        "instance_id": instance_id,
        "state": state,
        "launch_time": instance.get("LaunchTime"),
        "state_transition_reason": instance.get("StateTransitionReason"),
    }


def read_pointer(s3, bucket, key):
    """The pointer document, or None when there is no pointer yet."""
    try:
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    except Exception as error:  # botocore's NoSuchKey and a stub's refusal alike
        if _is_missing(error):
            return None
        raise ChangeError(f"cannot read the snapshot pointer s3://{bucket}/{key}: {error}") from error
    try:
        return json.loads(body.decode("utf8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ChangeError(f"pointer s3://{bucket}/{key} is not JSON: {error}") from error


def _is_missing(error):
    name = type(error).__name__
    code = ""
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        code = str((response.get("Error") or {}).get("Code") or "")
    return name in {"NoSuchKey", "ResourceNotFound", "MissingObject"} or code in {
        "NoSuchKey", "404", "NotFound"}


def decide(instance, pointer):
    """Compare EC2's own facts with the pointer. Pure, so every branch is testable."""
    if pointer is None:
        return Decision("capture", "no_pointer",
                        "change: no snapshot pointer yet -> capture (first run)", instance)
    if pointer.get("instance_id") and pointer["instance_id"] != instance["instance_id"]:
        return Decision(
            "capture", "different_instance",
            f"change: field=instance_id {instance['instance_id']} != pointer "
            f"{pointer['instance_id']} -> capture", instance)

    launch_now = normalize_instant(instance.get("launch_time"))
    launch_then = normalize_instant(pointer.get("launch_time"))
    if launch_now is None or launch_then is None:
        return Decision(
            "capture", "launch_time_unreadable",
            "change: field=launch_time unreadable (EC2 "
            f"{instance.get('launch_time')!r} vs pointer {pointer.get('launch_time')!r}) "
            "-> capture", instance)
    if launch_now != launch_then:
        return Decision(
            "capture", "launch_time_changed",
            f"change: field=launch_time {launch_now.isoformat()} != pointer "
            f"{launch_then.isoformat()} -> capture (the instance was replaced)", instance)

    transition_now = parse_transition_reason(instance.get("state_transition_reason"))
    pointer_transition = pointer.get("state_transition_at")
    transition_then = normalize_instant(pointer_transition)
    if transition_now is None or transition_then is None:
        return Decision(
            "capture", "state_transition_unreadable",
            "change: field=state_transition_reason unreadable (EC2 "
            f"{instance.get('state_transition_reason')!r} vs pointer {pointer_transition!r}) "
            "-> capture", instance)

    if instance["state"] == "running":
        return Decision(
            "defer", "host_running",
            f"change: field=state_transition_reason state=running at "
            f"{transition_now.isoformat()} -> defer (the host is up; a player or the "
            "launcher is using it, so this run captures nothing and stops nothing)",
            instance)
    if instance["state"] != "stopped":
        return Decision(
            "defer", "host_transitioning",
            f"change: field=state state={instance['state']} -> defer (wait for the host to "
            "settle; nothing is started or stopped here)", instance)

    if transition_now != transition_then:
        return Decision(
            "capture", "state_transition_changed",
            f"change: field=state_transition_reason {instance.get('state_transition_reason')!r} "
            f"({transition_now.isoformat()}) != pointer {transition_then.isoformat()} -> capture "
            "(the host started or stopped since the last capture)", instance)

    return Decision(
        "unchanged", "same_launch_and_transition",
        f"change: field=launch_time {launch_now.isoformat()} and field=state_transition_reason "
        f"{transition_now.isoformat()} match the pointer captured_at "
        f"{pointer.get('captured_at')} -> unchanged (no capture, no wake, no commit)", instance)


def detect(ec2, s3, settings):
    """Ask both questions in the cheapest order: the pointer first, then EC2."""
    pointer = read_pointer(s3, settings.bucket, settings.pointer_key)
    instance = describe(ec2, settings.require_instance())
    return decide(instance, pointer)
