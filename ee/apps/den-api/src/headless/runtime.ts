import { join } from "node:path"
import { HeadlessService, HeadlessStore } from "@openwork-ee/headless-execution"
import { denHeadlessAuthority } from "./authority.js"
let service:HeadlessService | undefined
export function headlessService() {
  return service ??= new HeadlessService(new HeadlessStore(process.env.DEN_HEADLESS_DATA_DIR ?? join(process.cwd(),".headless-data")),denHeadlessAuthority)
}
