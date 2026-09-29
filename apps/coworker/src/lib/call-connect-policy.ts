/** Add only the call endpoint to the renderer's existing configured service origins. */
export function callConnectPolicy(serviceUrls: string[]): string {
  const origins = new Set<string>();
  for (const value of serviceUrls) {
    try { const url = new URL(value); if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin); } catch { /* Unconfigured services do not get an origin. */ }
  }
  return `connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* ${[...origins].join(" ")} https://api.openai.com/v1/realtime/calls`;
}
