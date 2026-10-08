#!/usr/bin/env python3
"""Restore deleted source/configuration from the full package and retained containers."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

PACKAGE = Path(__file__).resolve().parent


def docker_json(*args, cwd=None):
    result = subprocess.run(['docker', *args], cwd=cwd, text=True,
                            capture_output=True, encoding='utf-8')
    if result.returncode:
        raise ValueError('Docker inspection/configuration failed. Check Docker Desktop; no containers were changed.')
    return json.loads(result.stdout)


def one_container(service, project=None):
    command = ['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.service={service}']
    if project:
        command += ['--filter', f'label=com.docker.compose.project={project}']
    result = subprocess.run(command, text=True, capture_output=True, encoding='utf-8', check=True)
    ids = result.stdout.split()
    if len(ids) != 1:
        raise ValueError(f'Expected one retained {service} container. Configuration cannot be recovered automatically.')
    return docker_json('inspect', ids[0])[0]


def environment(container):
    return dict(item.split('=', 1) for item in container['Config'].get('Env', []) if '=' in item)


def recovered_values(containers):
    worker, dock, power = (environment(containers[name]) for name in ['worker', 'dockflow-db', 'power-tool-db'])
    for key in ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_SSL']:
        if dock.get(key) != power.get(key):
            raise ValueError('The two database containers use different shared settings. Restore the original custom configuration first.')
    values = {
        'COMPANY_API_KEY': worker.get('COMPANY_API_KEY', ''),
        'UBUNTU_BRIDGE_URL': worker.get('UBUNTU_BRIDGE_URL', ''),
        'COMPANY_DB_HOST': dock.get('POSTGRES_HOST', ''),
        'COMPANY_DB_PORT': dock.get('POSTGRES_PORT', '5432'),
        'COMPANY_DB_SSL': dock.get('POSTGRES_SSL', 'false'),
        'DOCKFLOW_COMPANY_DB_NAME': dock.get('POSTGRES_DB', 'DockFlow'),
        'DOCKFLOW_COMPANY_DB_USER': dock.get('POSTGRES_USER', ''),
        'DOCKFLOW_COMPANY_DB_PASSWORD': dock.get('POSTGRES_PASSWORD', ''),
        'DOCKFLOW_COMPANY_DB_SCHEMA': dock.get('POSTGRES_SCHEMA', 'Analysis'),
        'DOCKFLOW_COMPANY_DRESSINGS_TABLE': dock.get('POSTGRES_SAP_DRESSINGS_TABLE', 'SAPAnalysisDressings'),
        'DOCKFLOW_COMPANY_SAVOURY_TABLE': dock.get('POSTGRES_SAP_SAVOURY_TABLE', 'SAPAnalysisSavoury'),
        'POWER_TOOL_COMPANY_DB_NAME': power.get('POSTGRES_DB', 'confirmation_powertool_machine'),
        'POWER_TOOL_COMPANY_DB_USER': power.get('POSTGRES_USER', ''),
        'POWER_TOOL_COMPANY_DB_PASSWORD': power.get('POSTGRES_PASSWORD', ''),
        'POWER_TOOL_COMPANY_DB_SCHEMA': power.get('POSTGRES_SCHEMA', 'power_tool'),
        'LOG_LEVEL': dock.get('LOG_LEVEL', 'info'),
        'WORKSTATION_ID': worker.get('WORKSTATION_ID', 'not-configured'),
    }
    if any(not value for value in values.values()):
        raise ValueError('Retained containers are missing required configuration. Restore the original .env before deployment.')
    return values


def env_text(values):
    lines = ['# Recovered privately from retained Docker containers. Do not share this file.']
    for key, value in values.items():
        if any(character in value for character in '\r\n\x00'):
            raise ValueError('Configuration contains unsupported multiline values; restore .env manually.')
        # Compose treats single quotes literally, including dollar signs.
        # A private Compose round-trip below verifies every connection value.
        lines.append(key + "='" + value.replace("'", "\\'") + "'")
    return '\n'.join(lines) + '\n'


def validate_config(config, containers):
    connection_keys = {
        'worker': ['COMPANY_API_KEY', 'UBUNTU_BRIDGE_URL'],
        'dockflow-db': ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_SCHEMA', 'POSTGRES_SSL', 'POSTGRES_SAP_DRESSINGS_TABLE', 'POSTGRES_SAP_SAVOURY_TABLE'],
        'power-tool-db': ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_SCHEMA', 'POSTGRES_SSL'],
    }
    for service, keys in connection_keys.items():
        actual = config['services'][service].get('environment', {})
        previous = environment(containers[service])
        if any(str(actual.get(key, '')) != previous.get(key, '') for key in keys):
            raise ValueError('Recovered Compose configuration differs from retained connection settings. No containers were changed.')


def restore(deploy=False):
    if not shutil.which('docker'):
        raise ValueError('Docker Desktop/Docker CLI is required for automatic recovery.')
    db = one_container('dockflow-db')
    labels = db['Config'].get('Labels', {})
    project = labels.get('com.docker.compose.project', '')
    location = labels.get('com.docker.compose.project.working_dir', '')
    if not project or not location or not Path(location).is_absolute():
        raise ValueError('The original Compose folder is not accessible from this shell. Use the same OS/shell as the original installation.')
    root = Path(location).resolve()
    compose = root / 'compose.yaml'
    configured = labels.get('com.docker.compose.project.config_files', '')
    if configured and [Path(p).resolve() for p in configured.split(',')] != [compose]:
        raise ValueError('Custom Compose files/overrides were used. Restore those files from your backup before deployment.')
    containers = {'dockflow-db': db, 'worker': one_container('worker', project), 'power-tool-db': one_container('power-tool-db', project)}
    values = recovered_values(containers)
    source = PACKAGE / 'workstation-api'
    excluded = {'node_modules', '__pycache__', '.maintenance-backups', '.git'}
    files = [p for p in source.rglob('*') if p.is_file() and p.name != '.env'
             and not excluded.intersection(p.relative_to(source).parts)]
    for file in files:
        target = root / file.relative_to(source)
        if any(parent.is_symlink() for parent in [target, *target.parents] if parent != root and root in parent.parents):
            raise ValueError('A source path contains a symbolic link; no source was replaced.')
        if target.exists() and not target.is_file():
            raise ValueError('A source path has an unexpected file type; no source was replaced.')
    env_file = root / '.env'
    if env_file.is_symlink():
        raise ValueError('The existing .env is a symbolic link. Restore its intended configuration manually before using recovery.')
    os.umask(0o077)
    backup = root / '.maintenance-backups' / ('source-recovery-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'retained-environments.json').write_text(json.dumps({name: environment(c) for name, c in containers.items()}, indent=2), encoding='utf-8')
    candidate = env_file if env_file.is_file() else backup / 'recovered.env'
    if candidate != env_file:
        candidate.write_text(env_text(values), encoding='utf-8')
        candidate.chmod(0o600)
    clean_env = {key: value for key, value in os.environ.items() if key not in values}
    check = subprocess.run(['docker', 'compose', '--project-name', project, '--env-file', str(candidate), '-f', str(compose if compose.is_file() else source / 'compose.yaml'), 'config', '--format', 'json'], cwd=root, env=clean_env, text=True, encoding='utf-8', capture_output=True)
    if check.returncode:
        raise ValueError('Private Compose validation failed; no source or containers were changed. Keep the recovery backup private.')
    validate_config(json.loads(check.stdout), containers)
    originals, created = [], []
    try:
        for file in files:
            relative = file.relative_to(source)
            target = root / relative
            if target.resolve() == file.resolve():
                continue
            # Retain current build/config customizations; deploy.py validates them.
            if relative.as_posix() in ['compose.yaml', 'Dockerfile', '.dockerignore'] and target.exists():
                continue
            if target.exists():
                saved = backup / 'source' / relative
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, saved)
                originals.append(relative)
            else:
                created.append(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
        if not env_file.exists():
            shutil.copy2(candidate, env_file)
            env_file.chmod(0o600)
        (backup / 'source-recovery.json').write_text(json.dumps({'root': str(root), 'originals': [p.as_posix() for p in originals], 'created': [p.as_posix() for p in created]}, indent=2), encoding='utf-8')
    except Exception:
        for relative in originals:
            shutil.copy2(backup / 'source' / relative, root / relative)
        for relative in created:
            (root / relative).unlink(missing_ok=True)
        raise
    print(f'Complete 13.1 source restored: {root}')
    print('Existing .env preserved or recovered; connection values verified privately. No credentials were printed.')
    print(f'Private recovery backup: {backup}')
    if deploy:
        return subprocess.run([sys.executable, str(PACKAGE / 'upgrade/deploy.py'), str(root)], env=clean_env).returncode
    print(f'Next: "{sys.executable}" "{PACKAGE / "upgrade/deploy.py"}" "{root}"')
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--deploy', action='store_true', help='After recovery, build and verify dockflow-db using the guarded installer')
    args = parser.parse_args()
    try:
        sys.exit(restore(args.deploy))
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error) if isinstance(error, ValueError) else 'Recovery failed; existing containers were not removed. Check Docker and folder access.', file=sys.stderr)
        sys.exit(1)
