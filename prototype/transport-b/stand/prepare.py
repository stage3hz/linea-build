#!/usr/bin/env python3
"""Prepare pinned binaries on a separately authorized, otherwise unused stand.

The default is a read-only inventory. This is NOT a deployment, a platform login,
or proof that every service on a machine has been discovered. All checks describe
the current network/process namespaces; NAT or hidden namespaces can conceal a
host's role. The owner must independently identify the host as a separate stand.
"""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import threading
import urllib.request

API_HOST = "api.invizent.com"
PRODUCTION_IPS = frozenset({"194.87.254.249", "141.133.194.51"})
GO_VERSION = "1.26.1"
GO_ARCHIVE = f"go{GO_VERSION}.linux-amd64.tar.gz"
GO_URL = f"https://dl.google.com/go/{GO_ARCHIVE}"
GO_SHA256 = "031f088e5d955bab8657ede27ad4e3bc5b7c1ba281f05f245bcc304f327c987a"
UPSTREAM = "https://github.com/kulikov0/whitelist-bypass.git"
UPSTREAM_COMMIT = "a26b5555728e5b3e990b8204f7663cc742c9de3b"
REPORT_SCHEMA = "invizent-transport-b-stand-check-v1"
MANIFEST_SCHEMA = "invizent-transport-b-stand-v1"
MAX_OUTPUT = 1 << 20
MAX_ARCHIVE = 200 << 20
RESERVED_PORTS = frozenset({80, 443, 3478, 40000})


class StandFailure(Exception):
    """Only fixed diagnostic codes cross the command-line boundary."""
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def normalized_address(value):
    address = ipaddress.ip_address(value)
    return address.ipv4_mapped if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped else address


