import json
from pathlib import Path
import unittest

from scripts.export_world import deployment_metadata, validate_deployment


class DeploymentTests(unittest.TestCase):
    def test_shared_source_is_public_metadata_only(self):
        source = json.loads((Path(__file__).resolve().parents[1] / 'deployment.json').read_text())
        self.assertEqual(deployment_metadata(), source)
        self.assertEqual(set(source), {'schema', 'serverAddress'})
        self.assertNotIn('100.100.1.0', source['serverAddress'])

    def test_invalid_or_private_fields_are_refused(self):
        for value in [None, [], {}, {'schema': True, 'serverAddress': 'play.example.test'},
                      {'schema': 2, 'serverAddress': 'play.example.test'},
                      {'schema': 1, 'serverAddress': 'https://play.example.test'},
                      {'schema': 1, 'serverAddress': 'play.example.test:0'},
                      {'schema': 1, 'serverAddress': 'play.example.test:65536'},
                      {'schema': 1, 'serverAddress': 'play.example.test', 'token': 'fixture'}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_deployment(value)
