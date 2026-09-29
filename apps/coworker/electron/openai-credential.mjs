import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function writePrivateJson(file, value) {
  await writePrivateFile(file, JSON.stringify(value));
}
async function writePrivateFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, file); await chmod(file, 0o600); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
const messages = {
  storage: "Secure storage is unavailable. Enable your system password store and try again.",
  missing: "Add an OpenAI key in Settings › OpenAI to use this capability.",
  key: "Your OpenAI key was not accepted. Replace it in Settings › OpenAI.",
  changed: "The OpenAI connection changed. Try again.",
};

/** One encrypted Call-mode credential, usable only by main-process consumers. */
export function createOpenAICredential({ directory, safeStorage, requestKey, platform = process.platform }) {
  // Retain the Call candidate's file in place; no duplicate or plaintext migration.
  const file = path.join(directory, "voice-call-key.bin");
  const listeners = new Set();
  let revision = 0;
  let editing = false;
  let writes = Promise.resolve();
  const invalidate = () => { revision++; for (const listener of listeners) listener(); };
  const serial = (work) => { const result = writes.catch(() => {}).then(work); writes = result.then(() => undefined, () => undefined); return result; };
  async function secure() {
    if (!await safeStorage.isAsyncEncryptionAvailable() || (platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) throw new Error(messages.storage);
  }
  async function settings() {
    await writes;
    try { return { keySet: (await readFile(file)).length > 0 }; }
    catch (error) { if (error.code === "ENOENT") return { keySet: false }; throw new Error(messages.storage); }
  }
  return {
    settings,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async withKey(consume, signal) {
      const version = revision;
      const check = () => { signal?.throwIfAborted(); if (version !== revision) throw new Error(messages.changed); };
      await writes; check(); await secure(); check();
      let sealed;
      try { sealed = await readFile(file); } catch { throw new Error(messages.missing); }
      let decrypted;
      try { decrypted = await safeStorage.decryptStringAsync(sealed); } catch { throw new Error(messages.storage); }
      check();
      if (decrypted.shouldReEncrypt) {
        await serial(async () => { check(); const next = await safeStorage.encryptStringAsync(decrypted.result); check(); await writePrivateFile(file, next); });
        check();
      }
      try { const result = await consume(decrypted.result); check(); return result; }
      finally { decrypted = undefined; }
    },
    async editKey() {
      if (editing) return settings();
      editing = true;
      const version = revision;
      try {
        await secure();
        let key = await requestKey();
        if (key !== null) {
          if (!/^sk-[A-Za-z0-9_-]{16,512}$/.test(key)) throw new Error(messages.key);
          await serial(async () => {
            if (version !== revision) throw new Error(messages.changed);
            const sealed = await safeStorage.encryptStringAsync(key);
            if (version !== revision) throw new Error(messages.changed);
            invalidate();
            await writePrivateFile(file, sealed);
          });
        }
        key = undefined;
        return settings();
      } catch (error) {
        throw new Error(Object.values(messages).includes(error?.message) ? error.message : messages.storage);
      } finally { editing = false; }
    },
    async remove() { invalidate(); await serial(() => rm(file, { force: true })); return settings(); },
  };
}
