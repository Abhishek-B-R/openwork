import type { AvatarExpression } from "@openwork/ui/coworker";
import type { CoworkerActivity } from "@/lib/threads";

/** Desktop and landing share artwork, pointer arbitration, and motion lifecycle. */
export { CoworkerAvatar, AvatarControls, GroupAvatars, acknowledgeCoworker, avatarFill, expressCoworker } from "@openwork/ui/coworker";
export type { AvatarExpression } from "@openwork/ui/coworker";

/** The face a coworker holds while a state lasts: thinking while it works, curious while it waits on you. */
export function faceFor(activity: Pick<CoworkerActivity, "state"> | null | undefined): AvatarExpression {
  if (activity?.state === "working" || activity?.state === "retrying") return "thinking";
  if (activity?.state === "attention") return "curious";
  return "none";
}
