import { mount as mountChat } from "./prototypes/chat.ts";
import { placeholder } from "./prototypes/placeholder.ts";

export type Route = {
  path: string;
  label: string;
  mount: (container: HTMLElement) => void;
};

/** One entry per prototype in notes/prototype.md. Navigation is a full page
 * load, which is free here because all state is ephemeral anyway. */
export const routes: Route[] = [
  { path: "/", label: "1. User-driven review", mount: mountChat },
  {
    path: "/suggested",
    label: "2. Suggested review",
    mount: placeholder("The agent picks the areas worth reviewing."),
  },
  {
    path: "/map",
    label: "3. Domain map",
    mount: placeholder("A visualization of the key moments in the task."),
  },
  {
    path: "/interactive",
    label: "4. Interactives",
    mount: placeholder("A generated interactive to test the user's thinking."),
  },
];

export function routeFor(pathname: string): Route {
  return routes.find((r) => r.path === pathname) ?? routes[0];
}
