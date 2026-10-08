#!/usr/bin/env python3
"""Guarded changes for the running 11.1.1 workstation; no schema migrations."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import sys

PACKAGE = Path(__file__).resolve().parent

def encode_like(raw, text):
    return text.replace('\n', '\r\n' if b'\r\n' in raw else '\n').encode('utf-8')

def version_edit(path, lock=False):
    raw = read_bytes(path)
    text = raw.decode('utf-8').replace('\r\n', '\n')
    data = json.loads(text)
    versions = [data.get('version')]
    if lock:
        versions.append(data.get('packages', {}).get('', {}).get('version'))
    if any(v not in ['11.1.1', '13.0.0', '13.1.0'] for v in versions):
        raise ValueError(f'{path.name}: expected version 11.1.1, 13.0.0 or 13.1.0; no files changed')
    for indentation, version in zip([2, 6], versions):
        if version == '13.1.0':
            continue
        pattern = r'(?m)^(' + ' ' * indentation + r'"version"\s*:\s*")(?:11\.1\.1|13\.0\.0)(")'
        text, count = re.subn(pattern, r'\g<1>13.1.0\2', text)
        if count != 1:
            raise ValueError(f'{path.name}: version location differs; ask your developer to review')
    return encode_like(raw, text)

def cumulative_plan(root):
    if not (root / 'server/logger.js').is_file():
        raise ValueError('This update requires the existing 11.1.1 workstation with structured logging. No files changed.')
    writes = {}
    for entry in json.loads((PACKAGE / 'changes.json').read_text())['files']:
        relative = Path(entry['file'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Invalid package path')
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'{relative}: expected an existing regular file')
        raw = read_bytes(path)
        content = raw.decode('utf-8').replace('\r\n', '\n')
        original = content
        current = "worksheetVersion: '13.0'" in content
        for index, edit in enumerate(entry['edits'], 1):
            old, new = edit['before'], edit['after']
            if new in old and content.count(old) == 1:
                if current:
                    raise ValueError(f'{relative}: incomplete 13.0 edit {index}')
                content = content.replace(old, new, 1)
            elif content.count(new) == 1:
                continue
            elif not current and content.count(old) == 1:
                content = content.replace(old, new, 1)
            else:
                raise ValueError(f'{relative}: edit {index} differs from the known 11.1.1 source. No files changed.')
        if content != original:
            writes[path] = encode_like(raw, content)
    for name in ['package.json', 'package-lock.json']:
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'{name}: expected an existing regular file')
        content = version_edit(path, name.endswith('lock.json'))
        if content != read_bytes(path):
            writes[path] = content
    return writes


VIRTUAL = {}

def read_bytes(path):
    return VIRTUAL[path] if path in VIRTUAL else path.read_bytes()

def baseline_bytes(relative):
    baseline = PACKAGE / 'baseline-13.0' / relative
    return baseline.read_bytes() if baseline.is_file() else (PACKAGE / 'source' / relative).read_bytes()

def plan_delta(app):
    writes = {}
    manifest = json.loads((PACKAGE / 'changes-13.1.json').read_text())
    for entry in manifest['files']:
        relative = Path(entry['file'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Invalid release path')
        path = app / relative
        for parent in [path, *path.parents]:
            if parent == app:
                break
            if parent.is_symlink():
                raise ValueError(f'{relative}: symbolic link in source path')
        exists = path in VIRTUAL or path.is_file()
        if entry.get('new'):
            data = (PACKAGE / 'source' / relative).read_bytes()
            if exists:
                if read_bytes(path) != data:
                    raise ValueError(f'{relative}: differs from the 13.1 release')
            else:
                writes[path] = data
            continue
        if not exists:
            raise ValueError(f'{relative}: required source file is missing')
        raw = read_bytes(path)
        text = raw.decode('utf-8').replace('\r\n','\n')
        original = text
        for index, edit in enumerate(entry['edits'],1):
            old, new = edit['before'], edit['after']
            if text.count(new) == 1 and not (new in old and text.count(old) == 1):
                continue
            if text.count(old) != 1:
                raise ValueError(f'{relative}: 13.1 source block {index} differs; no files changed')
            text = text.replace(old,new,1)
        if text != original:
            writes[path] = text.replace('\n','\r\n' if b'\r\n' in raw else '\n').encode('utf-8')
    return writes

def plan(root):
    VIRTUAL.clear()
    app = root
    core = root / 'server/dockflow/sap-postgres.js'
    current = core.is_file() and b"worksheetVersion: '13.1'" in core.read_bytes()
    try:
        if not current:
            VIRTUAL.update(cumulative_plan(root))
        else:
            # A reinstall must not conceal missing cumulative source/migration files.
            cumulative = json.loads((PACKAGE / 'changes.json').read_text())
            variants = cumulative if isinstance(cumulative,list) else [cumulative]
            for entry in variants[0]['files']:
                if not (app / entry['file']).is_file():
                    raise ValueError(f"{entry['file']}: cumulative source file missing")
        VIRTUAL.update(plan_delta(app))
        for name in ['package.json','package-lock.json']:
            path = root / name
            if not path.is_file() or path.is_symlink():
                raise ValueError(f'{name}: expected an existing regular file')
            VIRTUAL[path] = version_edit(path,name.endswith('lock.json'))
        return {path:data for path,data in VIRTUAL.items() if not path.is_file() or data != path.read_bytes()}
    finally:
        VIRTUAL.clear()

def apply(root, writes, backup):
    backup.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(backup, 0o700)
    originals = []
    for path in writes:
        relative = path.relative_to(root)
        saved = backup / 'source' / relative
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, saved)
        originals.append(relative.as_posix())
    (backup / 'rollback.json').write_text(json.dumps({'root': str(root), 'originals': originals}, indent=2))
    try:
        for path, data in writes.items():
            temporary = path.with_name(path.name + '.dockflow-update.tmp')
            temporary.write_bytes(data)
            shutil.copymode(path, temporary)
            temporary.replace(path)
    except Exception:
        restore(backup)
        raise

def restore(backup):
    manifest = json.loads((backup / 'rollback.json').read_text())
    root = Path(manifest['root'])
    for relative in manifest['originals']:
        shutil.copy2(backup / 'source' / relative, root / relative)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('workstation_root', type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--backup', type=Path)
    args = parser.parse_args()
    try:
        root = args.workstation_root.resolve()
        writes = plan(root)
        if args.apply and writes:
            backup = args.backup or root / '.maintenance-backups' / ('dockflow-13.1-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
            apply(root, writes, backup)
            print(f'Applied {len(writes)} workstation files. Source backup: {backup}')
        else:
            print(f'Validated {len(writes)} workstation files.' if writes else 'Workstation 13.1 source is already applied.')
    except (ValueError, OSError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
