import { routeFor, routes } from "./routes.ts";
import { cls, mountStyle } from "./vamp.ts";

const navClass = cls("nav");

mountStyle(`
.${navClass} {
  font-family: system-ui, sans-serif;
  font-size: 0.875rem;
  display: flex;
  justify-content: center;
  gap: 1.5rem;
  padding: 1rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
  margin-bottom: 1.5rem;
}
.${navClass} a { color: inherit; }
.${navClass} a[aria-current="page"] { font-weight: 600; }
`);

const active = routeFor(window.location.pathname);

const nav = document.createElement("nav");
nav.className = navClass;
for (const route of routes) {
  const link = document.createElement("a");
  link.href = route.path;
  link.textContent = route.label;
  if (route === active) link.setAttribute("aria-current", "page");
  nav.append(link);
}

const page = document.createElement("div");

const root = document.getElementById("app") ?? document.body;
root.append(nav, page);

active.mount(page);
