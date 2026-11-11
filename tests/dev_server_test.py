"""Read-only route checks use temporary fixtures, never real engine assets."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

module_path = Path(__file__).resolve().parents[1] / 'dev_server.py'
spec = importlib.util.spec_from_file_location('dev_server', module_path)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class EngineRouteTest(unittest.TestCase):
    def test_allowlist_and_containment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'web'
            root.mkdir()
            allowed = ['surface-instance.js', 'surface.wasm', 'examples/amiya/surfaces.json',
                       'examples/shu/surfaces.json', 'examples/wang/surfaces.json', 'direction-examples/shu/source/front/char_2025_shu.png', 'direction-examples/wang/source/front/char_2027_wang.png', 'examples/ayerscarpe/surfaces.json', 'examples/chongyue/surfaces.json', 'examples/originium-slug/surfaces.json', 'examples/basic-soldier/surfaces.json', 'examples/basic-crossbowman/surfaces.json', 'examples/crossbow-projectile/surfaces.json', 'direction-examples/basic-crossbowman/source/projectile/projectile-crossbow-texture.png', 'direction-examples/amiya/source/front/art.png']
            allowed += ['direction-examples/chongyue/source/skill1-effects/' + name + '.json' for name in ['effect-bundle', 'effect-source', 'effect-animation', 'effect-meshes', 'shader-programs']]
            allowed.append('direction-examples/chongyue/source/skill1-effects/textures/123.png')
            allowed += ['environments/lungmen/environment.json', 'environments/lungmen/TX_LM_A_N.png']
            for name in allowed:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
                self.assertEqual(server.engine_file('/engine-runtime/' + name, root), path.resolve())
            secret = Path(directory) / 'secret.js'
            secret.write_text('private')
            (root / 'escape.js').symlink_to(secret)
            for name in ['../secret.js', '%2e%2e/secret.js', 'escape.js', '.env',
                         'examples/amiya/presentation.json', 'direction-examples/amiya/source/front/skeleton.json',
                         'examples/texas/surfaces.json', '/etc/passwd',
                         'direction-examples/chongyue/source/skill1-effects/chyue.ab',
                         'direction-examples/chongyue/source/skill1-effects/source.json',
                         'environments/lungmen/source/provenance.json', 'environments/lungmen/source/map.ab',
                         'environments/lungmen/../private.png',
                         'direction-examples/chongyue/source/skill1-effects/../skill1-data.json']:
                self.assertIsNone(server.engine_file('/engine-runtime/' + name, root), name)


    def test_mini_project_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['index.html', 'src/app.js', 'src/style.css', 'assets/lungmen-dollar.png']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
                self.assertEqual(server.mini_project_file('/mini-project/' + name, root), path.resolve())
            self.assertEqual(server.mini_project_file('/mini-project/', root), (root / 'index.html').resolve())
            for name in ['../secret.js', '%2e%2e/secret.js', '.env', 'package.json']:
                self.assertIsNone(server.mini_project_file('/mini-project/' + name, root), name)


if __name__ == '__main__':
    unittest.main()
