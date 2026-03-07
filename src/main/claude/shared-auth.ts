import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';

let sharedAuthStorage: AuthStorage | null = null;

export function getSharedAuthStorage(): AuthStorage {
  if (!sharedAuthStorage) {
    sharedAuthStorage = AuthStorage.create();
  }
  return sharedAuthStorage;
}

export { AuthStorage, ModelRegistry };
