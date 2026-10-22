"""Change detection: the cheap question, and every branch of it.

The rule the household cares about is the last one in this file: when nothing has changed, a
run must take no action at all, and it must say in one line which fields it compared.
"""
from __future__ import annotations

import unittest

from scripts.atlas import change, contract
from tests.atlas_stubs import StubEC2, StubS3

POINTER = {
    "schema": 1, "snapshot_id": "20261022T043000Z", "captured_at": "2026-10-22T04:30:00+00:00",
    "published_at": "2026-10-22T04:40:00Z", "instance_id": "i-0123456789abcdef0",
    "launch_time": "2026-10-20T09:00:00+00:00",
    "state_transition_at": "2026-10-22T04:31:00+00:00",
    "state_transition_reason": "User initiated (2026-10-22 04:31:00 GMT)",
    "tar_key": contract.SNAPSHOT_KEY, "tar_sha256": "a" * 64, "tar_bytes": 100,
    "region_files": 390, "nonempty_regions": 66, "tiles": 66,
    "position_source": "test", "source": "github-actions",
}


def instance(**overrides):
    row = {"instance_id": "i-0123456789abcdef0", "state": "stopped",
           "launch_time": "2026-10-20T09:00:00+00:00",
           "state_transition_reason": "User initiated (2026-10-22 04:31:00 GMT)"}
    row.update(overrides)
    return row


class TransitionParsingTests(unittest.TestCase):
    def test_ec2s_own_reason_string_is_parsed(self):
        moment = change.parse_transition_reason("User initiated (2026-10-21 12:00:00 GMT)")
        self.assertEqual(moment.isoformat(), "2026-10-21T12:00:00+00:00")

    def test_a_reason_without_a_timestamp_is_none(self):
        self.assertIsNone(change.parse_transition_reason("-"))
        self.assertIsNone(change.parse_transition_reason(None))
        self.assertIsNone(change.parse_transition_reason("User initiated"))

    def test_an_instant_normalises_zulu_and_offsets(self):
        self.assertEqual(change.normalize_instant("2026-10-21T12:00:00Z").isoformat(),
                         "2026-10-21T12:00:00+00:00")
        self.assertEqual(change.normalize_instant("2026-10-21T08:00:00-04:00").isoformat(),
                         "2026-10-21T12:00:00+00:00")


class DecideTests(unittest.TestCase):
    def test_no_pointer_means_capture(self):
        decision = change.decide(instance(), None)
        self.assertEqual(decision.action, "capture")
        self.assertEqual(decision.reason, "no_pointer")

    def test_the_same_launch_and_transition_is_unchanged(self):
        decision = change.decide(instance(), POINTER)
        self.assertEqual(decision.action, "unchanged")
        self.assertIn("field=launch_time", decision.line)
        self.assertIn("field=state_transition_reason", decision.line)
        self.assertIn("2026-10-22T04:30:00+00:00", decision.line)
        self.assertIn("unchanged (no capture, no wake, no commit)", decision.line)

    def test_a_replaced_instance_is_caught_by_launch_time(self):
        decision = change.decide(instance(launch_time="2026-10-21T09:00:00+00:00"), POINTER)
        self.assertEqual(decision.action, "capture")
        self.assertEqual(decision.reason, "launch_time_changed")
        self.assertIn("field=launch_time", decision.line)

    def test_a_different_instance_id_is_caught(self):
        decision = change.decide(instance(instance_id="i-ffff"), POINTER)
        self.assertEqual(decision.reason, "different_instance")

    def test_a_start_or_stop_since_the_capture_is_caught(self):
        decision = change.decide(
            instance(state_transition_reason="User initiated (2026-10-22 09:15:00 GMT)"), POINTER)
        self.assertEqual(decision.action, "capture")
        self.assertEqual(decision.reason, "state_transition_changed")
        self.assertIn("field=state_transition_reason", decision.line)

    def test_a_running_host_defers_and_is_never_captured_or_stopped(self):
        decision = change.decide(
            instance(state="running",
                     state_transition_reason="User initiated (2026-10-22 09:15:00 GMT)"), POINTER)
        self.assertEqual(decision.action, "defer")
        self.assertEqual(decision.reason, "host_running")
        self.assertIn("stops nothing", decision.line)

    def test_a_transitioning_host_defers(self):
        decision = change.decide(instance(state="stopping"), POINTER)
        self.assertEqual(decision.action, "defer")
        self.assertEqual(decision.reason, "host_transitioning")

    def test_an_unreadable_transition_biases_towards_capture(self):
        decision = change.decide(instance(state_transition_reason="-"), POINTER)
        self.assertEqual(decision.action, "capture")
        self.assertEqual(decision.reason, "state_transition_unreadable")

    def test_a_pointer_without_the_ec2_facts_biases_towards_capture(self):
        pointer = dict(POINTER, state_transition_at=None)
        self.assertEqual(change.decide(instance(), pointer).reason,
                         "state_transition_unreadable")


class DetectTests(unittest.TestCase):
    """The two reads that answer the question, and the fact that there are only two."""

    def settings(self, **environ):
        from scripts.atlas.config import Settings
        base = {"ATLAS_BUCKET": "atlas-bucket", "ATLAS_INSTANCE_ID": "i-0123456789abcdef0"}
        base.update(environ)
        return Settings.from_env(base, repo_root=".")

    def test_an_unchanged_world_costs_one_get_and_one_describe(self):
        s3 = StubS3({contract.POINTER_KEY: __import__("json").dumps(POINTER).encode()})
        ec2 = StubEC2(transition_reason=POINTER["state_transition_reason"])
        decision = change.detect(ec2, s3, self.settings())
        self.assertEqual(decision.action, "unchanged")
        self.assertEqual(s3.names(), ["get_object"])
        self.assertEqual(ec2.names(), ["describe_instances"])
        self.assertEqual(ec2.count("start_instances"), 0)
        self.assertEqual(ec2.count("stop_instances"), 0)

    def test_no_pointer_asks_ec2_and_wants_a_capture(self):
        s3 = StubS3()
        ec2 = StubEC2()
        decision = change.detect(ec2, s3, self.settings())
        self.assertEqual(decision.action, "capture")
        self.assertEqual(ec2.names(), ["describe_instances"])

    def test_a_describe_failure_is_a_named_error_not_a_traceback(self):
        s3 = StubS3()
        ec2 = StubEC2()
        ec2.failures["describe_instances"] = RuntimeError("throttled")
        with self.assertRaises(change.ChangeError):
            change.detect(ec2, s3, self.settings())


if __name__ == "__main__":
    unittest.main()