def command(arguments, *, cwd=None, env=None, timeout=15, code="COMMAND_FAILED"):
    try:
        answer = subprocess.run(arguments, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise StandFailure(code) from None
    if answer.returncode != 0 or len(answer.stdout) + len(answer.stderr) > MAX_OUTPUT:
        raise StandFailure(code)
    return answer.stdout, answer.stderr


def parse_addresses(raw: bytes):
    try:
        interfaces = json.loads(raw)
        if not isinstance(interfaces, list) or not interfaces:
            raise ValueError()
        addresses = set()
        for interface in interfaces:
            for item in interface.get("addr_info", []):
                if item.get("family") in ("inet", "inet6"):
                    addresses.add(str(normalized_address(item["local"].split("%", 1)[0])))
        if not addresses:
            raise ValueError()
        return sorted(addresses)
    except (ValueError, TypeError, KeyError, AttributeError):
        raise StandFailure("LOCAL_IP_INVENTORY_UNAVAILABLE") from None


def parse_listeners(raw: bytes):
    result = []
    try:
        for line in raw.decode("utf-8", "strict").splitlines():
            fields = line.split()
            if len(fields) < 6 or fields[0] not in ("tcp", "udp"):
                raise ValueError()
            address, separator, port = fields[4].rpartition(":")
            if not separator or not port.isdecimal() or not 0 < int(port) <= 65535:
                raise ValueError()
            address = address.strip("[]").split("%", 1)[0]
            if address != "*":
                ipaddress.ip_address(address)
            result.append({"protocol": fields[0], "address": address, "port": int(port)})
        return result
    except (ValueError, UnicodeError):
        raise StandFailure("LISTENER_INVENTORY_UNAVAILABLE") from None


def canonical_addresses():
    result = []
    failure = []

    def query():
        try:
            result.extend(str(ipaddress.ip_address(row[4][0])) for row in
                          socket.getaddrinfo(API_HOST, 443, type=socket.SOCK_STREAM))
        except (OSError, ValueError):
            failure.append(True)

    # libc DNS does not obey socket timeouts. A daemon thread bounds this check
    # without creating files or starting any service.
    worker = threading.Thread(target=query, daemon=True)
    worker.start()
    worker.join(10)
    if worker.is_alive() or failure or not result:
        raise StandFailure("CANONICAL_DNS_UNAVAILABLE")
    return sorted(set(result))


def process_names():
    names = set()
    try:
        for entry in Path("/proc").iterdir():
            if entry.name.isdecimal():
                try:
                    names.add((entry / "comm").read_text().strip())
                except FileNotFoundError:
                    continue
    except OSError:
        raise StandFailure("DOCKER_INVENTORY_UNAVAILABLE") from None
    return names


def docker_running():
    """Query local sockets only; never honor a remote Docker context or env."""
    candidates = [Path("/run/docker.sock"), Path("/var/run/docker.sock")]
    try:
        processes = process_names()
        users = Path("/run/user")
        if users.exists():
            candidates.extend(path / "docker.sock" for path in users.iterdir())
        seen = set()
        found = False
        for candidate in candidates:
            try:
                info = candidate.stat()
            except FileNotFoundError:
                continue
            if not stat.S_ISSOCK(info.st_mode):
                raise StandFailure("DOCKER_INVENTORY_UNAVAILABLE")
            # Connecting to a socket-activated Docker daemon can start it. A
            # check must never be its first client when no daemon is visible.
            if "dockerd" not in processes:
                raise StandFailure("DOCKER_INVENTORY_UNAVAILABLE")
            identity = (info.st_dev, info.st_ino)
            if identity in seen:
                continue
            seen.add(identity)
            found = True
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(5)
                client.connect(str(candidate))
                client.sendall(b"GET /containers/json?all=false&limit=1 HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                response = bytearray()
                while True:
                    part = client.recv(8192)
                    if not part:
                        break
                    response.extend(part)
                    if len(response) > MAX_OUTPUT:
                        raise StandFailure("DOCKER_INVENTORY_UNAVAILABLE")
            headers, separator, body = bytes(response).partition(b"\r\n\r\n")
            if not separator or headers.split(b"\r\n", 1)[0].split()[1:2] != [b"200"]:
                raise StandFailure("DOCKER_INVENTORY_UNAVAILABLE")
            rows = json.loads(body)
            if not isinstance(rows, list):
                raise StandFailure("DOCKER_INVENTORY_UNAVAILABLE")
            if rows:
                return True
        if not found:
            # A daemon/container runtime with no readable socket is not evidence
            # of an empty host. Only process names are read, never arguments/env.
            if any(name == "dockerd" or name.startswith("containerd") for name in processes):
                raise StandFailure("DOCKER_INVENTORY_UNAVAILABLE")
        return False
    except StandFailure:
        raise
    except (OSError, ValueError, IndexError):
        raise StandFailure("DOCKER_INVENTORY_UNAVAILABLE") from None


def scan_host():
    facts = {"system": platform.system(), "machine": platform.machine(), "os_id": "", "os_version": "",
             "local_ips": [], "api_ips": [], "listeners": [], "docker_running": None,
             "errors": [], "needs_tools": []}
    try:
        release = {}
        for line in Path("/etc/os-release").read_text().splitlines():
            key, separator, value = line.partition("=")
            if separator:
                release[key] = value.strip().strip('"\'')
        facts["os_id"] = release.get("ID", "")
        facts["os_version"] = release.get("VERSION_ID", "")
    except OSError:
        facts["errors"].append("OS_INVENTORY_UNAVAILABLE")
    for tool, arguments, parser, field, code in [
        ("ip", ["-j", "address", "show"], parse_addresses, "local_ips", "LOCAL_IP_INVENTORY_UNAVAILABLE"),
        ("ss", ["-H", "-lntu"], parse_listeners, "listeners", "LISTENER_INVENTORY_UNAVAILABLE"),
    ]:
        executable = shutil.which(tool)
        if not executable:
            facts["errors"].append(code)
            facts["needs_tools"].append(tool)
            continue
        try:
            facts[field] = parser(command([executable, *arguments], code=code)[0])
        except StandFailure as error:
            facts["errors"].append(error.code)
    if not shutil.which("git"):
        facts["needs_tools"].append("git")
    for operation, field in [(canonical_addresses, "api_ips"), (docker_running, "docker_running")]:
        try:
            facts[field] = operation()
        except StandFailure as error:
            facts["errors"].append(error.code)
    return facts


def evaluate(facts):
    codes = list(facts.get("errors", []))
    if facts.get("system") != "Linux" or facts.get("machine") not in ("x86_64", "amd64"):
        codes.append("UNSUPPORTED_PLATFORM")
    if facts.get("os_id") != "ubuntu" or facts.get("os_version") != "24.04":
        codes.append("UNSUPPORTED_OS")
    try:
        local = {normalized_address(value) for value in facts.get("local_ips", [])}
        api = {normalized_address(value) for value in facts.get("api_ips", [])}
        if not local or not any(not address.is_loopback for address in local):
            codes.append("LOCAL_IP_INVENTORY_UNAVAILABLE")
        if not api or any(not address.is_global for address in api):
            codes.append("CANONICAL_DNS_UNAVAILABLE")
        if local.intersection(map(ipaddress.ip_address, PRODUCTION_IPS)):
            codes.append("KNOWN_PRODUCTION_HOST")
        if local.intersection(api):
            codes.append("CANONICAL_API_HOST")
    except ValueError:
        codes.append("ADDRESS_INVENTORY_INVALID")
    for listener in facts.get("listeners", []):
        try:
            address = listener["address"]
            port = listener["port"]
            if port in RESERVED_PORTS:
                codes.append("RESERVED_SERVICE_LISTENER")
            wildcard = address == "*" or ipaddress.ip_address(address).is_unspecified
            public = wildcard or not ipaddress.ip_address(address).is_loopback
            if public and not (listener["protocol"] == "tcp" and port == 22):
                codes.append("NON_SSH_PUBLIC_LISTENER")
        except (ValueError, KeyError, TypeError):
            codes.append("LISTENER_INVENTORY_UNAVAILABLE")
    if facts.get("docker_running") is True:
        codes.append("RUNNING_DOCKER_CONTAINERS")
    elif facts.get("docker_running") is not False:
        codes.append("DOCKER_INVENTORY_UNAVAILABLE")
    codes = sorted(set(codes))
    needs = sorted(set(facts.get("needs_tools", [])))
    return {"schema": REPORT_SCHEMA, "scope": "current-network-and-process-namespaces",
            "status": "check-passed" if not codes and not needs else "check-refused",
            "host_checks_passed": not codes, "prepare_ready": not codes and not needs,
            "codes": codes, "needs_tools": needs,
            "limitations": ["owner-must-identify-separate-host", "not-proof-of-all-service-absence",
                            "not-a-platform-connection-test"]}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for part in iter(lambda: source.read(1 << 20), b""):
            digest.update(part)
    return digest.hexdigest()


def check_archive(path):
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_ARCHIVE or sha256(path) != GO_SHA256:
            raise StandFailure("GO_ARCHIVE_HASH_MISMATCH")
    except OSError:
        raise StandFailure("GO_ARCHIVE_UNAVAILABLE") from None


def validate_target(path):
    if not path.is_absolute() or ".." in path.parts or path == Path("/"):
        raise StandFailure("TARGET_MUST_BE_NEW_ABSOLUTE_PATH")
    if os.path.lexists(path):
        raise StandFailure("TARGET_ALREADY_EXISTS")
    try:
        for parent in path.parents:
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise StandFailure("TARGET_PARENT_UNSAFE")
            if info.st_uid not in (0, os.geteuid()) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                raise StandFailure("TARGET_PARENT_UNSAFE")
    except OSError:
        raise StandFailure("TARGET_PARENT_UNAVAILABLE") from None


def download_archive(destination):
    if destination.exists():
        check_archive(destination)
        return
    partial = destination.with_suffix(destination.suffix + ".part")
    try:
        with urllib.request.urlopen(GO_URL, timeout=30) as response, partial.open("xb") as output:
            if response.url != GO_URL:
                raise StandFailure("GO_DOWNLOAD_REDIRECT_REFUSED")
            size = 0
            while True:
                part = response.read(1 << 20)
                if not part:
                    break
                size += len(part)
                if size > MAX_ARCHIVE:
                    raise StandFailure("GO_DOWNLOAD_TOO_LARGE")
                output.write(part)
        check_archive(partial)
        partial.rename(destination)
    except StandFailure:
        partial.unlink(missing_ok=True)
        raise
    except (OSError, ValueError):
        partial.unlink(missing_ok=True)
        raise StandFailure("GO_DOWNLOAD_FAILED") from None


def extract_go(archive, destination):
    check_archive(archive)
    try:
        with tarfile.open(archive, "r:gz") as source:
            members = source.getmembers()
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "go" or not (member.isdir() or member.isfile()):
                    raise StandFailure("GO_ARCHIVE_CONTENT_REFUSED")
            source.extractall(destination, members=members, filter="data")
    except (tarfile.TarError, OSError):
        raise StandFailure("GO_EXTRACTION_FAILED") from None


def build_environment(root):
    # Do not pass arbitrary application credentials into dependency/build tools.
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
            "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO") if key in os.environ}
    env.update({"GOMAXPROCS": "1", "GOMEMLIMIT": "768MiB", "CGO_ENABLED": "0", "GOTOOLCHAIN": "local",
                "GOENV": "off", "GOWORK": "off", "GOPATH": str(root / "cache/gopath"),
                "GOCACHE": str(root / "cache/go-build"), "GOMODCACHE": str(root / "cache/go-mod"),
                "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/bin/false"})
    return env


