import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PermissionService } from '../../../services/permission.service';
import {
  LegacyPermissionModel,
  LegacyScreenMode,
  LegacyToolbarAction,
  LegacyToolbarActionId,
  LegacyToolbarContext,
} from '../contracts/legacy-contracts';
import { LEGACY_TOOLBAR_ACTION_MANIFEST } from '../manifests/legacy-action-manifest';
import { hasLegacyPermission } from '../behaviors/permission-gate';

interface RenderedAction extends LegacyToolbarAction {
  disabled: boolean;
  title: string;
}

@Component({
  selector: 'app-legacy-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './legacy-toolbar.component.html',
  styleUrl: './legacy-toolbar.component.scss',
})
export class LegacyToolbarComponent {
  private permSvc = inject(PermissionService);

  readonly screen = input<string>('');
  readonly mode = input<LegacyScreenMode>('browse');
  readonly hasCurrent = input<boolean>(false);
  readonly posted = input<boolean>(false);
  readonly saving = input<boolean>(false);
  readonly title = input<string | null>(null);
  readonly icon = input<string | null>(null);
  readonly countBadge = input<string | null>(null);
  readonly actions = input<LegacyToolbarActionId[]>([
    'new',
    'save',
    'edit',
    'delete',
    'search',
    'print',
    'exit',
  ]);
  readonly permissionModel = input<LegacyPermissionModel | null>(null);
  readonly enabledRules = input<Partial<Record<LegacyToolbarActionId, boolean>> | null>(null);
  readonly showLabels = input<boolean>(false);

  readonly action = output<LegacyToolbarActionId>();

  private readonly screenPermissions = computed<LegacyPermissionModel>(() => {
    const manual = this.permissionModel();
    if (manual) return manual;
    const code = this.screen();
    if (!code) return {};
    return (this.permSvc.forScreen(code)() ?? {}) as unknown as LegacyPermissionModel;
  });

  private readonly ctx = computed<LegacyToolbarContext>(() => ({
    mode: this.mode(),
    hasCurrent: this.hasCurrent(),
    posted: this.posted(),
    saving: this.saving(),
    permissions: this.screenPermissions(),
  }));

  readonly items = computed<RenderedAction[]>(() => {
    const ctx = this.ctx();
    const overrides = this.enabledRules() ?? {};

    return this.actions()
      .map((id) => {
        const action = LEGACY_TOOLBAR_ACTION_MANIFEST[id];
        if (!action) return null;

        const allowed = hasLegacyPermission(ctx.permissions, action.permissionKey);
        if (!allowed) return null;

        const ruleEnabled = action.enabledRule ? action.enabledRule(ctx) : true;
        const finalEnabled = overrides[id] ?? ruleEnabled;
        return {
          ...action,
          disabled: !finalEnabled,
          title: action.shortcut ? `${action.label} (${action.shortcut})` : action.label,
        };
      })
      .filter((item): item is RenderedAction => item !== null);
  });

  onClick(item: RenderedAction): void {
    if (item.disabled) return;
    this.action.emit(item.id);
  }
}
