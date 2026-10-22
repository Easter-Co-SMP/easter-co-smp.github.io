"""The workflow file: minimal permissions, one trigger pair, one concurrency group, no secrets.

This workflow can write to the repository, so its shape is asserted rather than eyeballed. The
property that matters most after the OIDC refusal: it must hold no AWS credential and no
`id-token`, because it cannot use one -- `permissions: contents: write` is the whole list.

`actionlint` is the real linter and the workflow lints itself as its third step; this file is the
assertion that the properties survive an edit. It needs PyYAML, which the site's check job
installs.
"""
from __future__ import annotations

from pathlib import Path
import re
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
        document = yaml.safe_load(self.text)
        if True in document:  # PyYAML reads `on:` as a boolean
            document = {("on" if key is True else key): value
                        for key, value in document.items()}
        self.document = document

    def test_the_workflow_has_no_top_level_surprises(self):
        self.assertEqual(set(self.document), {"name", "on", "permissions", "concurrency", "jobs"})
        self.assertEqual(self.document["name"], "Atlas pipeline")

    def test_the_only_permission_is_contents_write(self):
        self.assertEqual(self.document["permissions"], {"contents": "write"})

    def test_it_holds_no_aws_credential_anywhere(self):
        # Assertions on the *usable* form, not the prose: the comments explain why the OIDC
        # permission is absent, so the words appear on purpose.
        for forbidden in ("aws-actions/", "boto3:", "boto3 ", "aws s3", "aws sts"):
            self.assertNotIn(forbidden, self.text, f"the workflow mentions {forbidden}")
        self.assertNotIn("id-token:", self.text.replace("no id-token,", ""))
        permissions = self.document["permissions"]
        self.assertNotIn("id-token", permissions)
        expressions = set(re.findall(r"\$\{\{\s*([A-Za-z0-9_.\[\]'-]+)\s*\}\}", self.text))
        self.assertFalse([name for name in expressions if name.startswith("secrets")],
                         f"the workflow reads a secret: {expressions}")
        self.assertEqual({name.split(".", 1)[1] for name in expressions
                          if name.startswith("vars.")}, {"ATLAS_PUBLISH_URL"})
        self.assertIn("github.token", expressions)

    def test_it_runs_on_a_schedule_and_on_demand(self):
        triggers = self.document["on"]
        self.assertIn("schedule", triggers)
        self.assertIn("workflow_dispatch", triggers)
        crons = [entry["cron"] for entry in triggers["schedule"]]
        self.assertEqual(len(crons), 1)
        self.assertEqual(len(crons[0].split()), 5)

    def test_one_concurrency_group_that_is_never_cancelled(self):
        concurrency = self.document["concurrency"]
        self.assertEqual(concurrency["group"], "atlas-pipeline")
        self.assertIs(concurrency["cancel-in-progress"], False)

    def test_the_job_runs_the_committed_pipeline_on_main(self):
        job = self.document["jobs"]["atlas"]
        self.assertEqual(job["runs-on"], "ubuntu-latest")
        self.assertIn("timeout-minutes", job)
        steps = job["steps"]
        self.assertEqual(steps[0]["uses"], "actions/checkout@v6")
        self.assertEqual(steps[0]["with"]["ref"], "main")
        publish = next(step for step in steps
                       if "python -m scripts.atlas" in (step.get("run") or ""))
        self.assertEqual(publish["env"]["ATLAS_GITHUB_TOKEN"], "${{ github.token }}")
        self.assertEqual(publish["env"]["ATLAS_PUBLISH_URL"], "${{ vars.ATLAS_PUBLISH_URL }}")

    def test_it_lints_itself_before_it_publishes(self):
        steps = self.document["jobs"]["atlas"]["steps"]
        names = [step.get("name", "") for step in steps]
        lint = next(index for index, name in enumerate(names) if "lint" in name.lower())
        publish = next(index for index, step in enumerate(steps)
                       if "python -m scripts.atlas" in (step.get("run") or ""))
        self.assertLess(lint, publish)
        self.assertIn("actionlint", steps[lint]["run"])

    def test_the_other_workflows_keep_their_own_gates(self):
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
                          "actionlint-py pin in its third step")
        result = subprocess.run([binary, str(WORKFLOW)], capture_output=True, text=True,
                                timeout=120)
        self.assertEqual(result.returncode, 0,
                         f"actionlint refused the workflow:\n{result.stdout}{result.stderr}")


if __name__ == "__main__":
    unittest.main()
