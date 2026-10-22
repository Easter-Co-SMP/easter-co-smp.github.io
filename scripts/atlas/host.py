"""Question two: wake the host, capture, and stop it again -- on every exit path.

The only thing in this pipeline that can cost real money or hurt a player is this module,
so its rules are narrow and stated here rather than implied by the code:

* **It only ever stops an instance it started.** If EC2 already says `running`, something
  else is using the host (a player, the launcher's wake path) and change detection has
  already deferred; `capture()` refuses rather than interrupting.
* **The stop is not a line at the end of the happy path.** It is in a `finally`, it runs
  after a failure in every stage, and its result is checked: `stop_instances` is called once,
  and the instance is then described until EC2 reports `stopping` or `stopped`. A stop that
  cannot be confirmed raises `StopNotConfirmed` -- leaving the production server running is
  its own incident, and it must be louder than whatever failed first.
* **Nothing is assumed about the host.** The two things it must do -- be ready, and capture --
  are committed scripts sent over SSM (`host/ready-check.sh`, `host/snapshot.sh`), whose
  output comes back in the log. There is no hand-typed shell string anywhere in this module.
* **The upload is confirmed by the pipeline, not by the host.** The host's sidecar claims a
  sha256 and a byte count; this module reads the sidecar and the object's real size from S3
  and refuses unless they agree.

Timing is bounded everywhere (`settings.start_timeout_seconds`, `ready_timeout_seconds`,
`snapshot_timeout_seconds`), because a hung waiter on a billable instance is a defect.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import base64
import json
from pathlib import Path
import shlex
import time

from . import change, contract
from .config import ConfigError

HOST_DIR = Path(__file__).resolve().parent / "host"
READY_SCRIPT = HOST_DIR / "ready-check.sh"
SNAPSHOT_SCRIPT = HOST_DIR / "snapshot.sh"

#: SSM Run Command's own terminal statuses; anything else means we are still waiting.
TERMINAL_STATUSES = frozenset({"Success", "Failed", "Cancelled", "TimedOut", "Undeliverable",
                               "Terminated", "AccessDenied", "InvalidPlatform",
                               "DeliveryTimedOut"})


class HostError(RuntimeError):
    """A capture stage failed. The instance is stopped before this reaches the caller."""


class StopNotConfirmed(HostError):
    """The stop was attempted and EC2 would not confirm it. Never swallowed."""


@dataclass
class CaptureFacts:
    """What the pipeline knows about the capture once the host is stopped again."""

    instance_id: str
    started_by_pipeline: bool
    launch_time: str | None
    state_transition_at: str | None
    state_transition_reason: str | None
    sidecar: dict = field(default_factory=dict)
    stages: list = field(default_factory=list)
    stopped: bool = False

    @property
    def captured_at(self):
        return self.sidecar.get("captured_at")

    @property
    def tar_sha256(self):
        return self.sidecar.get("tar_sha256")

    @property
    def tar_bytes(self):
        return int(self.sidecar.get("tar_bytes") or 0)


def _read(path):
    try:
        return path.read_text(encoding="utf8")
    except OSError as error:
        raise ConfigError(f"cannot read the committed host script {path}: {error}") from error


def script_command(script_path, environment):
    """The SSM command line that runs one committed script with these variables.

    The script travels base64-encoded inside the command, so what runs on the host is the
    reviewed bytes from this repository and not an interpolation of them. Every value is
    shell-quoted, and a value containing a quote is escaped rather than trusted: these
    strings come from repository variables, but "came from configuration" is not a reason to
    hand a shell a surprise.
    """
    payload = base64.b64encode(_read(Path(script_path)).encode("utf8")).decode("ascii")
    exports = " ".join(f"{name}={shlex.quote(str(value))}" for name, value in environment.items())
    return (
        f"export {exports}; "
        f"printf %s {shlex.quote(payload)} | base64 -d > /tmp/atlas-step.sh && "
        f"bash /tmp/atlas-step.sh"
    )


class HostCapture:
    """Wake, wait, capture, confirm, stop. One object per run, used once."""

    def __init__(self, ec2, ssm, s3, settings, log=print, sleep=time.sleep,
                 monotonic=time.monotonic):
        self.ec2 = ec2
        self.ssm = ssm
        self.s3 = s3
        self.settings = settings
        self.log = log
        self.sleep = sleep
        self.monotonic = monotonic
        self._start_attempted = False
        self._stages = []

    # ── the one public entry point ─────────────────────────────────────────────────────
    def capture(self):
        """Capture the world, then stop the instance no matter how that went."""
        primary = None
        facts = None
        try:
            facts = self._capture_stages()
            return facts
        except BaseException as error:  # noqa: BLE001 - every failure must reach the stop
            primary = error
            raise
        finally:
            stopped, stop_error, instance = self._stop_once()
            if facts is not None:
                # The pointer's EC2 facts come from AFTER the stop, so the next run's
                # comparison matches on our own capture-and-stop instead of seeing it as
                # activity that happened since. A later start-then-stop by somebody else
                # still moves the timestamp and is still caught.
                facts.stopped = stopped
                if instance is not None:
                    transition = change.parse_transition_reason(
                        instance.get("state_transition_reason"))
                    facts.launch_time = _iso(instance.get("launch_time"))
                    facts.state_transition_at = (None if transition is None
                                                 else transition.isoformat())
                    facts.state_transition_reason = instance.get("state_transition_reason")
            if not stopped:
                message = (f"the instance {self.settings.instance_id} was NOT confirmed stopped "
                           f"after {', '.join(self._stages) or 'no stage'}: {stop_error}. "
                           "The production server may still be running.")
                self.log("atlas: STOP NOT CONFIRMED -- " + message)
                if primary is None:
                    raise StopNotConfirmed(message)
            elif primary is None:
                self.log(f"atlas: instance {self.settings.instance_id} stopped "
                         f"(stages: {', '.join(self._stages)})")

    # ── stages ────────────────────────────────────────────────────────────────────────
    def _capture_stages(self):
        self._start()
        self._wait_until_ready()
        self._run_snapshot()
        return self._confirm_upload()

    def _start(self):
        """Start the instance, or refuse to touch one that is already up."""
        instance_id = self.settings.require_instance()
        instance = change.describe(self.ec2, instance_id)
        if instance["state"] in ("running", "pending"):
            raise HostError(
                f"instance {instance_id} is already {instance['state']}; this run did not start "
                "it, so it will not capture from it or stop it")
        if instance["state"] == "stopping":
            self.log(f"atlas: instance {instance_id} is still stopping; waiting for it")
            self._wait_for_state(("stopped",), self.settings.start_timeout_seconds,
                                 what="the stopping host to settle")
        elif instance["state"] != "stopped":
            raise HostError(f"instance {instance_id} is {instance['state']}; cannot capture from it")
        self.log(f"atlas: starting instance {instance_id}")
        self._start_attempted = True
        self._stages.append("start")
        try:
            response = self.ec2.start_instances(InstanceIds=[instance_id])
        except Exception as error:  # noqa: BLE001 - the stop below still runs, then this raises
            raise HostError(f"instance {instance_id} could not be started: {error}") from error
        state = ((response.get("StartingInstances") or [{}])[0].get("CurrentState") or {}).get("Name")
        self.log(f"atlas: start_instances accepted (state {state})")
        self._wait_for_state(("running",), self.settings.start_timeout_seconds,
                             what="the instance to reach running")

    def _wait_until_ready(self):
        command_id = self._send(READY_SCRIPT, {
            "ATLAS_SERVER_UNIT": self.settings.server_unit,
            "ATLAS_SERVER_LOG": self.settings.log_path,
            "ATLAS_READY_TIMEOUT": self.settings.ready_timeout_seconds,
        }, what="ready-check")
        self._stages.append("ready")
        self._wait_command(command_id, self.settings.ready_timeout_seconds, what="ready-check")

    def _run_snapshot(self):
        command_id = self._send(SNAPSHOT_SCRIPT, {
            "ATLAS_BUCKET": self.settings.bucket,
            "ATLAS_SNAPSHOT_KEY": self.settings.snapshot_key,
            "ATLAS_SIDECAR_KEY": self.settings.sidecar_key,
            "ATLAS_CONSOLE": self.settings.console_command,
            "ATLAS_CAPTURE_ID": f"atlas-{int(time.time())}",
        }, what="snapshot")
        self._stages.append("snapshot")
        self._wait_command(command_id, self.settings.snapshot_timeout_seconds, what="snapshot")

    def _confirm_upload(self):
        """The host said it uploaded; S3 and the sidecar have to agree."""
        self._stages.append("confirm")
        try:
            sidecar_body = self.s3.get_object(
                Bucket=self.settings.bucket, Key=self.settings.sidecar_key)["Body"].read()
        except Exception as error:  # noqa: BLE001 - any read failure is the same refusal
            raise HostError(f"the host reported success but its sidecar "
                            f"s3://{self.settings.bucket}/{self.settings.sidecar_key} cannot be "
                            f"read: {error}") from error
        try:
            sidecar = json.loads(sidecar_body.decode("utf8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HostError(f"the sidecar is not JSON: {error}") from error
        missing = contract.SIDECAR_KEYS - set(sidecar)
        if missing:
            raise HostError("the sidecar is missing " + ", ".join(sorted(missing)))
        head = self.s3.head_object(Bucket=self.settings.bucket, Key=self.settings.snapshot_key)
        size = int(head.get("ContentLength") or 0)
        claimed = int(sidecar.get("tar_bytes") or 0)
        if size != claimed:
            raise HostError(f"the uploaded snapshot is {size} bytes but the host claims "
                            f"{claimed}; refusing a capture that may be truncated")
        if size <= 0 or not sidecar.get("tar_sha256"):
            raise HostError("the uploaded snapshot is empty or unhashed")
        self.log(f"atlas: upload confirmed: s3://{self.settings.bucket}/"
                 f"{self.settings.snapshot_key} {size} bytes sha256 {sidecar['tar_sha256']}")

        instance = change.describe(self.ec2, self.settings.instance_id)
        return CaptureFacts(
            instance_id=self.settings.instance_id,
            started_by_pipeline=self._start_attempted,
            launch_time=_iso(instance.get("launch_time")),
            state_transition_at=None,   # filled in after the stop, from EC2's own words
            state_transition_reason=instance.get("state_transition_reason"),
            sidecar=sidecar,
            stages=list(self._stages),
        )

    # ── SSM ───────────────────────────────────────────────────────────────────────────
    def _send(self, script, environment, what):
        command = script_command(script, environment)
        self.log(f"atlas: sending {what} to {self.settings.instance_id} over SSM "
                 f"({len(command)} command bytes)")
        try:
            response = self.ssm.send_command(
                DocumentName="AWS-RunShellScript",
                InstanceIds=[self.settings.instance_id],
                Comment=f"atlas {what}",
                Parameters={"commands": [command],
                            "executionTimeout": [str(self.settings.snapshot_timeout_seconds)]},
            )
        except Exception as error:  # noqa: BLE001 - a refused command is the stage failing
            raise HostError(f"SSM refused the {what} command: {error}") from error
        command_id = (response.get("Command") or {}).get("CommandId")
        if not command_id:
            raise HostError(f"SSM accepted the {what} command without a CommandId")
        return command_id

    def _wait_command(self, command_id, timeout, what):
        deadline = self.monotonic() + timeout
        status = None
        while True:
            try:
                invocation = self.ssm.get_command_invocation(
                    CommandId=command_id, InstanceId=self.settings.instance_id)
            except Exception as error:  # noqa: BLE001 - InvocationDoesNotExist while queued
                if "InvocationDoesNotExist" not in str(error) and "does not exist" not in str(error):
                    raise HostError(f"cannot read the {what} invocation: {error}") from error
                invocation = {}
            status = invocation.get("Status") or "Pending"
            if status in TERMINAL_STATUSES:
                break
            if self.monotonic() >= deadline:
                raise HostError(f"the {what} command {command_id} did not finish within "
                                f"{timeout}s (last status {status})")
            self.sleep(2)
        for stream in ("StandardOutputContent", "StandardErrorContent"):
            text = (invocation.get(stream) or "").strip()
            if text:
                label = "stdout" if stream.startswith("Standard") else "stderr"
                for line in text.splitlines()[-40:]:
                    self.log(f"atlas[{what} {label}] {line}")
        if status != "Success":
            raise HostError(f"the {what} command {command_id} finished {status}"
                            + (f" (exit {invocation.get('ResponseCode')})"
                               if invocation.get("ResponseCode") is not None else ""))
        self.log(f"atlas: {what} succeeded (command {command_id})")

    # ── EC2 state waits and the stop ──────────────────────────────────────────────────
    def _wait_for_state(self, wanted, timeout, what):
        deadline = self.monotonic() + timeout
        last = None
        while True:
            instance = change.describe(self.ec2, self.settings.instance_id)
            last = instance["state"]
            if last in wanted:
                return instance
            if self.monotonic() >= deadline:
                raise HostError(f"waited {timeout}s for {what}; EC2 last reported {last}")
            self.sleep(5)

    def _stop_once(self):
        """Stop the instance if this run started it, and confirm EC2 agrees. Never raises.

        Returns (stopped, error, instance_after_stop). The instance is described once more
        after the stop so the pointer can record the transition that ended this session.
        """
        if not self._start_attempted:
            return True, None, None
        try:
            self.ec2.stop_instances(InstanceIds=[self.settings.instance_id])
        except Exception as error:  # noqa: BLE001 - reported, never raised from here
            return False, f"stop_instances raised: {error}", None
        try:
            instance = self._wait_for_state(("stopping", "stopped"),
                                            self.settings.start_timeout_seconds,
                                            what="the stop to take effect")
        except Exception as error:  # noqa: BLE001
            return False, str(error), None
        return True, None, instance


def _iso(value):
    moment = change.normalize_instant(value)
    return None if moment is None else moment.isoformat()
