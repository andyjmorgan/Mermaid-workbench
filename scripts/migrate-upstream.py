#!/usr/bin/env python3
"""Prepare an isolated upstream upgrade, or record a manually ported patch."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MARKER = "workbench-migration.json"


def run(*args, cwd=None, capture=False):
    return subprocess.run(args, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def git(repo, *args):
    return run("git", "-C", str(repo), *args, capture=True).strip()


def revision(repo, ref):
    return git(repo, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}")


def verify(repo):
    """Tripwires for the wrapper's DOM contract; browser tests are still required."""
    page = (repo / "src/routes/(app)/edit/+page.svelte").read_text()
    for token in ['data-new-diagram-url={urls.current.new}', 'data-workspace-share',
                  '<Share />', 'id="editorMode"', 'startAutoSave']:
        if token not in page:
            raise ValueError(f"Missing editor integration contract: {token}")
    for token in ['<Navbar', '<History', '<DiagramDocButton']:
        if token in page:
            raise ValueError(f"Removed editor UI has returned: {token}")
    desktop = (repo / "src/lib/components/DesktopEditor.svelte").read_text()
    if desktop.count('!env.isEnabledMermaidChartLinks') < 2:
        raise ValueError("Both AI gutter rendering and popup opening must be disabled")
    state = (repo / "src/lib/util/state.svelte.ts").read_text()
    if 'workspace: `${window.location.origin}/#${serialized}`' not in state:
        raise ValueError("Share/edit URLs must point to the workspace root")
    share = (repo / "src/lib/components/Share.svelte").read_text()
    if 'value={urls.current.workspace}' not in share:
        raise ValueError("Share dialog lost the workspace URL")
    run("git", "-C", str(repo), "diff", "--check", "HEAD")


def marker_path(repo):
    return Path(git(repo, "rev-parse", "--absolute-git-dir")) / MARKER


def prepare(args, config, config_path):
    target = args.output.resolve()
    if target.exists():
        raise ValueError(f"Output already exists: {target}. Choose a fresh directory; nothing was overwritten.")
    target.parent.mkdir(parents=True, exist_ok=True)
    source = args.source or config["repository"]
    run("git", "clone", "--no-checkout", "--", source, str(target))
    ref = args.ref or config["revision"]
    try:
        commit = revision(target, ref)
    except subprocess.CalledProcessError:
        run("git", "-C", str(target), "fetch", "origin", ref)
        commit = revision(target, "FETCH_HEAD")
    run("git", "-C", str(target), "checkout", "--detach", commit)
    patch = (config_path.parent / config["patch"]).resolve()
    marker_path(target).write_text(json.dumps({
        "repository": config["repository"], "revision": commit,
        "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(),
    }, indent=2) + "\n")
    if args.three_way:
        # --3way may leave conflicts. Keep the checkout so the user can resolve them.
        run("git", "-C", str(target), "apply", "--3way", str(patch))
    else:
        # No partial application, fuzz, reset, cleanup, or automatic source rewriting.
        run("git", "-C", str(target), "apply", "--check", str(patch))
        run("git", "-C", str(target), "apply", str(patch))
    verify(target)
    print(f"Prepared {target} at {commit}; patch and integration checks passed.", flush=True)
    print("Build and browser-test this candidate before recording a new base or deploying.", flush=True)
    if args.build:
        command = ["docker", "build", "-t", args.build]
        build_args = dict(config["build_args"])
        if args.renderer_url:
            build_args["MERMAID_RENDERER_URL"] = args.renderer_url
        for key, value in build_args.items():
            command.extend(["--build-arg", f"{key}={value}"])
        run(*command, ".", cwd=target)


def record(args, config, config_path):
    repo = args.checkout.resolve()
    marker = json.loads(marker_path(repo).read_text())
    head = revision(repo, "HEAD")
    if head != marker["revision"]:
        raise ValueError("Checkout HEAD changed. Keep fixes uncommitted on the selected upstream revision.")
    if git(repo, "diff", "--name-only", "--diff-filter=U"):
        raise ValueError("Resolve and git add all conflicted files before recording.")
    if git(repo, "ls-files", "--others", "--exclude-standard"):
        raise ValueError("Untracked files found. Stage intended new source files; move other files elsewhere.")
    verify(repo)
    patch_text = run("git", "-C", str(repo), "diff", "--binary", "--full-index", "HEAD", capture=True)
    if not patch_text.strip():
        raise ValueError("No changes to record. Refusing to replace the maintained patch with an empty file.")
    # Confirm the new patch can reproduce the changes from a clean upstream checkout.
    with tempfile.TemporaryDirectory(prefix="workbench-patch-check-") as tmp:
        clean = Path(tmp) / "editor"
        candidate = Path(tmp) / "candidate.patch"
        candidate.write_text(patch_text)
        run("git", "clone", "--shared", "--no-checkout", "--", str(repo), str(clean))
        run("git", "-C", str(clean), "checkout", "--detach", head)
        run("git", "-C", str(clean), "apply", str(candidate))
        verify(clean)
    (config_path.parent / config["patch"]).write_text(patch_text)
    config["revision"] = head
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    print(f"Recorded patch and pinned base {head}. Review and commit both files in the workbench repository.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "upstream.json")
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare", help="clone a fresh base and reapply workbench fixes")
    prep.add_argument("--ref", help="upstream tag, branch, or SHA; defaults to upstream.json")
    prep.add_argument("--source", help="alternate Git source, including a local clone for offline use")
    prep.add_argument("--output", type=Path, default=ROOT / ".upstream/mermaid-live-editor")
    prep.add_argument("--three-way", action="store_true", help="try Git three-way application; conflicts stop the run")
    prep.add_argument("--build", metavar="IMAGE", help="also build the patched editor Docker image; never pushes")
    prep.add_argument("--renderer-url", help="override the compiled rendering URL when building")
    rec = commands.add_parser("record", help="save a tested manual port and update the pinned base")
    rec.add_argument("--checkout", type=Path, required=True)
    args = parser.parse_args()
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text())
    if args.command == "prepare":
        prepare(args, config, config_path)
    else:
        record(args, config, config_path)


if __name__ == "__main__":
    try:
        main()
    except (subprocess.CalledProcessError, ValueError, OSError) as error:
        print(f"Migration stopped: {error}", file=sys.stderr)
        print("No deployment was changed. Any candidate checkout is retained for inspection; see AGENTS.md.", file=sys.stderr)
        sys.exit(1)
