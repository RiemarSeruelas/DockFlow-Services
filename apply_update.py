#!/usr/bin/env python3
"""Apply the reviewed 13.1 -> 13.2 source delta; preserve configuration and data."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

PACKAGE=Path(__file__).resolve().parent

def digest(data):
    return hashlib.sha256(data.decode('utf-8').replace('\r\n','\n').encode('utf-8')).hexdigest()

def safe_path(root, relative):
    relative=Path(relative)
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError('Invalid release path')
    result=root/relative
    for path in [result,*result.parents]:
        if path==root:break
        if path.is_symlink():raise ValueError(f'{relative}: symbolic links are not supported; no files changed')
    return result

def plan(root):
    writes={}
    manifest=json.loads((PACKAGE/'changes-13.2.json').read_text())
    for entry in manifest['files']:
        path=safe_path(root,entry['file'])
        supplied=safe_path(PACKAGE/'source',entry['file'])
        content=supplied.read_bytes()
        if digest(content)!=entry['after']:raise ValueError(f'{entry["file"]}: package checksum differs')
        if path.is_file():
            raw=path.read_bytes();current=digest(raw)
            if current==entry['after']:continue
            if current not in entry['before']:raise ValueError(f'{entry["file"]}: differs from the supplied production 13.1 source. No files changed. Keep this output for review; do not overwrite the application folder.')
            if b'\r\n' in raw:content=content.decode('utf-8').replace('\r\n','\n').replace('\n','\r\n').encode('utf-8')
        elif entry['before']:
            raise ValueError(f'{entry["file"]}: expected source file is missing; no files changed')
        writes[path]=content
    return writes

def apply(root,writes,backup):
    backup.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(backup,0o700)
    originals,created=[],[]
    for path in writes:
        relative=path.relative_to(root).as_posix()
        if path.exists():
            saved=backup/'source'/relative;saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,saved);originals.append(relative)
        else:created.append(relative)
    (backup/'rollback.json').write_text(json.dumps({'root':str(root),'originals':originals,'created':created},indent=2))
    try:
        for path,content in writes.items():
            path.parent.mkdir(parents=True,exist_ok=True)
            temporary=path.with_name(path.name+'.dockflow-13.2.tmp')
            temporary.write_bytes(content)
            if path.exists():shutil.copymode(path,temporary)
            temporary.replace(path)
    except Exception:
        restore(backup)
        raise

def restore(backup):
    record=json.loads((backup/'rollback.json').read_text());root=Path(record['root'])
    for relative in record['originals']:shutil.copy2(backup/'source'/relative,safe_path(root,relative))
    for relative in record['created']:safe_path(root,relative).unlink(missing_ok=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('existing_root',type=Path)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--backup',type=Path)
    args=parser.parse_args()
    try:
        root=args.existing_root.resolve();writes=plan(root)
        if args.apply and writes:
            backup=args.backup or root/'.maintenance-backups'/('dockflow-13.2-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
            apply(root,writes,backup);print(f'Applied {len(writes)} source files. Private backup: {backup}')
        else:print(f'Validated {len(writes)} source changes.' if writes else 'The reviewed 13.2 source is already applied.')
    except (ValueError,OSError,UnicodeError) as error:
        print(str(error),file=sys.stderr);sys.exit(1)
