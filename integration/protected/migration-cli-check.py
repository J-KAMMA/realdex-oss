#!/usr/bin/env python3
"""Bounded smoke check for the real UP03 protected migration CLI.

This checker deliberately uses only disposable fixtures.  The production
launcher is exercised through a pseudo-terminal for both password prompts so
that getpass's terminal echo behaviour is part of the check.
"""
import json
import os
import secrets
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import termios
import time
import pty
from pathlib import Path


SCHEMA = "realdex.up03-migration-cli.v1"
TIMEOUT_MS = 30000
PASSWORD = "UP03 checker " + secrets.token_hex(18)
CHECK_NAMES = (
    "fresh-owner-only-fixtures",
    "test-launch-watch-only-source",
    "test-launch-current-backup-verified",
    "production-target-json-status",
    "production-export-pty-hidden-password",
    "production-export-status-source-frozen",
    "source-normal-open-rejected-while-pending",
    "production-import-pty-hidden-password",
    "production-import-status-target-id",
    "receipt-generation-one",
    "production-finalize-status-source-retired",
    "destination-normal-open-preserves-watch-account",
    "destination-provenance-binds-source-and-target",
)


class CheckFailure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise CheckFailure(code)


def safe_env():
    # Do not inherit application secrets or arbitrary Python import hooks.
    result = {}
    for key in ("PATH", "HOME", "LANG", "TMPDIR"):
        value = os.environ.get(key)
        if value is not None:
            result[key] = value
    return result


def parse_json_output(text):
    rows = [json.loads(line) for line in text.splitlines() if line.strip().startswith("{")]
    require(len(rows) == 1 and isinstance(rows[0], dict), "CLI_JSON_STATUS_MISSING")
    return rows[0]


