// Review, in three roles, picked by props:
// - a launcher (mod.open, cmd-shift-g; an overlay without props.agent): opens or shows the focused terminal's review
//   tab, then closes;
// - a review tab (props.agent: the terminal it belongs to): every changed file's diff, comments to that agent (tab.js);
// - the right sidebar: the changed files, mode switch and commit (list.js).
// Shared state and the terminal a review is about: state.js. Git reads and diff helpers: git.js. Refresh: repo.js.
import { View, div } from "gpui-kit";
import { props, closeOverlay, nextCommand } from "herdr";
import { tied, openTab } from "./state.js";
import { ReviewTab } from "./tab.js";
import { ReviewList } from "./list.js";

export default class Review extends View {
  init(_props, cx) {
    if (props()?.overlay && !tied()) {
      this.launcher = true;
      cx.spawn(async () => { openTab(); closeOverlay(props().overlay); });
      return;
    }
    this.view = tied() ? new ReviewTab(cx) : new ReviewList(cx);
    // keys.json "mod:review": review.comment / send / viewed / only (the tab); "focus" from pane.go.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = (await nextCommand()).split(/[.:]/).pop();
        this.view.command(command, cx);
        cx.notify();
      }
    });
  }

  render(cx) { return this.launcher ? div() : this.view.render(cx); }
}
