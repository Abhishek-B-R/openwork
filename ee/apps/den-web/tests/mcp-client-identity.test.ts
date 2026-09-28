import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { McpUnverifiedAppWarning } from "../app/mcp/client-identity";
import { describeMcpRedirect, fallbackClientName, isLoopbackHost } from "../app/mcp/client-identity-model";

describe("MCP consent client identity", () => {
  test("names the host the approval is sent to", () => {
    expect(describeMcpRedirect("https://claude.ai/api/mcp/auth_callback")).toEqual({ host: "claude.ai", url: "https://claude.ai/api/mcp/auth_callback", loopbackOnly: false });
  });

  test("flags loopback-only redirects, on any port", () => {
    expect(describeMcpRedirect("http://127.0.0.1:39421/callback")).toEqual({ host: "127.0.0.1:39421", url: "http://127.0.0.1:39421/callback", loopbackOnly: true });
    expect(describeMcpRedirect("http://localhost:3000/cb")?.loopbackOnly).toBe(true);
    expect(describeMcpRedirect("http://[::1]:8080/cb")?.loopbackOnly).toBe(true);
    expect(isLoopbackHost("127.9.9.9")).toBe(true);
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
  });

  test("names native app schemes and ignores garbage", () => {
    expect(describeMcpRedirect("cursor://anysphere.cursor-mcp/oauth/callback")).toEqual({ host: "cursor://", url: "cursor://anysphere.cursor-mcp/oauth/callback", loopbackOnly: false });
    expect(describeMcpRedirect("not a url")).toBeNull();
    expect(describeMcpRedirect(null)).toBeNull();
  });

  test("falls back to the metadata document host for unnamed CIMD clients", () => {
    expect(fallbackClientName("https://app.example.com/oauth/client.json")).toBe("app.example.com");
    expect(fallbackClientName("abc123")).toBe("An app without a name");
  });
});

describe("unverified application warning", () => {
  test.each([
    "https://assistant.example.com/oauth/callback",
    "http://127.0.0.1:39421/callback",
    "cursor://anysphere.cursor-mcp/oauth/callback",
  ])("always warns and shows the complete callback for %s", (url) => {
    const markup = renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { redirect: describeMcpRedirect(url) }));
    expect(markup).toContain("Unverified application");
    expect(markup).toContain("OpenWork has not verified who is requesting this access.");
    expect(markup).toContain("Only authorize if you started this connection and trust the app to act on your behalf with the permissions shown.");
    expect(markup).toContain("Check the return address supplied by this app:");
    expect(markup).toContain(url);
    expect(markup).toContain('dir="ltr"');
    expect(markup).toContain("break-all");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("<details");
  });

  test.each([null, "not a url"])("keeps the warning and gives a safe next step when the address is %s", (url) => {
    const markup = renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { redirect: describeMcpRedirect(url) }));
    expect(markup).toContain("Unverified application");
    expect(markup).toContain("Return address unavailable. Cancel and restart the connection from the app you intended to use.");
    expect(markup).not.toContain('data-testid="mcp-redirect-url"');
  });

  test("renders attacker-controlled callback content as inert text", () => {
    const url = "https://assistant.example.com/callback?label=<img src=x onerror=alert(1)>&next=review";
    const markup = renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { redirect: describeMcpRedirect(url) }));
    expect(markup).toContain("%3Cimg%20src=x%20onerror=alert(1)%3E&amp;next=review");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("href=");
  });

  test("keeps the actual host visible when the URL contains misleading user info", () => {
    const redirect = describeMcpRedirect("https://trusted.example@untrusted.example/oauth/callback");
    expect(redirect?.host).toBe("untrusted.example");
    const markup = renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { redirect }));
    expect(markup).toContain("https://trusted.example@untrusted.example/oauth/callback");
  });
});
