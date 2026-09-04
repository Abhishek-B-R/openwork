import type { AvatarColor, AvatarGlasses } from "../components/coworker-brand";

export type StockCoworkerId = "scout" | "editor" | "ops";
export type CoworkerId = StockCoworkerId | "custom";
export type DemoView = "chat" | "documents" | "assignments" | "connections" | "group" | "create";

/** Fictional, deterministic examples of the app's conversations, documents,
 * assignments, and OpenWork Connect. No providers or customer data are used. */
export const TEAM: Array<{ id: StockCoworkerId; name: string; role: string; color: AvatarColor; glasses: AvatarGlasses }> = [
  { id: "scout", name: "Scout", role: "Research", color: "blue", glasses: "round" },
  { id: "editor", name: "Editor", role: "Writing", color: "rose", glasses: "square" },
  { id: "ops", name: "Ops", role: "Operations", color: "mint", glasses: "none" },
];

type Example = {
  question: string;
  answer: string;
  followUp: string;
  reply: string;
  document: { title: string; eyebrow: string; intro: string; points: string[]; next: string };
  assignment: { title: string; description: string; result: string };
  routine: string;
};

export const EXAMPLES: Record<StockCoworkerId, Example> = {
  scout: {
    question: "How’s the launch brief coming along?",
    answer: "First draft’s ready. I pulled the key points into a short brief. Take a look when you have a moment.",
    followUp: "What should we focus on first?",
    reply: "Start with one useful moment: someone checking in on a draft and finding it ready to review. We can build the launch story around that.",
    document: {
      title: "Launch brief", eyebrow: "Research · Draft for review",
      intro: "Make the first minute feel useful. Show a coworker helping with something familiar, then let people try it themselves.",
      points: ["Lead with a real task, such as a first draft or a short research brief.", "Let visitors explore the conversation and open the work it produced.", "Make the next step clear: choose a coworker and give it a starting point."],
      next: "Choose one example for launch day and ask a few early users to try it.",
    },
    assignment: { title: "Compare three launch examples", description: "Recommend the clearest example for a first-time visitor.", result: "The draft-review example is the easiest to understand. It shows a request, a useful result, and a natural next step." },
    routine: "Weekly research roundup",
  },
  editor: {
    question: "Could you help with the announcement?",
    answer: "I’ve put together a short first draft. It keeps the focus on the people doing the work, with a simple invitation to try it.",
    followUp: "Make the opening a little warmer.",
    reply: "How about: ‘Good work starts with a little company. Meet your new coworkers.’ I’ve added that as an alternative opening in the draft.",
    document: {
      title: "Announcement draft", eyebrow: "Writing · Draft for review",
      intro: "Your work. Better together. Meet your AI coworkers: a little help with the research, the first draft, and whatever comes next.",
      points: ["Give a coworker a role and something to work on.", "Drop into the conversation when you want to shape the next step.", "Review the result and make it your own."],
      next: "Meet your next coworker. Start with one task you would love a little help with.",
    },
    assignment: { title: "Write three announcement openings", description: "Keep them short, warm, and easy to understand.", result: "Three directions: ‘Your work. Better together.’, ‘A little company for your next big idea.’, and ‘Meet the newest member of your team.’" },
    routine: "Monday editorial check-in",
  },
  ops: {
    question: "Where are we with the launch checklist?",
    answer: "The sample checklist is ready. I’ve separated what’s done from what needs a decision, so you can see the next step at a glance.",
    followUp: "What still needs a decision?",
    reply: "Two things: pick the launch example and confirm the first release date. I’ve kept both at the top of the checklist.",
    document: {
      title: "Launch checklist", eyebrow: "Operations · Working checklist",
      intro: "A small checklist to keep launch day moving. One owner for each task, and a clear place for decisions.",
      points: ["Ready: first announcement draft and product walkthrough.", "Needs a decision: the launch example and release date.", "Next: invite early users and collect feedback on their first task."],
      next: "Review the two open decisions together, then share the final checklist.",
    },
    assignment: { title: "Prepare the launch handoff", description: "Summarize the open decisions and the next three actions.", result: "Confirm the example, choose the release date, then invite early users. Keep the announcement and checklist in the same handoff." },
    routine: "Friday progress digest",
  },
};

export const DEMO_VIEWS: Array<{ id: DemoView; label: string }> = [
  { id: "chat", label: "Chat" }, { id: "documents", label: "Documents" },
  { id: "assignments", label: "Assignments" }, { id: "connections", label: "Connections" },
];
