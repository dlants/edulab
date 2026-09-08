/** The deployment is public and the API key is not, so every inference request
 * carries a password the backend checks. It is held in memory for the session
 * and in localStorage so a reload does not re-prompt. */
const KEY = "edulab:password";

let current = "";

export function password(): string {
  return current;
}

export function socketUrl(candidate = current): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ password: candidate });
  return `${proto}//${window.location.host}/api/socket?${query.toString()}`;
}

/** The only thing the password gates is the socket, so the check is opening
 * one: the backend closes it at the upgrade if the password is wrong. */
function check(candidate: string): Promise<boolean> {
  const socket = new WebSocket(socketUrl(candidate));
  return new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => {
      socket.close();
      resolve(true);
    });
    socket.addEventListener("close", () => {
      resolve(false);
    });
  });
}

/** Resolves once a password the backend accepts is in hand. A stored one is
 * tried first, so the form is only shown when there is nothing to go on. */
export async function unlock(container: HTMLElement): Promise<void> {
  const stored = window.localStorage.getItem(KEY);
  if (stored !== null && (await check(stored))) {
    current = stored;
    return;
  }
  window.localStorage.removeItem(KEY);
  return new Promise<void>((resolve) => {
    const form = document.createElement("form");
    form.style.cssText =
      "display:flex;gap:8px;align-items:center;justify-content:center;height:100%;font:14px system-ui";
    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = "password";
    input.autofocus = true;
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Enter";
    const error = document.createElement("span");
    error.style.color = "#c00";
    form.append(input, button, error);
    container.append(form);
    input.focus();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      error.textContent = "";
      button.disabled = true;
      void check(input.value).then((ok) => {
        button.disabled = false;
        if (!ok) {
          error.textContent = "nope";
          return;
        }
        current = input.value;
        window.localStorage.setItem(KEY, current);
        form.remove();
        resolve();
      });
    });
  });
}
