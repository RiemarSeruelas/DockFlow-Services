#!/usr/bin/env python3
import hashlib
from pathlib import Path
root=Path(__file__).resolve().parent
for entry in (root/'SHA256SUMS').read_text().splitlines():
    expected,relative=entry.split('  ',1)
    path=root/relative
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):raise SystemExit('Package file missing or unsafe: '+relative)
    if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:raise SystemExit('Package checksum mismatch: '+relative)
print('Release package checksums verified.')