def run_command(root, args, input_text=None):
    try:
        result = subprocess.run(
            args,
            cwd=str(root),
            env=safe_env(),
            **({"stdin": subprocess.DEVNULL} if input_text is None else {"input": input_text}),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=TIMEOUT_MS / 1000,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise CheckFailure("CHILD_TIMEOUT") from exc
    require(result.returncode == 0, "CHILD_NONZERO")
    return parse_json_output(result.stdout)


def run_pty_command(root, args, password):
    """Run one owned child with a real PTY and answer exactly one prompt."""
    pid, master = pty.fork()
    if pid == pty.CHILD:
        try:
            os.chdir(root)
            os.execvpe(args[0], args, safe_env())
        except BaseException:
            os._exit(127)

    output = bytearray()
    prompt = b"Vault password:"
    password_bytes = password.encode("utf-8")
    prompt_seen = False
    password_sent = False
    echo_off = False
    deadline = time.monotonic() + TIMEOUT_MS / 1000
    status = None
    try:
        os.set_blocking(master, False)
        while True:
            if status is None:
                waited, status = os.waitpid(pid, os.WNOHANG)
                if waited == 0:
                    status = None
            if status is not None:
                try:
                    while True:
                        chunk = os.read(master, 65536)
                        if not chunk:
                            break
                        output.extend(chunk)
                except (BlockingIOError, OSError):
                    pass
                break
            if time.monotonic() >= deadline:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                raise CheckFailure("CHILD_TIMEOUT")
            readable, _, _ = select.select([master], [], [], 0.1)
            if not readable:
                continue
            try:
                chunk = os.read(master, 65536)
            except (BlockingIOError, OSError):
                continue
            if not chunk:
                continue
            output.extend(chunk)
            if password_bytes in output:
                raise CheckFailure("MIGRATION_PASSWORD_ECHOED")
            if not prompt_seen and prompt in output:
                prompt_seen = True
                try:
                    attrs = termios.tcgetattr(master)
                    echo_off = not bool(attrs[3] & termios.ECHO)
                except OSError as exc:
                    raise CheckFailure("PTY_ECHO_STATE_UNREADABLE") from exc
                require(echo_off, "MIGRATION_PASSWORD_ECHO_ON")
                os.write(master, password_bytes + b"\n")
                password_sent = True
        exit_code = os.waitstatus_to_exitcode(status)
        require(prompt_seen and password_sent, "MIGRATION_PASSWORD_PROMPT_MISSING")
        require(echo_off, "MIGRATION_PASSWORD_ECHO_ON")
        require(password_bytes not in output, "MIGRATION_PASSWORD_ECHOED")
        require(exit_code == 0, "CHILD_NONZERO")
        return parse_json_output(output.decode("utf-8", "replace"))
    finally:
        if status is None:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
        try:
            os.close(master)
        except OSError:
            pass


def launch_probe(root, directory, checkpoint, enroll, script, password=None):
    args = [
        "python3",
        "-I",
        "-S",
        str(root / "integration/protected/test-launch.py"),
        str(directory),
        str(checkpoint),
        "yes" if enroll else "no",
        "probe",
        script,
    ]
    return run_command(root, args, password)


def check_directory(path, prefix):
    resolved = path.resolve()
    value = os.lstat(resolved)
    require(value.st_uid == os.getuid(), "FIXTURE_DIRECTORY_OWNER")
    require(stat.S_ISDIR(value.st_mode) and stat.S_IMODE(value.st_mode) & 0o077 == 0, "FIXTURE_DIRECTORY_PERMISSIONS")
    require(resolved.name.startswith(prefix), "FIXTURE_DIRECTORY_PREFIX")
    require(resolved == Path(os.path.realpath(resolved)), "FIXTURE_DIRECTORY_LINK")


def check_transfer_directory(path):
    value = os.lstat(path)
    require(value.st_uid == os.getuid(), "TRANSFER_DIRECTORY_OWNER")
    require(stat.S_ISDIR(value.st_mode) and stat.S_IMODE(value.st_mode) & 0o077 == 0, "TRANSFER_DIRECTORY_PERMISSIONS")
    require(path == Path(os.path.realpath(path)), "TRANSFER_DIRECTORY_LINK")


def check_file_owner_only(path):
    value = os.lstat(path)
    require(value.st_uid == os.getuid(), "MIGRATION_FILE_OWNER")
    require(stat.S_ISREG(value.st_mode) and not stat.S_ISLNK(value.st_mode), "MIGRATION_FILE_TYPE")
    require(value.st_nlink == 1 and stat.S_IMODE(value.st_mode) & 0o077 == 0, "MIGRATION_FILE_PERMISSIONS")


def cleanup(paths):
    failed = False
    for path, prefix in paths:
        try:
            require(path.name.startswith(prefix) and path.parent == Path(tempfile.gettempdir()).resolve(), "FIXTURE_CLEANUP_PATH")
            shutil.rmtree(path)
        except FileNotFoundError:
            continue
        except (OSError, CheckFailure):
            failed = True
    return not failed


def main():
    root = Path(__file__).resolve().parents[2]
    checks = {name: False for name in CHECK_NAMES}
    generated = []
    def fixture(prefix):
        value = Path(tempfile.mkdtemp(prefix=prefix))
        generated.append((value, prefix))
        return value
    summary = {
        "schema": SCHEMA,
        "status": "failed",
        "passed": False,
        "checks": [{"name": name, "passed": False} for name in CHECK_NAMES],
        "networkUsed": False,
        "userFunds": False,
        "publicTestnet": False,
        "browserTested": False,
        "signerUsed": False,
        "productionReady": False,
        "timeoutMs": TIMEOUT_MS,
    }
    try:
        source_vault = fixture("realdex-up01-vault-")
        source_witness = fixture("realdex-up01-witness-")
        target_vault = fixture("realdex-up01-vault-")
        target_witness = fixture("realdex-up01-witness-")
        transfer = fixture("realdex-up03-transfer-")
        for path, prefix in generated:
            check_directory(path, prefix) if prefix != "realdex-up03-transfer-" else check_transfer_directory(path)
        checks["fresh-owner-only-fixtures"] = True

        init_script = (
            "import {CheckpointLeaseStore} from './wallet/protected/store.mjs';"
            "import {Vault} from './wallet/lib/vault.mjs';"
            "const home=process.argv[1],witness=process.argv[2],password=(await import('node:fs')).readFileSync(0,'utf8');"
            "const s=new CheckpointLeaseStore(home,witness),v=new Vault(s);"
            "await v.create(password);"
            "const a=await v.addAccount({family:'evm',label:'UP03 disposable watch',watchAddress:'0x1111111111111111111111111111111111111111'});"
            "const b=await v.backup();const verified=await v.verifyBackup(b.encrypted,password);"
            "console.log(JSON.stringify({created:true,backupVerified:verified.verified,account:{kind:a.kind,family:a.family,address:a.address},storage:s.info()}));"
            "v.lock();s.close();"
        )
        source = launch_probe(root, source_vault, source_witness, True, init_script, PASSWORD)
        require(source.get("created") is True, "SOURCE_CREATE_STATUS")
        require(source.get("account", {}).get("kind") == "watch", "SOURCE_NOT_WATCH_ONLY")
        require(source.get("account", {}).get("address") == "0x1111111111111111111111111111111111111111", "SOURCE_WATCH_ADDRESS")
        checks["test-launch-watch-only-source"] = True
        require(source.get("backupVerified") is True, "SOURCE_BACKUP_NOT_VERIFIED")
        checks["test-launch-current-backup-verified"] = True
        source_pair_id = source["storage"]["pairId"]

        descriptor = transfer / "target.json"
        package = transfer / "package.json"
        receipt = transfer / "receipt.json"
        cli = root / "wallet/protected/migrate.py"
        common = ["python3", "-I", "-S", str(cli)]
        target_result = run_command(root, common + [
            "target", "--directory", str(target_vault), "--checkpoint", str(target_witness),
            "--enroll", "--descriptor", str(descriptor), "--acknowledge-experimental",
        ])
        check_file_owner_only(descriptor)
        descriptor_data = json.loads(descriptor.read_text(encoding="utf-8"))
        require(target_result.get("prepared") is True, "TARGET_STATUS")
        require(target_result.get("pairId") == descriptor_data.get("pairId"), "TARGET_PAIR_ID")
        require(target_result.get("pairId") != source_pair_id, "MIGRATION_PAIR_NOT_DISTINCT")
        checks["production-target-json-status"] = True

        export_result = run_pty_command(root, common + [
            "export", "--directory", str(source_vault), "--checkpoint", str(source_witness),
            "--descriptor", str(descriptor), "--package", str(package), "--acknowledge-experimental",
        ], PASSWORD)
        check_file_owner_only(package)
        require(export_result.get("exported") is True, "EXPORT_STATUS")
        require(export_result.get("sourceFrozen") is True, "EXPORT_NOT_FROZEN")
        require(export_result.get("existing") is False, "EXPORT_UNEXPECTED_EXISTING")
        migration_id = export_result.get("migrationId")
        require(isinstance(migration_id, str) and len(migration_id) == 64, "EXPORT_MIGRATION_ID")
        checks["production-export-pty-hidden-password"] = True
        checks["production-export-status-source-frozen"] = True

        pending_script = (
            "import {CheckpointLeaseStore} from './wallet/protected/store.mjs';"
            "try{const s=new CheckpointLeaseStore(process.argv[1],process.argv[2]);"
            "console.log(JSON.stringify({normalOpen:true}));s.close();}"
            "catch(e){console.log(JSON.stringify({normalOpen:false,error:e.message}));}"
        )
        pending_result = launch_probe(root, source_vault, source_witness, False, pending_script)
        require(pending_result.get("normalOpen") is False and pending_result.get("error") == "CP_MIGRATION_PENDING", "SOURCE_PENDING_OPENED")
        checks["source-normal-open-rejected-while-pending"] = True

        import_result = run_pty_command(root, common + [
            "import", "--directory", str(target_vault), "--checkpoint", str(target_witness),
            "--package", str(package), "--receipt", str(receipt), "--acknowledge-experimental",
        ], PASSWORD)
        check_file_owner_only(receipt)
        require(import_result.get("imported") is True, "IMPORT_STATUS")
        require(import_result.get("targetPairId") == descriptor_data.get("pairId"), "IMPORT_TARGET_PAIR_ID")
        require(import_result.get("migrationId") == migration_id, "IMPORT_MIGRATION_ID")
        receipt_data = json.loads(receipt.read_text(encoding="utf-8"))
        require(receipt_data.get("destinationGeneration") == "1", "RECEIPT_GENERATION")
        require(receipt_data.get("targetPairId") == descriptor_data.get("pairId") and receipt_data.get("migrationId") == migration_id, "RECEIPT_IDENTITY")
        checks["production-import-pty-hidden-password"] = True
        checks["production-import-status-target-id"] = True

        destination_script = (
            "import {CheckpointLeaseStore} from './wallet/protected/store.mjs';"
            "import {Vault} from './wallet/lib/vault.mjs';"
            "const s=new CheckpointLeaseStore(process.argv[1],process.argv[2]),v=new Vault(s);"
            "await v.unlock((await import('node:fs')).readFileSync(0,'utf8'));const a=v.publicAccounts()[0];"
            "console.log(JSON.stringify({opened:true,generation:s.info().generation,account:{kind:a.kind,family:a.family,address:a.address},storageProtection:v.data.storageProtection,storageMigration:v.data.storageMigration}));"
            "v.lock();s.close();"
        )
        destination = launch_probe(root, target_vault, target_witness, False, destination_script, PASSWORD)
        require(destination.get("opened") is True, "DESTINATION_OPEN_STATUS")
        require(destination.get("generation") == "1", "DESTINATION_GENERATION")
        checks["receipt-generation-one"] = True
        require(destination.get("account", {}).get("kind") == "watch", "DESTINATION_NOT_WATCH_ONLY")
        require(destination.get("account", {}).get("address") == source["account"]["address"], "DESTINATION_ACCOUNT_CHANGED")
        checks["destination-normal-open-preserves-watch-account"] = True
        protection = destination.get("storageProtection", {})
        migration = destination.get("storageMigration", {})
        require(protection.get("pairId") == descriptor_data.get("pairId"), "DESTINATION_PAIR_ID")
        require(migration.get("sourcePairId") == source_pair_id, "DESTINATION_SOURCE_PROVENANCE")
        require(migration.get("targetPairId") == descriptor_data.get("pairId"), "DESTINATION_TARGET_PROVENANCE")
        require(migration.get("migrationId") == migration_id, "DESTINATION_MIGRATION_PROVENANCE")
        checks["destination-provenance-binds-source-and-target"] = True

        finalize_result = run_command(root, common + [
            "finalize", "--directory", str(source_vault), "--checkpoint", str(source_witness),
            "--receipt", str(receipt), "--acknowledge-experimental",
        ])
        require(finalize_result.get("finalized") is True, "FINALIZE_STATUS")
        require(finalize_result.get("sourceRetired") is True, "SOURCE_NOT_RETIRED")
        require(finalize_result.get("migrationId") == migration_id, "FINALIZE_MIGRATION_ID")
        checks["production-finalize-status-source-retired"] = True

        retired_result = launch_probe(root, source_vault, source_witness, False, pending_script)
        require(retired_result.get("normalOpen") is False and retired_result.get("error") == "CP_MIGRATED_OUT", "SOURCE_RETIRED_OPENED")
        checks["production-finalize-status-source-retired"] = True
        summary["status"] = "passed"
        summary["passed"] = all(checks.values())
    except CheckFailure as exc:
        summary["error"] = str(exc)
    except BaseException as exc:
        summary["error"] = type(exc).__name__
    finally:
        summary["checks"] = [{"name": name, "passed": bool(checks[name])} for name in CHECK_NAMES]
        summary["passed"] = bool(summary["passed"] and all(checks.values()))
        summary["status"] = "passed" if summary["passed"] else "failed"
        if not cleanup(generated):
            summary.update(status="failed", passed=False, error="FIXTURE_CLEANUP_FAILED")
    print(json.dumps(summary, separators=(",", ":")))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
