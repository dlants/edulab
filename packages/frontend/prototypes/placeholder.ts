/** Stands in for a prototype we have not built yet, so the route exists and the
 * tab is clickable while the idea is still on paper. */
export function placeholder(description: string) {
  return (container: HTMLElement): void => {
    container.textContent = description;
    container.style.opacity = "0.6";
    container.style.padding = "1rem";
    container.style.fontFamily = "system-ui, sans-serif";
  };
}
