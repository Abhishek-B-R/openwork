import { HeadlessService } from "@openwork-ee/headless-execution";
import { denHeadlessAuthority } from "./authority.js";
import { DenHeadlessRepository } from "./repository.js";
let service: HeadlessService | undefined;
export function headlessService() {
  return (service ??= new HeadlessService(
    new DenHeadlessRepository(),
    denHeadlessAuthority,
  ));
}
