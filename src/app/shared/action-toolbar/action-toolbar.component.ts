import {
  Component, ChangeDetectionStrategy, inject, input, output, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PermissionService } from '../../services/permission.service';

/**
 * Canonical action kinds used across legacy Oracle Forms screens.
 * Keep this list synced with the legacy toolbar vocabulary.
 */
export type ToolbarAction =
  | 'new'       // CREATE_RECORD
  | 'edit'      // enter update mode on current row
  | 'cancel'    // discard unsaved changes
  | 'save'      // commit
  | 'delete'    // DELETE_RECORD
  | 'post'      // TRSND (ترحيل)
  | 'unpost'    // DELETE TRSND (إلغاء ترحيل)
  | 'refresh'   // re-query
  | 'print'     // KEY-CQUERY / F8
  | 'search'    // CONT.SA — advanced search / Enter-Query mode
  | 'export';   // Excel / CSV

/** Shape of an action descriptor, visible to templates. */
export interface ActionSpec {
  kind: ToolbarAction;
  label: string;
  icon: string;       // PrimeIcons class without leading 'pi '
  variant: 'new' | 'edit' | 'del' | 'save' | 'cancel' | 'post' | 'ghost';
  visible: boolean;
  disabled: boolean;
  title?: string;
}

/**
 * ActionToolbarComponent — shared screen-level action bar.
 *
 * Responsibilities:
 *   - Renders a consistent action bar (جديد / تعديل / حذف / حفظ / إلغاء / ...).
 *   - Reads USERGN permissions via {@link PermissionService} and hides
 *     buttons the current user cannot invoke.
 *   - Computes per-action `disabled` state from screen-level inputs
 *     (editable mode, saving flag, posted flag, custom gates).
 *
 * The host screen still owns the business logic and reacts to the
 * `(action)` output emitting one of {@link ToolbarAction}.
 *
 * Usage:
 * ```html
 * <app-action-toolbar
 *   [screen]="'SNDS.FMX'"
 *   [mode]="mode()"
 *   [saving]="saving()"
 *   [posted]="posted()"
 *   [hasCurrent]="!!master()['NOS']"
 *   [actions]="['new','edit','delete','save','cancel','refresh']"
 *   (action)="onAction($event)" />
 * ```
 */
@Component({
  selector: 'app-action-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './action-toolbar.component.html',
  styleUrl: './action-toolbar.component.scss',
})
export class ActionToolbarComponent {
  private permSvc = inject(PermissionService);

  /** USERGN screen code (DATA_ACM.NAMEF), e.g. 'SNDS.FMX'. */
  readonly screen = input.required<string>();

  /** Current row-mode: browse / new / edit. */
  readonly mode = input<'browse' | 'new' | 'edit'>('browse');

  /** True while an async save is in flight. Disables `save` and destructive ops. */
  readonly saving = input<boolean>(false);

  /** True when a record is loaded (for delete/edit gating). */
  readonly hasCurrent = input<boolean>(false);

  /** True if the record should be locked as posted. Legacy display uses MRHL = 0. */
  readonly posted = input<boolean>(false);

  /** Extra save gate (e.g. form validation). `undefined` means don't gate. */
  readonly canSave = input<boolean | undefined>(undefined);

  /**
   * Ordered list of actions to render. Default is the classic voucher set.
   * Buttons are still hidden if the user lacks the matching USERGN flag.
   */
  readonly actions = input<ToolbarAction[]>(
    ['new', 'edit', 'delete', 'save', 'cancel', 'refresh'],
  );

  /** Optional right-side title (icon + label). */
  readonly title = input<string | null>(null);

  /** Optional icon class (e.g. 'pi-file-edit') rendered before title. */
  readonly icon = input<string | null>(null);

  /** Optional count badge rendered next to the title. */
  readonly countBadge = input<string | null>(null);

  /** Fired when any action button is pressed. */
  readonly action = output<ToolbarAction>();

