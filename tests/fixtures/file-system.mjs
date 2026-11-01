// An in-memory File System Access fixture. Writable contents become visible
// only after close(), and injected failures can distinguish pre/post commit.
export function namedError(name) { return Object.assign(new Error(name), { name }); }

export function mp4Bytes(size = 24) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  return bytes;
}

export function memoryDirectory(name = 'Reel Saver', options = {}) {
  const state = { calls: [], hook: options.hook, permission: options.permission || 'granted' };
  const emit = async (operation, path, extra = {}) => {
    const event = { operation, path, ...extra };
    state.calls.push(event);
    await state.hook?.(event);
  };
  function directory(label, path) {
    const contents = new Map();
    const find = name => [...contents.keys()].find(key => options.caseInsensitive === false ? key === name : key.toLowerCase() === name.toLowerCase());
    function file(filename, data = '') {
      let blob = new Blob([data]);
      const filePath = `${path}/${filename}`;
      return {
        kind: 'file', name: filename,
        async getFile() { await emit('read', filePath); return blob.slice(); },
        async createWritable() {
          await emit('writable', filePath);
          const chunks = [];
          let ended = false;
          return {
            async write(value) {
              if (ended) throw namedError('InvalidStateError');
              await emit('write', filePath);
              chunks.push(new Blob([value]));
            },
            async close() {
              if (ended) throw namedError('InvalidStateError');
              await emit('close', filePath);
              blob = new Blob(chunks);
              ended = true;
              await emit('committed', filePath);
            },
            async abort() { await emit('abort', filePath); ended = true; },
          };
        },
      };
    }
    const handle = {
      kind: 'directory', name: label, state,
      async queryPermission() { return state.permission; },
      async getFileHandle(name, { create = false } = {}) {
        await emit('file-handle', `${path}/${name}`, { create });
        const found = find(name);
        if (found) {
          const entry = contents.get(found);
          if (entry.kind !== 'file') throw namedError('TypeMismatchError');
          return entry;
        }
        if (!create) throw namedError('NotFoundError');
        const created = file(name);
        contents.set(name, created);
        await emit('file-created', `${path}/${name}`);
        return created;
      },
      async getDirectoryHandle(name, { create = false } = {}) {
        await emit('directory-handle', `${path}/${name}`, { create });
        const found = find(name);
        if (found) {
          const entry = contents.get(found);
          if (entry.kind !== 'directory') throw namedError('TypeMismatchError');
          return entry;
        }
        if (!create) throw namedError('NotFoundError');
        const created = directory(name, `${path}/${name}`);
        contents.set(name, created);
        await emit('directory-created', `${path}/${name}`);
        return created;
      },
      async *entries() { await emit('enumerate', path); yield* contents.entries(); },
      async *values() { await emit('enumerate', path); yield* contents.values(); },
      async removeEntry(name) {
        await emit('remove', `${path}/${name}`);
        const found = find(name);
        if (!found) throw namedError('NotFoundError');
        const entry = contents.get(found);
        if (entry.kind === 'directory' && entry.names.length) throw namedError('InvalidModificationError');
        contents.delete(found);
      },
      putFile(name, data) { const value = file(name, data); contents.set(name, value); return value; },
      putJson(name, value) { return handle.putFile(name, JSON.stringify(value)); },
      putDirectory(name) { const value = directory(name, `${path}/${name}`); contents.set(name, value); return value; },
      renameEntry(oldName, newName) { const entry = contents.get(oldName); contents.delete(oldName); entry.name = newName; contents.set(newName, entry); },
      lookup(name) { return contents.get(find(name)); },
      get names() { return [...contents.keys()]; },
      get videoNames() { return [...contents.keys()].filter(name => /\.mp4$/i.test(name)); },
      async json(name) { return JSON.parse(await (await handle.getFileHandle(name)).getFile().then(file => file.text())); },
      async bytes(name) { return new Uint8Array(await (await (await handle.getFileHandle(name)).getFile()).arrayBuffer()); },
    };
    return handle;
  }
  return directory(name, name);
}
