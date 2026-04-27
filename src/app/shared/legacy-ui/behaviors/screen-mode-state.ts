import { LegacyScreenMode } from '../contracts/legacy-contracts';

export class ScreenModeState {
  private current: LegacyScreenMode = 'browse';

  get mode(): LegacyScreenMode {
    return this.current;
  }

  get isBrowse(): boolean {
    return this.current === 'browse';
  }

  get isEditable(): boolean {
    return this.current === 'new' || this.current === 'edit';
  }

  setMode(next: LegacyScreenMode): void {
    this.current = next;
  }
}

export function isEditableMode(mode: LegacyScreenMode): boolean {
  return mode === 'new' || mode === 'edit';
}
