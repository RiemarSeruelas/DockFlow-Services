#!/usr/bin/env python3
"""Deploy only dockflow-db on a Linux or Windows Docker workstation."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys
from apply_update import apply, plan, restore

HEALTH = """
let ready = false;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:8081/api/dockflow/health', {signal: AbortSignal.timeout(20000)});
    const result = await response.json();
    ready = response.ok && result.ok && ['DRESSINGS','SAVOURY'].every(area => result.areas?.[area]?.worksheetVersion === '13.1');
    if (ready) break;
  } catch {}
  if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 2000));
}
if (!ready) { console.error('Receiving Records health or mapping check failed.'); process.exitCode = 1; }
else console.log('Workstation 13.1 is healthy for DRESSINGS and SAVOURY.');
"""

def docker(root, *args, capture=False, timeout=None):
    return subprocess.run(['docker', *args], cwd=root, check=True, text=True,
                          capture_output=capture, timeout=timeout)

def container_value(root, container, template):
    return docker(root, 'inspect', '--format', template, container, capture=True).stdout.strip()

def rollback(backup, source_only=False):
    restore(backup)
    if source_only:
        print('Previous workstation source restored; running containers unchanged.')
        return
    info = json.loads((backup / 'deployment.json').read_text())
    root = Path(info['root'])
    docker(root, 'compose', '--project-name', info['project'], '-f', info['compose'], '-f', str(backup / 'images.json'),
           'up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '120', 'dockflow-db')
    print('Previous dockflow-db source and running image restored.')

def deploy(root):
    if not shutil.which('docker'):
        raise ValueError('Docker is required; no files changed.')
    compose = next((p for p in [root / 'compose.yaml', root / 'docker-compose.yml'] if p.is_file()), None)
    if not compose or not (root / '.env').is_file():
        raise ValueError('Use the existing workstation-api folder containing Compose and .env; no files changed.')
    writes = plan(root)
    docker(root, 'compose', 'version', capture=True)
    candidates = docker(root, 'ps', '-q', '--filter', 'label=com.docker.compose.service=dockflow-db', capture=True).stdout.split()
    matching = [cid for cid in candidates if Path(container_value(root, cid, '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')).resolve() == root]
    if len(matching) != 1:
        raise ValueError('Expected one running dockflow-db for this workstation folder. No files changed.')
    cid = matching[0]
    project = container_value(root, cid, '{{ index .Config.Labels "com.docker.compose.project" }}')
    config_files = container_value(root, cid, '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')
    if config_files and [Path(p).resolve() for p in config_files.split(',')] != [compose.resolve()]:
        raise ValueError('Custom Compose overrides found. Ask the developer to apply this patch using that configuration. No files changed.')
    prefix = ['compose', '--project-name', project, '-f', str(compose)]
    docker(root, *prefix, 'config', '--quiet')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = root / '.maintenance-backups' / ('dockflow-13.1-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    image = 'dockflow-release-backup/workstation-dockflow-db:' + stamp
    docker(root, 'image', 'tag', container_value(root, cid, '{{.Image}}'), image)
    (backup / 'deployment.json').write_text(json.dumps({'root': str(root), 'compose': str(compose), 'project': project}, indent=2))
    (backup / 'images.json').write_text(json.dumps({'services': {'dockflow-db': {'image': image}}}, indent=2))
    # Keep rollback executable independent of the downloaded package location.
    for name in ['apply_update.py', 'deploy.py']:
        shutil.copy2(Path(__file__).resolve().parent / name, backup / name)
    apply(root, writes, backup)
    print('Building dockflow-db. Existing services remain running.', flush=True)
    try:
        docker(root, *prefix, 'build', 'dockflow-db')
    except subprocess.CalledProcessError:
        rollback(backup, source_only=True)
        raise ValueError('Build failed. No running containers were replaced.')
    try:
        docker(root, *prefix, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'dockflow-db')
        ids = docker(root, 'ps', '-q', '--filter', f'label=com.docker.compose.project={project}', '--filter', 'label=com.docker.compose.service=dockflow-db', capture=True).stdout.split()
        if len(ids) != 1:
            raise ValueError('Updated dockflow-db container was not found.')
        docker(root, 'exec', ids[0], 'node', '--input-type=module', '-e', HEALTH, timeout=75)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError):
        print('Workstation deployment failed. Restoring the previous dockflow-db image.', flush=True)
        rollback(backup)
        raise ValueError('Workstation deployment did not pass verification; previous dockflow-db restored.')
    print('Workstation update complete. Worker and Power Tool containers were not recreated.')
    print(f'Rollback: python "{backup / "deploy.py"}" --rollback "{backup}"')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('workstation_root', type=Path, nargs='?')
    parser.add_argument('--rollback', type=Path)
    parser.add_argument('--discover', action='store_true', help='Use the single running dockflow-db Compose folder')
    args = parser.parse_args()
    try:
        if args.rollback:
            rollback(args.rollback.resolve())
        elif args.workstation_root:
            deploy(args.workstation_root.resolve())
        elif args.discover:
            containers = docker(Path.cwd(), 'ps', '-q', '--filter', 'label=com.docker.compose.service=dockflow-db', capture=True).stdout.split()
            if len(containers) != 1:
                raise ValueError('Expected one running dockflow-db; specify the existing workstation-api folder explicitly. No files changed.')
            label = container_value(Path.cwd(), containers[0], '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')
            if not label or not Path(label).is_dir():
                raise ValueError('The Compose folder is not accessible from this shell; supply its actual local path. No files changed.')
            deploy(Path(label).resolve())
        else:
            parser.error('provide the existing workstation-api folder or --discover')
    except (ValueError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
