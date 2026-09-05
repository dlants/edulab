import { routeFor, routes } from "./routes.ts";
import { samples, selectedSample, selectSample } from "./samples/index.ts";
import { cls, mountStyle } from "./vamp.ts";

const navClass = cls("nav");
const pageClass = cls("page");

mountStyle(`
html, body { height: 100%; }
body { margin: 0; }
#app { height: 100%; }
.${pageClass} {
  height: 100%;
  min-height: 0;
}
.${navClass} {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 20;
  font-family: system-ui, sans-serif;
  font-size: 0.875rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
}
.${navClass} a { color: inherit; }
.${navClass} a[aria-current="page"] { font-weight: 600; }
.${navClass} select { font: inherit; }
`);

const active = routeFor(window.location.pathname);

const nav = document.createElement("nav");
nav.className = navClass;
for (const route of routes) {
  const link = document.createElement("a");
  link.href = route.path + window.location.search;
  link.textContent = route.label;
  if (route === active) link.setAttribute("aria-current", "page");
  nav.append(link);
}

const picker = document.createElement("select");
const own = document.createElement("option");
own.value = "";
own.textContent = "Write your own";
picker.append(own);
for (const sample of samples) {
  const option = document.createElement("option");
  option.value = sample.id;
  option.textContent = sample.label;
  picker.append(option);
}
picker.value = selectedSample()?.id ?? "";
picker.addEventListener("change", () => {
  selectSample(picker.value === "" ? undefined : picker.value);
});
nav.append(picker);

const page = document.createElement("div");
page.className = pageClass;

const root = document.getElementById("app") ?? document.body;
root.append(nav, page);

active.mount(page);