  // ── Permissions from USERGN (cached in PermissionService) ──────────
  // Permissions.ins / .ed / .de are 0 when denied, non-zero when granted.
  private readonly perms = computed(() => this.permSvc.forScreen(this.screen())());
  readonly canIns = computed(() => (this.perms()?.ins ?? 0) > 0);
  readonly canEd  = computed(() => (this.perms()?.ed  ?? 0) > 0);
  readonly canDe  = computed(() => (this.perms()?.de  ?? 0) > 0);

  /** Single computed list that the template loops over. */
  readonly items = computed<ActionSpec[]>(() => {
    const mode = this.mode();
    const saving = this.saving();
    const hasCurrent = this.hasCurrent();
    const posted = this.posted();
    const canSave = this.canSave();
    const editable = mode === 'new' || mode === 'edit';

    // Each action knows its own visibility + disable logic. Order matches `actions` input.
    const registry: Record<ToolbarAction, ActionSpec> = {
      new: {
        kind: 'new', label: 'جديد', icon: 'pi-plus', variant: 'new',
        visible: this.canIns(),
        disabled: editable || saving,
        title: 'إضافة سجل جديد',
      },
      edit: {
        kind: 'edit', label: 'تعديل', icon: 'pi-pencil', variant: 'edit',
        visible: this.canEd(),
        disabled: !hasCurrent || editable || posted || saving,
        title: posted ? 'لا يمكن تعديل سجل مُرحّل' : 'تعديل السجل الحالي',
      },
      delete: {
        kind: 'delete', label: 'حذف', icon: 'pi-trash', variant: 'del',
        visible: this.canDe(),
        disabled: !hasCurrent || editable || posted || saving,
        title: posted ? 'لا يمكن حذف سجل مُرحّل' : 'حذف السجل الحالي',
      },
      save: {
        kind: 'save', label: saving ? 'جاري الحفظ...' : 'حفظ',
        icon: saving ? 'pi-spin pi-spinner' : 'pi-save',
        variant: 'save',
        visible: editable,
        disabled: saving || canSave === false,
        title: 'حفظ التغييرات',
      },
      cancel: {
        kind: 'cancel', label: 'إلغاء', icon: 'pi-times', variant: 'cancel',
        visible: editable,
        disabled: saving,
        title: 'إلغاء التعديلات',
      },
      post: {
        kind: 'post', label: 'ترحيل', icon: 'pi-check-square', variant: 'post',
        visible: this.canEd() && hasCurrent && !posted,
        disabled: editable || saving,
        title: 'ترحيل إلى دفتر اليومية',
      },
      unpost: {
        kind: 'unpost', label: 'إلغاء الترحيل', icon: 'pi-undo', variant: 'cancel',
        visible: this.canEd() && hasCurrent && posted,
        disabled: editable || saving,
        title: 'إلغاء ترحيل القيد',
      },
      refresh: {
        kind: 'refresh', label: '', icon: 'pi-refresh', variant: 'ghost',
        visible: true,
        disabled: saving,
        title: 'تحديث القائمة',
      },
      print: {
        kind: 'print', label: 'طباعة', icon: 'pi-print', variant: 'ghost',
        visible: hasCurrent && !editable,
        disabled: saving,
        title: 'طباعة السجل',
      },
      search: {
        kind: 'search', label: 'بحث', icon: 'pi-search', variant: 'ghost',
        visible: !editable,
        disabled: saving,
        title: 'بحث متقدم (F11)',
      },
      export: {
        kind: 'export', label: 'Excel', icon: 'pi-file-excel', variant: 'ghost',
        visible: !editable,
        disabled: saving,
        title: 'تصدير إلى Excel',
      },
    };

    return this.actions().map(k => registry[k]).filter(a => a.visible);
  });

  onClick(a: ActionSpec): void {
    if (a.disabled) return;
    this.action.emit(a.kind);
  }
}
