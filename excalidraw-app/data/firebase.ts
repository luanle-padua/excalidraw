// DEPRECATED compatibility shim.
//
// Persistence moved off Firebase to the Cloudflare-backed storage layer
// (`data/storage.ts`: R2 blobs + D1 metadata via the `worker/` Worker).
// This file only re-exports those functions under their legacy names so
// existing imports of "./firebase" — and the collab test that mocks this
// module path — keep resolving unchanged.
//
// Cleanup (safe, mechanical, do when convenient): repoint the imports in
// collab/Collab.tsx, App.tsx, data/index.ts and tests/collab.test.tsx to
// "./storage" with the *toStorage names, then delete this file.

export {
  saveToStorage as saveToFirebase,
  loadFromStorage as loadFromFirebase,
  isSavedToStorage as isSavedToFirebase,
  saveFilesToStorage as saveFilesToFirebase,
  loadFilesFromStorage as loadFilesFromFirebase,
  saveChatToStorage as saveChatToFirebase,
  loadChatFromStorage as loadChatFromFirebase,
  saveLibraryToStorage as saveLibraryToFirebase,
  loadLibraryFromStorage as loadLibraryFromFirebase,
} from "./storage";
