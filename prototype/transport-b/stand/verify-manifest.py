#!/usr/bin/env python3
"""Inspect the disposable CI preparation output, without running its binaries."""
import hashlib
import json
import re
import stat
import struct
import sys
from pathlib import Path

PIN = "a26b5555728e5b3e990b8204f7663cc742c9de3b"
GO_SHA = "031f088e5d955bab8657ede27ad4e3bc5b7c1ba281f05f245bcc304f327c987a"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(manifest_path):
    root = manifest_path.parent
    manifest = json.loads(manifest_path.read_text())
    require(manifest["schema"] == "invizent-transport-b-stand-v1", "manifest schema")
    require(manifest["status"] == "prepared-binaries-only", "preparation status")
    require(manifest["services_started"] is False, "service boundary")
    require(manifest["platform_connection_verified"] is False, "platform proof boundary")
    require(manifest["upstream"]["repository"] == "https://github.com/kulikov0/whitelist-bypass.git", "repository")
    require(manifest["upstream"]["commit"] == PIN, "source pin")
    require(manifest["toolchain"]["version"] == "1.26.1", "toolchain version")
    require(manifest["toolchain"]["archive_sha256"] == GO_SHA, "toolchain pin")
    require(sha256(root / "downloads/go1.26.1.linux-amd64.tar.gz") == GO_SHA, "actual toolchain archive")
    require(set(manifest["binaries"]) == {"telemost-creator", "telemost-joiner"}, "binary set")
    for name, metadata in manifest["binaries"].items():
        require(metadata["path"] == "bin/" + name, "binary path")
        require(metadata["help_path"] == "evidence/" + name + ".help.txt", "help path")
        binary, help_file = root / metadata["path"], root / metadata["help_path"]
        require(not binary.is_symlink() and not help_file.is_symlink(), "regular evidence files")
        require(stat.S_IMODE(binary.stat().st_mode) & 0o077 == 0, "private binary")
        require(stat.S_IMODE(help_file.stat().st_mode) & 0o077 == 0, "private help")
        require(sha256(binary) == metadata["sha256"], "actual binary hash")
        require(sha256(help_file) == metadata["help_sha256"], "actual help hash")
        require(metadata["help_verified"] is True, "help completion")
        with binary.open("rb") as source:
            header = source.read(64)
        require(header[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", header, 18)[0] == 62,
                "Linux x86_64 executable")
        help_text = help_file.read_text()
        required = ["cookies", "upstream-socks"] if name.endswith("creator") else ["tm-link", "socks-user", "socks-pass", "socks-host", "reliable"]
        for flag in required:
            require(re.search(r"(?m)^\s+-" + re.escape(flag) + r"(?:\s|$)", help_text), "pinned executable flags")
        if name.endswith("creator"):
            require(not re.search(r"(?m)^\s+-name(?:\s|$)", help_text), "Telemost has no WB name flag")
    return {"verified": True, "source": PIN, "binaries": 2, "platform_connection_verified": False}


if __name__ == "__main__":
    try:
        print(json.dumps(verify(Path(sys.argv[1]))))
    except (IndexError, OSError, ValueError, KeyError, TypeError, struct.error):
        print("Preparation evidence verification failed.", file=sys.stderr)
        sys.exit(1)
