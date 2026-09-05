import { mount } from "./prototypes/chat.ts";
import { cls, mountStyle } from "./vamp.ts";

const pageClass = cls("page");

mountStyle(`
html, body { height: 100%; }
body { margin: 0; }
#app { height: 100%; }
.${pageClass} {
  height: 100%;
  min-height: 0;
}
`);

const page = document.createElement("div");
page.className = pageClass;
const root = document.getElementById("app") ?? document.body;
root.append(page);
mount(page);
