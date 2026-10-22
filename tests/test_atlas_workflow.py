"""The workflow file: minimal permissions, one trigger pair, one concurrency group, no secrets.

A scheduled workflow that can write to the repository is a security surface, so its shape is
asserted rather than eyeballed: exactly two permissions, both needed, and nothing else; a
schedule and a manual trigger; a concurrency group that cannot be cancelled mid-run; and no
`secrets` anywhere, because the whole design is that there is nothing to rotate.

`actionlint` is the real linter and the workflow lints itself as its first job step; this file
is the assertion that the important properties survive an edit. It needs PyYAML, which the
site's check job installs.
"""
from __future__ import annotations

from pathlib import Path
import unittest

try:
    import yaml
    HAVE_YAML = True
except ImportError:  # pragma: no cover - the skip is the report
    HAVE_YAML = False

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/atlas.yml"


@unittest.skipUnless(HAVE_YAML, "PyYAML is not installed, so the workflow cannot be parsed here")
class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf8")
        self.document = yaml.safe_load(self.text)
        # PyYAML reads `on:` as the boolean True (YAML 1.1), so normalise the key once here
        # rather than in every test.
        if True in self.document:
            self.document = {("on" if key is True else key): value
                             for key, value in self.document.items()}

    def test_the_workflow_has_no_top_level_surprises(self):
        self.assertEqual(set(self.document), {"name", "on", "permissions", "concurrency", "jobs"})
        self.assertEqual(self.document["name"], "Atlas pipeline")

    def test_permissions_are_contents_write_and_id_token_write_and_nothing_else(self):
        permissions = self.document["permissions"]
        self.assertEqual(permissions, {"contents": "write", "id-token": "write"})
        self.assertEqual(len(permissions), 2)

    def test_it_runs_on_a_schedule_and_on_demand(self):
        triggers = self.document["on"]
        self.assertIn("schedule", triggers)
        self.assertIn("workflow_dispatch", triggers)
        crons = [entry["cron"] for entry in triggers["schedule"]]
        self.assertEqual(len(crons), 1)
        fields = crons[0].split()
        self.assertEqual(len(fields), 5, f"{crons[0]!r} is not a five-field cron")

    def test_one_concurrency_group_that_is_never_cancelled(self):
        concurrency = self.document["concurrency"]
        self.assertEqual(concurrency["group"], "atlas-pipeline")
        self.assertIs(concurrency["cancel-in-progress"], False)

    def test_no_secret_is_referenced_anywhere(self):
        import re

        expressions = set(re.findall(r"\$\{\{\s*([A-Za-z0-9_.\[\]'-]+)\s*\}\}", self.text))
        # The design is that there is nothing to rotate, so no expression may read a secret.
        self.assertFalse([name for name in expressions if name.startswith("secrets")],
                         f"the workflow reads a secret: {expressions}")
        variables = {name.split(".", 1)[1] for name in expressions if name.startswith("vars.")}
        self.assertEqual(variables, {"ATLAS_ROLE_ARN", "ATLAS_AWS_REGION", "ATLAS_BUCKET",
                                     "ATLAS_INSTANCE_ID", "ATLAS_CONSOLE", "ATLAS_SERVER_UNIT"})
        inputs = {name.split(".", 1)[1] for name in expressions if name.startswith("inputs.")}
        self.assertEqual(inputs, {"force_capture", "dry_run"})
        self.assertIn("github.token", expressions)

    def test_the_job_runs_the_committed_pipeline_on_a_runner(self):
        job = self.document["jobs"]["atlas"]
        self.assertEqual(job["runs-on"], "ubuntu-latest")
        self.assertIn("timeout-minutes", job)
        steps = job["steps"]
        self.assertTrue(any("python -m scripts.atlas" in (step.get("run") or "")
                            for step in steps))
        # The token is this workflow's own, and the AWS credentials come from OIDC.
        env = next(step for step in steps
                   if "python -m scripts.atlas" in (step.get("run") or ""))["env"]
        self.assertEqual(env["ATLAS_GITHUB_TOKEN"], "${{ github.token }}")
        self.assertTrue(any(step.get("uses", "").startswith("aws-actions/configure-aws-credentials")
                            for step in steps))
        oidc = next(step for step in steps
                    if step.get("uses", "").startswith("aws-actions/configure-aws-credentials"))
        self.assertIn("role-to-assume", oidc["with"])

    def test_the_checkout_is_main_and_this_workflow_lints_itself_before_publishing(self):
        steps = self.document["jobs"]["atlas"]["steps"]
        self.assertEqual(steps[0]["uses"], "actions/checkout@v6")
        self.assertEqual(steps[0]["with"]["ref"], "main")
        names = [step.get("name", "") for step in steps]
        lint = next(index for index, name in enumerate(names) if "lint" in name.lower())
        publish = next(index for index, name in enumerate(names)
                       if "python -m scripts.atlas" in (steps[index].get("run") or ""))
        self.assertLess(lint, publish, "the workflow must lint itself before it publishes")
        self.assertIn("actionlint", steps[lint]["run"])

    def test_it_installs_the_pillow_pin_the_renderer_was_measured_with(self):
        steps = self.document["jobs"]["atlas"]["steps"]
        installs = [step["run"] for step in steps if "pillow" in (step.get("run") or "")]
        self.assertEqual(len(installs), 1, "Pillow must be installed exactly once")
        self.assertIn("pillow==13.0.0", installs[0])

    def test_the_other_workflows_are_untouched_in_behaviour(self):
        """This change adds a workflow; it must not rewrite the Pages or launcher gates."""
        for name in ("publish.yml", "launcher.yml"):
            text = (WORKFLOW.parent / name).read_text(encoding="utf8")
            self.assertIn("runs-on: ubuntu-latest", text)


class ActionlintTests(unittest.TestCase):
    def test_actionlint_accepts_the_workflow_when_it_is_installed(self):
        import shutil
        import subprocess

        binary = shutil.which("actionlint")
        if binary is None:
            self.skipTest("actionlint is not on PATH; the workflow lints itself with the "
                          "actionlint-py pin in its second step")
        result = subprocess.run([binary, str(WORKFLOW)], capture_output=True, text=True,
                                timeout=120)
        self.assertEqual(result.returncode, 0,
                         f"actionlint refused the workflow:\n{result.stdout}{result.stderr}")


if __name__ == "__main__":
    unittest.main()
