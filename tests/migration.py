"""Offline integration tests for the upstream migration workflow."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/migrate-upstream.py"


def run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True).stdout.strip()


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "upstream"
        self.source.mkdir()
        run("git", "init", str(self.source))
        run("git", "config", "user.email", "test@example.invalid", cwd=self.source)
        run("git", "config", "user.name", "Migration test", cwd=self.source)
        self.original = {
            "src/routes/(app)/edit/+page.svelte": '<Navbar />\n<History />\n<DiagramDocButton />\n',
            "src/lib/components/DesktopEditor.svelte": 'renderAI();\nopenAI();\n',
            "src/lib/util/state.svelte.ts": 'workspace: window.location.href,\n',
            "src/lib/components/Share.svelte": '<CopyInput value={window.location.href} />\n',
        }
        self.patched = {
            "src/routes/(app)/edit/+page.svelte": '<div data-new-diagram-url={urls.current.new}>\n<div data-workspace-share><Share /></div>\n<Switch id="editorMode" />\nstartAutoSave();\n',
            "src/lib/components/DesktopEditor.svelte": 'if (!env.isEnabledMermaidChartLinks) return;\nrenderAI();\nif (!env.isEnabledMermaidChartLinks) return;\nopenAI();\n',
            "src/lib/util/state.svelte.ts": 'workspace: `${window.location.origin}/#${serialized}`,\n',
            "src/lib/components/Share.svelte": '<CopyInput value={urls.current.workspace} />\n',
        }
        self.write(self.original)
        run("git", "add", ".", cwd=self.source)
        run("git", "commit", "-m", "base", cwd=self.source)
        self.base = run("git", "rev-parse", "HEAD", cwd=self.source)
        self.write(self.patched)
        self.patch = self.root / "custom.patch"
        self.patch.write_text(run("git", "diff", "--full-index", cwd=self.source) + "\n")
        run("git", "restore", ".", cwd=self.source)
        self.config = self.root / "upstream.json"
        self.config.write_text(json.dumps({"repository": str(self.source), "revision": self.base,
                                          "patch": self.patch.name, "build_args": {}}))

    def write(self, files):
        for name, text in files.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def invoke(self, *args, ok=True):
        result = subprocess.run(["python3", str(SCRIPT), "--config", str(self.config), *map(str, args)],
                                text=True, capture_output=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def test_replays_committed_base_without_copying_or_modifying_dirty_source(self):
        dirty = self.source / next(iter(self.original))
        dirty.write_text("uncommitted user work\n")
        target = self.root / "candidate"
        self.invoke("prepare", "--output", target)
        self.assertEqual(dirty.read_text(), "uncommitted user work\n")
        for name, expected in self.patched.items():
            self.assertEqual((target / name).read_text(), expected)
        self.assertEqual(json.loads(self.config.read_text())["revision"], self.base)
        sentinel = target / "do-not-delete"
        sentinel.write_text("keep")
        self.invoke("prepare", "--output", target, ok=False)
        self.assertEqual(sentinel.read_text(), "keep")

    def test_upgrade_record_and_replay(self):
        (self.source / "upstream-release.txt").write_text("new release")
        run("git", "add", ".", cwd=self.source)
        run("git", "commit", "-m", "upstream update", cwd=self.source)
        latest = run("git", "rev-parse", "HEAD", cwd=self.source)
        target = self.root / "candidate"
        self.invoke("prepare", "--ref", latest, "--output", target)
        self.assertEqual(json.loads(self.config.read_text())["revision"], self.base)
        # A manual port may add source files, but must stage them explicitly.
        added = target / "port-notes.txt"
        added.write_text("intentional new file")
        self.invoke("record", "--checkout", target, ok=False)
        run("git", "add", added.name, cwd=target)
        self.invoke("record", "--checkout", target)
        self.assertEqual(json.loads(self.config.read_text())["revision"], latest)
        replay = self.root / "replay"
        self.invoke("prepare", "--output", replay)
        self.assertEqual((replay / added.name).read_text(), added.read_text())
        self.assertEqual((replay / "upstream-release.txt").read_text(), "new release")

    def test_conflicting_upgrade_stops_without_changing_pin_or_patch(self):
        path = self.source / "src/routes/(app)/edit/+page.svelte"
        path.write_text("upstream redesigned the whole page\n")
        run("git", "add", ".", cwd=self.source)
        run("git", "commit", "-m", "breaking upstream change", cwd=self.source)
        latest = run("git", "rev-parse", "HEAD", cwd=self.source)
        before = self.config.read_bytes(), self.patch.read_bytes()
        target = self.root / "conflict"
        self.invoke("prepare", "--ref", latest, "--output", target, ok=False)
        self.assertEqual(git_status := run("git", "status", "--porcelain", cwd=target), "", git_status)
        self.assertEqual(before, (self.config.read_bytes(), self.patch.read_bytes()))
        merge = self.root / "merge"
        self.invoke("prepare", "--ref", latest, "--output", merge, "--three-way", ok=False)
        self.assertTrue(run("git", "diff", "--name-only", "--diff-filter=U", cwd=merge))
        self.invoke("record", "--checkout", merge, ok=False)
        self.assertEqual(before, (self.config.read_bytes(), self.patch.read_bytes()))
        # Resolve the upstream redesign by deliberately porting the integration.
        for name, text in self.patched.items():
            (merge / name).write_text(text)
        run("git", "add", ".", cwd=merge)
        self.invoke("record", "--checkout", merge)
        replay = self.root / "resolved-replay"
        self.invoke("prepare", "--output", replay)
        for name, text in self.patched.items():
            self.assertEqual((replay / name).read_text(), text)

    def test_record_rejects_changed_head_and_broken_contract(self):
        target = self.root / "candidate"
        self.invoke("prepare", "--output", target)
        page = target / "src/routes/(app)/edit/+page.svelte"
        page.write_text("removed integration hooks\n")
        self.invoke("record", "--checkout", target, ok=False)
        run("git", "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
            "commit", "-am", "accidentally committed changes", cwd=target)
        self.invoke("record", "--checkout", target, ok=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
