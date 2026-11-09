// The pages of this hatchling's UI: software built for the person using it. Each page lives in its own
// folder, `src/ui/pages/<id>/`, with its pure logic in a tested module (like `view.ts` and `state.ts`) and a
// thin `render(root)` that draws into the DOM. Register it in `PAGES`; it then shows under "Your pages" on the
// Ask screen and opens at `#/<id>`.

export interface Page {
  /** The URL slug: lowercase kebab-case. */
  id: string;
  /** Shown in the "Your pages" list and as the tab title. */
  title: string;
  /** Draws the page into `root`. May return a cleanup function, called when the page is left. */
  render(root: HTMLElement): undefined | (() => void);
}

export const PAGE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isPageId(id: string): boolean {
  return PAGE_ID.test(id);
}

export const PAGES: Page[] = [];
