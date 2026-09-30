import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installOpencodeV2Binary } from "../../../../apps/server/src/opencode-v2-binary.ts";
import artifacts from "../../../../apps/server/src/opencode-v2-artifacts.json" with { type: "json" };

const destination = process.argv[2];
if (!destination)
  throw new Error("Provide the destination for the native agent binary");
const cache = await mkdtemp(join(tmpdir(), "workbot-install-"));
try {
  // Reuse the desktop's pinned SHA-512-verified installer; never execute registry lifecycle scripts.
  await copyFile(
    await installOpencodeV2Binary(cache, artifacts.version),
    destination,
  );
} finally {
  await rm(cache, { recursive: true, force: true });
}
