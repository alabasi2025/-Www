import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/**
 * Permissions object returned from /api/permissions/:screen.
 * Mirrors the USERGN columns (0 = denied, non-zero = granted).
 */
export interface Permissions {
  ins:  number;  // INSERT
  ed:   number;  // EDIT
  de:   number;  // DELETE
  pr:   number;  // PRINT
  sar:  number;  // cost-currency rate visibility
  saa:  number;  // cost amount visibility
  sarb: number;  // sell-price visibility
  hs1:  number;
  hs2:  number;
  fnkd: number;
}

export const EMPTY_PERMS: Permissions = {
  ins: 0, ed: 0, de: 0, pr: 0, sar: 0, saa: 0, sarb: 0, hs1: 0, hs2: 0, fnkd: 0,
};

export const FULL_PERMS: Permissions = {
  ins: 4, ed: 4, de: 4, pr: 4, sar: 4, saa: 4, sarb: 4, hs1: 4, hs2: 4, fnkd: 4,
};

interface PermResponse {
  ok: boolean;
  perms?: Permissions;
  isAdmin?: boolean;
  error?: string;
}

/**
 * PermissionService — wraps /api/permissions/:screen with a short cache.
 *
 * Usage in a screen component:
 *
 *   private perms = inject(PermissionService);
 *   readonly p = this.perms.forScreen('SNDK.FMX');
 *
 *   // In template:
 *   <button [disabled]="!p().ins">جديد</button>
 *   <button [disabled]="!p().ed">تعديل</button>
 *   <button [disabled]="!p().de">حذف</button>
 */
@Injectable({ providedIn: 'root' })
export class PermissionService {
  private http = inject(HttpClient);

  // Cache of permission signals keyed by screen name (uppercased).
  private readonly cache = new Map<string, ReturnType<typeof signal<Permissions>>>();
  private readonly loading = new Map<string, Promise<Permissions>>();

  /** True if the current user is a super-admin (STATU > 0). */
  readonly isAdmin = signal<boolean>(false);

  /**
   * Returns a signal of the permissions for a given screen.
   * The signal is updated asynchronously once the API responds.
   * Subsequent calls return the same signal (cached).
   */
  forScreen(screen: string): ReturnType<typeof signal<Permissions>> {
    const key = screen.toUpperCase();
    const existing = this.cache.get(key);
    if (existing) return existing;

    const sig = signal<Permissions>({ ...EMPTY_PERMS });
    this.cache.set(key, sig);
    void this.load(key, sig);
    return sig;
  }

  /** Computed helper: does the user have permission to perform the action? */
  can(screen: string, action: keyof Permissions) {
    const sig = this.forScreen(screen);
    return computed(() => (sig()[action] ?? 0) > 0);
  }

  /** Force-refresh from the server (e.g. after a role change). */
  async refresh(screen: string): Promise<Permissions> {
    const key = screen.toUpperCase();
    const sig = this.cache.get(key) ?? signal<Permissions>({ ...EMPTY_PERMS });
    if (!this.cache.has(key)) this.cache.set(key, sig);
    return this.load(key, sig, /* force */ true);
  }

  /** Clear everything (e.g. on logout). */
  clear(): void {
    this.cache.clear();
    this.loading.clear();
    this.isAdmin.set(false);
  }

  private async load(
    key: string,
    sig: ReturnType<typeof signal<Permissions>>,
    force = false,
  ): Promise<Permissions> {
    if (!force && this.loading.has(key)) return this.loading.get(key)!;
    const p = (async () => {
      try {
        const r = await firstValueFrom(
          this.http.get<PermResponse>(`/api/permissions/${encodeURIComponent(key)}`),
        );
        if (r.ok && r.perms) {
          this.isAdmin.set(!!r.isAdmin);
          sig.set(r.perms);
          return r.perms;
        }
        // API returned ok:false (e.g. 401) — fallback to full perms so UI is usable
        console.warn(`[PermissionService] API returned ok:false for ${key}, falling back to FULL_PERMS`);
        sig.set({ ...FULL_PERMS });
        return sig();
      } catch {
        // network error — fallback to full perms so buttons are not permanently disabled
        console.warn(`[PermissionService] Network error for ${key}, falling back to FULL_PERMS`);
        sig.set({ ...FULL_PERMS });
        return sig();
      }
    })();
    this.loading.set(key, p);
    const out = await p;
    this.loading.delete(key);
    return out;
  }
}
