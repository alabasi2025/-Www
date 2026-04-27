import { Injectable, signal, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface SessionUser {
  nou: number;
  name: string;
  unit: string;
  schema: string;
  machine?: string;
  year: string;
  entryYear?: string;
  isAdmin: boolean;
  loginAt: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);

  readonly user = signal<SessionUser | null>(null);
  readonly loading = signal(true);

  get isBrowser() { return isPlatformBrowser(this.platformId); }

  private toMsg(v: unknown): string {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const m = o['message'];
      const e = o['error'];
      if (typeof m === 'string' && m.trim()) return m;
      if (typeof e === 'string' && e.trim()) return e;
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  }

  async init(): Promise<void> {
    if (!this.isBrowser) { this.loading.set(false); return; }
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; user?: SessionUser }>('/api/me'));
      if (r.ok && r.user) this.user.set(r.user);
    } catch { /* no session */ }
    this.loading.set(false);
  }

  async login(unit: string, userId: number | undefined, password: string, year: string, entryYear: string): Promise<string | null> {
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; error?: string; user?: SessionUser }>('/api/login', { unit, userId, password, year, entryYear }),
      );
      if (!r.ok) return this.toMsg(r.error || 'فشل تسجيل الدخول');
      if (r.user) this.user.set(r.user);
      return null;
    } catch (e) {
      if (e instanceof HttpErrorResponse) {
        const msg = this.toMsg(e.error) || this.toMsg(e.message) || 'فشل تسجيل الدخول';
        return msg;
      }
      return this.toMsg(e) || 'فشل تسجيل الدخول';
    }
  }

  async logout(): Promise<void> {
    try { await firstValueFrom(this.http.post('/api/logout', {})); } catch { /* */ }
    this.user.set(null);
  }
}
