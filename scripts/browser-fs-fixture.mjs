// Exercise the browser's actual File System Access implementation. A fresh
// browser profile isolates these OPFS roots from the user's chosen folders.
export function opfsFixture(stateExpression, folderName) {
  return `(() => {
    const state = ${stateExpression};
    state.rootReady = navigator.storage.getDirectory().then(root => root.getDirectoryHandle(${JSON.stringify(folderName)}, {create:true}));
    window.showDirectoryPicker = () => { state.pickerCalls++; return state.rootReady; };
    const locate = async relative => {
      const parts=relative.split('/');let directory=await state.rootReady;
      for(const name of parts.slice(0,-1)) directory=await directory.getDirectoryHandle(name);
      return {directory,name:parts.at(-1)};
    };
    state.listFiles = async () => {
      const files=[];
      async function walk(directory,prefix='') {
        for await(const [name,handle] of directory.entries()) {
          const relative=prefix+name;
          if(handle.kind==='directory') await walk(handle,relative+'/');
          else {const file=await handle.getFile();files.push({path:relative,size:file.size});}
        }
      }
      await walk(await state.rootReady);return files.sort((a,b)=>a.path.localeCompare(b.path));
    };
    state.readJson = async relative => {const {directory,name}=await locate(relative);return JSON.parse(await (await (await directory.getFileHandle(name)).getFile()).text());};
    state.removeFile = async relative => {const {directory,name}=await locate(relative);await directory.removeEntry(name);};
  })();`;
}

// Cache APIs and sessions are frozen in production. Replace the global API
// with a new wrapper rather than attempting to mutate a frozen method.
export function cacheFailureFixture(stateExpression) {
  return `(() => {
    const state=${stateExpression},api=globalThis.ReelSaverProfileCache;
    Object.defineProperty(globalThis,'ReelSaverProfileCache',{configurable:true,value:Object.freeze({...api,
      async openLibrary(...arguments_) {
        state.cacheOpens=(state.cacheOpens||0)+1;
        if(state.failCacheOpen)throw Object.assign(new Error('Fixture cache open failed'),{code:'CACHE_READ_FAILED',stage:'cache'});
        const session=await api.openLibrary(...arguments_);
        return Object.freeze({...session,get recordedCount(){return session.recordedCount;},
          async commitSaved(...values) {
            state.cacheCommits=(state.cacheCommits||0)+1;
            if(state.failCacheCommit)throw Object.assign(new Error('Fixture cache commit failed'),{code:'CACHE_WRITE_FAILED',stage:'cache'});
            return session.commitSaved(...values);
          }
        });
      }
    })});
  })();`;
}
