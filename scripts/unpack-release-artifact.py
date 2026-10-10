import os, sys, stat, zipfile, pathlib, shutil
archive, destination = sys.argv[1:]
root = pathlib.Path(destination)
root.mkdir(parents=True, exist_ok=True)
if root.is_symlink() or any(root.iterdir()): raise ValueError('owned extraction directory must be empty')
with zipfile.ZipFile(archive) as z:
    entries = z.infolist()
    if len(entries)>20000: raise ValueError('ZIP entry budget')
    total = 0; seen = set(); files = set(); required_directories = set()
    for e in entries:
        raw = e.filename[:-1] if e.filename.endswith('/') else e.filename
        parts = raw.split('/')
        if not parts or any(not p for p in parts) or e.filename.startswith('/') or '\\' in e.filename or any(p in ('.','..') or ':' in p for p in parts): raise ValueError('unsafe ZIP path')
        if any(p.rstrip(' .')!=p or p.split('.')[0].upper() in ('CON','PRN','AUX','NUL',*(f'COM{i}' for i in range(1,10)),*(f'LPT{i}' for i in range(1,10))) for p in parts): raise ValueError('unsafe ZIP cross-platform path')
        key='/'.join(parts).casefold()
        if key in seen: raise ValueError('duplicate ZIP member')
        seen.add(key)
        ancestors = {'/'.join(parts[:i]).casefold() for i in range(1,len(parts))}
        if ancestors & files or (not e.is_dir() and key in required_directories) or (e.is_dir() and key in files): raise ValueError('ZIP file/directory collision')
        required_directories.update(ancestors)
        if not e.is_dir(): files.add(key)
        mode=e.external_attr>>16
        if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR)): raise ValueError('ZIP link/special member')
        total+=e.file_size
        if e.file_size>2*1024**3 or total>4*1024**3: raise ValueError('ZIP expansion budget')
        if e.file_size>1024*1024 and e.file_size>max(e.compress_size,1)*1000: raise ValueError('ZIP expansion ratio')
    for e in entries:
        target=root.joinpath(*pathlib.PurePosixPath(e.filename).parts)
        if e.is_dir(): target.mkdir(parents=True,exist_ok=True); continue
        target.parent.mkdir(parents=True,exist_ok=True)
        with z.open(e) as source, open(target,'xb') as output: shutil.copyfileobj(source,output,1024*1024)
        os.chmod(target,0o600)