def prepare_stand(root, archive_cache=None):
    previous_umask = os.umask(0o077)
    try:
        return _prepare_stand(root, archive_cache)
    finally:
        os.umask(previous_umask)


def _prepare_stand(root, archive_cache=None):
    validate_target(root)
    if archive_cache is not None:
        if not archive_cache.is_absolute():
            raise StandFailure("GO_CACHE_MUST_BE_ABSOLUTE")
        check_archive(archive_cache)
    os.mkdir(root, 0o700)
    os.chmod(root, 0o700)
    for child in ("downloads", "toolchain", "src", "bin", "evidence", "cache"):
        (root / child).mkdir(mode=0o700)
    archive = root / "downloads" / GO_ARCHIVE
    if archive_cache is None:
        download_archive(archive)
    else:
        shutil.copyfile(archive_cache, archive)
        check_archive(archive)
    extract_go(archive, root / "toolchain")
    env = build_environment(root)
    go = root / "toolchain/go/bin/go"
    output, _ = command([str(go), "version"], env=env, code="GO_VERSION_CHECK_FAILED")
    if output.strip() != b"go version go1.26.1 linux/amd64":
        raise StandFailure("GO_VERSION_CHECK_FAILED")
    source = root / "src/whitelist-bypass"
    git = shutil.which("git")
    common = [git, "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never"]
    command([*common, "init", str(source)], env=env, code="UPSTREAM_INIT_FAILED")
    command([*common, "remote", "add", "origin", UPSTREAM], cwd=source, env=env, code="UPSTREAM_REMOTE_FAILED")
    command([*common, "fetch", "--depth=1", "origin", UPSTREAM_COMMIT], cwd=source, env=env, timeout=180, code="UPSTREAM_FETCH_FAILED")
    command([*common, "checkout", "--detach", "FETCH_HEAD"], cwd=source, env=env, timeout=60, code="UPSTREAM_CHECKOUT_FAILED")
    output, _ = command([*common, "rev-parse", "HEAD"], cwd=source, env=env, code="UPSTREAM_PIN_CHECK_FAILED")
    if output.decode().strip() != UPSTREAM_COMMIT or (source / "LICENSE").read_text().splitlines()[0] != "MIT License":
        raise StandFailure("UPSTREAM_PIN_CHECK_FAILED")
    shutil.copyfile(source / "LICENSE", root / "evidence/UPSTREAM_LICENSE.txt")
    binaries = {}
    for name, package in (("telemost-creator", "./headless/telemost"), ("telemost-joiner", "./headless/telemost-joiner")):
        target = root / "bin" / name
        command([str(go), "build", "-trimpath", "-buildvcs=false", "-p=1", "-ldflags=-s -w", "-o", str(target), package],
                cwd=source, env=env, timeout=1800, code="BUILD_" + name.upper().replace("-", "_") + "_FAILED")
        # Do not rely on the Go command retaining our process umask for output.
        target.chmod(0o700)
        output, error = command(["./" + name, "--help"], cwd=root / "bin", env=env, timeout=20, code="BINARY_HELP_FAILED")
        help_text = output + error
        if b"Usage" not in help_text or len(help_text) > 64 * 1024:
            raise StandFailure("BINARY_HELP_FAILED")
        help_path = "evidence/" + name + ".help.txt"
        (root / help_path).write_bytes(help_text)
        binaries[name] = {"path": "bin/" + name, "sha256": sha256(target), "help_verified": True,
                          "help_path": help_path, "help_sha256": sha256(root / help_path)}
    manifest = {"schema": MANIFEST_SCHEMA, "status": "prepared-binaries-only",
                "toolchain": {"name": "go", "version": GO_VERSION, "archive": "downloads/" + GO_ARCHIVE, "archive_sha256": GO_SHA256},
                "upstream": {"repository": UPSTREAM, "commit": UPSTREAM_COMMIT, "path": "src/whitelist-bypass", "license_path": "evidence/UPSTREAM_LICENSE.txt"},
                "binaries": binaries, "services_started": False, "platform_connection_verified": False}
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise StandFailure("INVALID_ARGUMENTS")


