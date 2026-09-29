import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import { AppLoader } from "@/ui/brand";
import { Bubble } from "@/ui/bubble";
import "@/index.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root container");

// Cold screens (local setup, settings, reset, computer/browser/app hosts) load
// as separate chunks. A whole-window screen keeps the same loader the app shows
// while its runtime starts; in-shell panels use their own local boundaries.
// The floating bubble is its own small window: it renders only the coworker's face and speech.
const bubble = new URLSearchParams(window.location.search).has("bubble");
if (bubble) document.documentElement.dataset.bubble = "true";

createRoot(container).render(
  <StrictMode>
    {bubble ? <Bubble /> : (
      <Suspense fallback={<AppLoader />}>
        <App />
      </Suspense>
    )}
  </StrictMode>,
);
