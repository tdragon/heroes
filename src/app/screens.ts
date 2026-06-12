export interface Screen {
  readonly root: HTMLElement;
  onShow?: () => void;
  onHide?: () => void;
  // releases window-level listeners etc.; called when the screen instance is
  // discarded (replaced by a new registration), never before another onShow
  destroy?: () => void;
}

export class ScreenRouter {
  private readonly screens = new Map<string, Screen>();
  private active: Screen | null = null;

  constructor(private readonly container: HTMLElement) {}

  // re-registering a name replaces the previous screen (a new game replaces
  // the old adventure screen); the active screen is hidden first if replaced
  register(name: string, screen: Screen): void {
    const previous = this.screens.get(name);
    if (previous) {
      if (previous === this.active) {
        previous.onHide?.();
        previous.root.remove();
        this.active = null;
      }
      previous.destroy?.();
    }
    this.screens.set(name, screen);
  }

  show(name: string): void {
    const screen = this.screens.get(name);
    if (!screen) {
      throw new Error(`unknown screen: ${name}`);
    }
    if (this.active === screen) return;
    if (this.active) {
      this.active.onHide?.();
      this.active.root.remove();
    }
    this.container.appendChild(screen.root);
    this.active = screen;
    screen.onShow?.();
  }
}
