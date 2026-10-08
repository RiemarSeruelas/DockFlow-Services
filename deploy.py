#!/usr/bin/env python3
"""Upgrade the existing company API services; preserve worker, Compose, .env and data."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys
from apply_update import apply, plan, restore

PACKAGE=Path(__file__).resolve().parent
SERVICES=['dockflow-db','power-tool-db']
HEALTH={
'dockflow-db':"""
const response=await fetch('http://127.0.0.1:8081/api/dockflow/health',{signal:AbortSignal.timeout(20000)});
const health=await response.json();
if(!response.ok||!health.ok||['DRESSINGS','SAVOURY'].some(area=>health.areas?.[area]?.worksheetVersion!=='13.2'))throw new Error('Receiving Records 13.2 health check failed');
console.log('DRESSINGS and SAVOURY worksheet 13.2 verified.');
""",
'power-tool-db':"""
const response=await fetch('http://127.0.0.1:8082/api/power-tool/health',{signal:AbortSignal.timeout(20000)});
const health=await response.json();
if(!response.ok||!health.ok||health.approvalSafetyVersion!=='13.2')throw new Error('Power Tool transactional approval 13.2 health check failed');
console.log('Power Tool approval service 13.2 verified.');
"""}
SNAPSHOTS={
'dockflow-db':"""
console.log=console.info=console.warn=()=>{};
const {createSapRepository}=await import('./server/dockflow/sap-postgres.js');
const snapshot={};for(const area of ['DRESSINGS','SAVOURY']){const repository=createSapRepository(area);snapshot[area]={source:await repository.describe(),rows:await repository.all()};}
await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(snapshot),error=>error?reject(error):resolve()));process.exit(0);
""",
'power-tool-db':"""
console.log=console.info=console.warn=()=>{};
const store=await import('./server/power-tool/dataStore.js');
await store.initializeDataStore();await store.reconnectPostgres();const state=await store.readDb();
if(!Array.isArray(state.items)||!Array.isArray(state.requests))throw new Error('Incomplete Power Tool snapshot');
await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(state),error=>error?reject(error):resolve()));process.exit(0);
"""}

def docker(root,*args,capture=False,timeout=None):
    return subprocess.run(['docker',*args],cwd=root,check=True,text=True,capture_output=capture,timeout=timeout)

def value(root,cid,template):
    return docker(root,'inspect','--format',template,cid,capture=True).stdout.strip()

def ids(root,service,project=None):
    args=['ps','-q','--filter','label=com.docker.compose.service='+service]
    if project:args+=['--filter','label=com.docker.compose.project='+project]
    return docker(root,*args,capture=True).stdout.split()

def rollback(backup,source_only=False):
    restore(backup)
    if source_only:print('Previous workstation source restored; running containers unchanged.');return
    info=json.loads((backup/'deployment.json').read_text());root=Path(info['root'])
    docker(root,'compose','--project-name',info['project'],'-f',info['compose'],'-f',str(backup/'images.json'),'up','-d','--no-deps','--no-build','--wait','--wait-timeout','180',*SERVICES)
    print('Previous company API source and both service images restored. Database records were retained.')

def deploy(root):
    if not shutil.which('docker'):raise ValueError('Docker is required; no files changed.')
    subprocess.run([sys.executable,str(PACKAGE/'verify_package.py')],check=True)
    compose=next((p for p in [root/'compose.yaml',root/'docker-compose.yml'] if p.is_file()),None)
    if not compose or not (root/'.env').is_file():raise ValueError('Use the existing workstation-api folder with Compose and .env; no files changed.')
    writes=plan(root)
    docker(root,'compose','version',capture=True)
    matches=[cid for cid in ids(root,'dockflow-db') if Path(value(root,cid,'{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')).resolve()==root]
    if len(matches)!=1:raise ValueError('Expected one running dockflow-db for this folder; no files changed.')
    project=value(root,matches[0],'{{ index .Config.Labels "com.docker.compose.project" }}')
    current={}
    for service in SERVICES:
        candidates=ids(root,service,project)
        if len(candidates)!=1:raise ValueError('Expected one running '+service+'; no files changed.')
        cid=candidates[0]
        if Path(value(root,cid,'{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')).resolve()!=root:raise ValueError('Both services must belong to the existing workstation folder; no files changed.')
        files=value(root,cid,'{{ index .Config.Labels "com.docker.compose.project.config_files" }}')
        if files and [Path(p).resolve() for p in files.split(',')]!=[compose.resolve()]:raise ValueError('Custom Compose overrides require review; no files changed.')
        current[service]=cid
    prefix=['compose','--project-name',project,'-f',str(compose)]
    docker(root,*prefix,'config','--quiet')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup=root/'.maintenance-backups'/('dockflow-13.2-'+stamp);backup.mkdir(parents=True,mode=0o700)
    images={}
    for service,cid in current.items():
        image='dockflow-release-backup/workstation-'+service+':'+stamp
        docker(root,'image','tag',value(root,cid,'{{.Image}}'),image);images[service]={'image':image}
    (backup/'deployment.json').write_text(json.dumps({'root':str(root),'compose':str(compose),'project':project},indent=2))
    (backup/'images.json').write_text(json.dumps({'services':images},indent=2))
    for name in ['apply_update.py','deploy.py']:shutil.copy2(PACKAGE/name,backup/name)
    shutil.copy2(root/'.env',backup/'environment.env');shutil.copy2(compose,backup/compose.name)
    print('Backing up existing source, images, Receiving Records and Power Tool state.',flush=True)
    for service,cid in current.items():
        snapshot=backup/(service+'-state.json');diagnostics=backup/(service+'-backup-diagnostics.txt')
        with snapshot.open('w',encoding='utf-8') as output,diagnostics.open('w',encoding='utf-8') as errors:
            result=subprocess.run(['docker','exec',cid,'node','--input-type=module','-e',SNAPSHOTS[service]],cwd=root,stdout=output,stderr=errors,timeout=180)
        if result.returncode:raise ValueError('Data backup failed for '+service+'. No source or containers changed. Private diagnostics: '+str(backup))
        saved=json.loads(snapshot.read_text(encoding='utf-8'))
        if service=='dockflow-db' and any(not isinstance(saved.get(area,{}).get('rows'),list) for area in ['DRESSINGS','SAVOURY']):raise ValueError('Receiving Records snapshot is incomplete; no files changed.')
        if service=='power-tool-db' and any(not isinstance(saved.get(key),list) for key in ['items','requests','staffAccounts','categories']):raise ValueError('Power Tool snapshot is incomplete; no files changed.')
    apply(root,writes,backup)
    try:
        for service in SERVICES:
            print('Building '+service+'. Existing services remain running.',flush=True)
            docker(root,*prefix,'build',service)
    except subprocess.CalledProcessError:
        rollback(backup,source_only=True);raise ValueError('Build failed; no running containers replaced.')
    try:
        docker(root,*prefix,'up','-d','--no-deps','--wait','--wait-timeout','180',*SERVICES)
        for service in SERVICES:
            candidates=ids(root,service,project)
            if len(candidates)!=1:raise ValueError('Updated '+service+' not found.')
            docker(root,'exec',candidates[0],'node','--input-type=module','-e',HEALTH[service],timeout=30)
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError):
        print('Workstation verification failed; restoring previous source and images.',flush=True)
        rollback(backup);raise ValueError('Deployment failed verification; previous company services restored.')
    print('Workstation 13.2 is ready. Worker remains running; Compose, .env and databases are preserved.')
    launcher='py -3' if sys.platform=='win32' else 'python3'
    print(f'Rollback: {launcher} "{backup/"deploy.py"}" --rollback "{backup}"')

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('workstation_root',type=Path,nargs='?')
    parser.add_argument('--discover',action='store_true')
    parser.add_argument('--rollback',type=Path)
    args=parser.parse_args()
    try:
        if args.rollback:rollback(args.rollback.resolve())
        elif args.workstation_root:deploy(args.workstation_root.resolve())
        elif args.discover:
            containers=ids(Path.cwd(),'dockflow-db')
            if len(containers)!=1:raise ValueError('Expected one running dockflow-db. Supply the existing workstation-api folder explicitly; no files changed.')
            directory=value(Path.cwd(),containers[0],'{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')
            if not directory or not Path(directory).is_dir():raise ValueError('The Compose folder is not accessible from this shell. Supply its actual local path; no files changed.')
            deploy(Path(directory).resolve())
        else:parser.error('provide the existing workstation-api folder or --discover')
    except (ValueError,OSError,subprocess.SubprocessError) as error:
        print(str(error),file=sys.stderr);sys.exit(1)