def main(argv=None, *, scanner=scan_host, preparer=prepare_stand, output=None):
    output = output or sys.stdout
    try:
        parser = SafeParser(description=__doc__)
        group = parser.add_mutually_exclusive_group()
        group.add_argument("--check", action="store_true", help="Read-only host preflight (default).")
        group.add_argument("--prepare", metavar="NEW_ABSOLUTE_PRIVATE_DIRECTORY", type=Path)
        parser.add_argument("--go-archive", type=Path, help="Optional existing official archive; exact pinned hash is mandatory.")
        options = parser.parse_args(argv)
        if options.go_archive is not None and options.prepare is None:
            raise StandFailure("INVALID_ARGUMENTS")
        report = evaluate(scanner())
        if not report["prepare_ready"] or options.prepare is None:
            print(json.dumps(report, sort_keys=True), file=output)
            return 0 if report["prepare_ready"] else 2
        preparer(options.prepare, options.go_archive)
        print(json.dumps({"schema": REPORT_SCHEMA, "status": "prepared-binaries-only", "services_started": False,
                          "platform_connection_verified": False, "manifest": "manifest.json"}, sort_keys=True), file=output)
        return 0
    except StandFailure as error:
        print(json.dumps({"schema": REPORT_SCHEMA, "status": "refused", "codes": [error.code]}, sort_keys=True), file=output)
        return 2
    except Exception:
        print(json.dumps({"schema": REPORT_SCHEMA, "status": "refused", "codes": ["INTERNAL_ERROR"]}, sort_keys=True), file=output)
        return 2


if __name__ == "__main__":
    sys.exit(main())
