"""The wake path: start, ready-check, snapshot, upload confirm, and the stop on every path.

`test_every_failing_stage_still_stops_the_instance` is the point of this file. Leaving the
production server running after a failed capture is its own incident, so each stage gets its
own case and each case asserts the stop happened: one `stop_instances` call, and EC2 reporting
the host no longer running.
"""
from __future__ import annotations

import base64
import unittest

from scripts.atlas import contract, host
from scripts.atlas.config import Settings
from tests.atlas_stubs import (FakeClientError, StubEC2, StubS3, StubSSM, make_capture)

READY = "atlas ready-check"
SNAPSHOT = "atlas snapshot"


class HostTests(unittest.TestCase):
    def setUp(self):
        self.settings = Settings.from_env(
            {"ATLAS_BUCKET": "atlas-bucket", "ATLAS_INSTANCE_ID": "i-0123456789abcdef0",
             "ATLAS_START_TIMEOUT": "1", "ATLAS_READY_TIMEOUT": "1",
             "ATLAS_SNAPSHOT_TIMEOUT": "1"},
            repo_root=".")
        self.ec2 = StubEC2()
        self.s3 = StubS3()
        self.ssm = StubSSM()
        self.logs = []
        self.workdir = self.enterContext(__import__("tempfile").TemporaryDirectory())
        self.tar, self.sidecar = make_capture(self.workdir)

        def snapshot_ran(_text):
            # What the host would do: upload the tarball and its sidecar.
            self.s3.objects[contract.SNAPSHOT_KEY] = self.tar.read_bytes()
            import json
            self.s3.objects[contract.SIDECAR_KEY] = json.dumps(self.sidecar).encode()

        self.ssm.hooks[SNAPSHOT] = snapshot_ran

    def capture(self, **kwargs):
        return host.HostCapture(self.ec2, self.ssm, self.s3, self.settings,
                                log=self.logs.append, sleep=lambda _s: None, **kwargs)

    def assert_stopped(self):
        self.assertEqual(self.ec2.count("stop_instances"), 1,
                         f"stop_instances was called {self.ec2.count('stop_instances')} times; "
                         f"calls: {self.ec2.names()}")
        self.assertIn(self.ec2.state, ("stopping", "stopped"))

    # ── the happy path ───────────────────────────────────────────────────────────────
    def test_the_happy_path_started_it_and_stopped_it(self):
        facts = self.capture().capture()
        self.assertEqual(self.ec2.count("start_instances"), 1)
        self.assertEqual(self.ec2.count("stop_instances"), 1)
        self.assertEqual(self.ssm.count("send_command"), 2)
        self.assertEqual(len(self.ssm.sent(READY)), 1)
        self.assertEqual(len(self.ssm.sent(SNAPSHOT)), 1)
        self.assertGreater(facts.tar_bytes, 0)
        self.assertEqual(facts.sidecar["tar_sha256"], self.sidecar["tar_sha256"])
        self.assertTrue(facts.stopped)
        # The pointer's EC2 facts come from after the stop.
        self.assertEqual(facts.state_transition_at, "2026-10-22T04:31:00+00:00")

    def test_the_committed_scripts_are_sent_verbatim_rather_than_typed(self):
        self.capture().capture()
        for comment, script in ((READY, host.READY_SCRIPT), (SNAPSHOT, host.SNAPSHOT_SCRIPT)):
            sent = self.ssm.sent(comment)[0]
            encoded = sent.split("printf %s ", 1)[1].split(" |", 1)[0].strip("'")
            self.assertEqual(base64.b64decode(encoded).decode("utf8"),
                             script.read_text(encoding="utf8"),
                             f"the {comment} command does not carry the committed script")
            self.assertNotIn("save-off", sent.split("printf")[0],
                             "the command interpolates world-touching text instead of quoting it")

    def test_a_value_with_a_quote_cannot_break_out_of_the_command(self):
        command = host.script_command(host.SNAPSHOT_SCRIPT,
                                      {"ATLAS_BUCKET": "bucket'; rm -rf /; echo '"})
        self.assertIn("ATLAS_BUCKET='bucket'\"'\"'; rm -rf /; echo '\"'\"''", command)
        self.assertTrue(command.endswith("bash /tmp/atlas-step.sh"))

    def test_the_snapshot_script_always_restores_saving(self):
        text = host.SNAPSHOT_SCRIPT.read_text(encoding="utf8")
        self.assertIn("trap cleanup EXIT", text)
        self.assertIn('"save-on"', text)
        # save-off before the flush, and the trap registered before either is used.
        self.assertLess(text.index("trap cleanup EXIT"), text.index('console "save-off"'))
        self.assertLess(text.index('console "save-off"'), text.index('console "save-all flush"'))

    # ── one test per failing stage, stop asserted every time ────────────────────────
    def test_start_failing_still_stops_the_instance(self):
        self.ec2.failures["start_instances"] = RuntimeError("InsufficientInstanceCapacity")
        with self.assertRaises(host.HostError):
            self.capture().capture()
        self.assert_stopped()
        self.assertEqual(self.ssm.count("send_command"), 0)

    def test_never_ready_still_stops_the_instance(self):
        self.ssm.results[READY] = ("Failed", "atlas-ready: not ready", "")
        with self.assertRaises(host.HostError) as caught:
            self.capture().capture()
        self.assertIn("ready-check", str(caught.exception))
        self.assert_stopped()
        self.assertEqual(len(self.ssm.sent(SNAPSHOT)), 0,
                         "the snapshot must not be taken when the server was never ready")

    def test_ssm_refusing_the_command_still_stops_the_instance(self):
        self.ssm.failures["send_command"] = FakeClientError("AccessDeniedException")
        with self.assertRaises(host.HostError):
            self.capture().capture()
        self.assert_stopped()

    def test_a_failed_upload_still_stops_the_instance(self):
        # The host says it uploaded; S3 has a truncated object.
        def broken_upload(_text):
            self.s3.objects[contract.SNAPSHOT_KEY] = self.tar.read_bytes()[:10]
            import json
            self.s3.objects[contract.SIDECAR_KEY] = json.dumps(self.sidecar).encode()
        self.ssm.hooks[SNAPSHOT] = broken_upload
        with self.assertRaises(host.HostError) as caught:
            self.capture().capture()
        self.assertIn("truncated", str(caught.exception))
        self.assert_stopped()

    def test_a_sidecar_that_cannot_be_read_still_stops_the_instance(self):
        def no_sidecar(_text):
            self.s3.objects[contract.SNAPSHOT_KEY] = self.tar.read_bytes()
        self.ssm.hooks[SNAPSHOT] = no_sidecar
        with self.assertRaises(host.HostError):
            self.capture().capture()
        self.assert_stopped()

    def test_a_snapshot_command_that_fails_still_stops_the_instance(self):
        self.ssm.results[SNAPSHOT] = ("Failed", "atlas-snapshot: ERROR: console refused", "")
        with self.assertRaises(host.HostError) as caught:
            self.capture().capture()
        self.assertIn("snapshot", str(caught.exception))
        self.assert_stopped()

    def test_an_unconfirmed_stop_is_loud_rather_than_assumed(self):
        self.ec2.stop_takes_effect = False    # stop_instances accepted, EC2 never settles
        with self.assertRaises(host.StopNotConfirmed) as caught:
            self.capture().capture()
        self.assertIn("may still be running", str(caught.exception))
        self.assertEqual(self.ec2.count("stop_instances"), 1)
        self.assertTrue(any("STOP NOT CONFIRMED" in line for line in self.logs))

    def test_a_failing_stage_with_an_unconfirmable_stop_reports_both(self):
        self.ssm.results[READY] = ("Failed", "", "")
        self.ec2.stop_takes_effect = False
        with self.assertRaises(host.HostError) as caught:
            self.capture().capture()
        # The stage failure is what propagates -- and the stop failure is in the log, loudly.
        self.assertIn("ready-check", str(caught.exception))
        self.assertTrue(any("STOP NOT CONFIRMED" in line for line in self.logs))

    # ── the inverse: a host this run did not start is never stopped ────────────────
    def test_an_already_running_host_is_never_captured_and_never_stopped(self):
        self.ec2.state = "running"
        with self.assertRaises(host.HostError) as caught:
            self.capture().capture()
        self.assertIn("did not start", str(caught.exception))
        self.assertEqual(self.ec2.count("start_instances"), 0)
        self.assertEqual(self.ec2.count("stop_instances"), 0)
        self.assertEqual(self.ssm.count("send_command"), 0)

    def test_a_stopping_host_is_waited_for_then_started_and_stopped(self):
        self.ec2.state = "stopping"
        original_describe = self.ec2.describe_instances

        def describe(**kwargs):
            response = original_describe(**kwargs)
            if self.ec2.state == "stopping" and self.ec2.count("describe_instances") > 1:
                self.ec2.state = "stopped"
            return response

        self.ec2.describe_instances = describe
        facts = self.capture().capture()
        self.assertEqual(self.ec2.count("start_instances"), 1)
        self.assert_stopped()
        self.assertTrue(facts.stopped)


if __name__ == "__main__":
    unittest.main()
