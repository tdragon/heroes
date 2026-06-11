export interface Screen {
  readonly root: HTMLElement;
  onShow?: () => void;
  onHide?: () => void;
}

export class ScreenRouter {
  private readonly screens = new Map<string, Screen>();
  private active: Screen | null = null;

  constructor(private readonly container: HTMLElement) {}

  register(name: string, screen: Screen): void {
    if (this.screens.has(name)) {
      throw new Error(`screen '${name}' is already registered`);
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
