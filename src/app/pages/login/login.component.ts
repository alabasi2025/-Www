import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';

interface Unit {
  NU: string;
  NA: string;
}

interface LoginUser {
  nou: number;
  name: string;
  isAdmin: boolean;
}

@Component({
  selector: 'app-login',
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private http = inject(HttpClient);

  readonly units = signal<Unit[]>([]);
  readonly users = signal<LoginUser[]>([]);
  readonly unit = signal('A');
  readonly userId = signal<number | null>(null);
  readonly year = signal(String(new Date().getFullYear()));
  readonly entryYear = signal(String(new Date().getFullYear()));
  readonly password = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly yearOptions = signal<string[]>([String(new Date().getFullYear())]);

  async ngOnInit(): Promise<void> {
    if (!this.auth.isBrowser) return;
    await this.loadUnits();
  }

  async onUnitChange(v: string): Promise<void> {
    this.unit.set(v);
    this.userId.set(null);
    this.error.set(null);
    await Promise.all([this.loadUsers(v), this.loadYears(v)]);
  }

  onYearChange(v: string): void {
    const year = String(v || '').trim();
    if (!/^\d{4}$/.test(year)) return;
    this.year.set(year);
    this.entryYear.set(year);
  }

  async login(): Promise<void> {
    if (!this.userId()) {
      this.error.set('الرجاء اختيار اسم المستخدم');
      return;
    }
    if (!this.password()) {
      this.error.set('الرجاء إدخال كلمة المرور');
      return;
    }

    this.error.set(null);
    this.busy.set(true);

    const err = await this.auth.login(
      this.unit(),
      this.userId()!,
      this.password(),
      this.year(),
      this.entryYear(),
    );

    this.busy.set(false);
    if (err) {
      this.error.set(err);
      return;
    }
    await this.router.navigate(['/app']);
  }

  setUserId(value: unknown): void {
    const n = Number(value);
    this.userId.set(Number.isFinite(n) ? n : null);
  }

  exit(): void {
    this.password.set('');
    this.error.set(null);
    if (typeof window !== 'undefined') {
      window.blur();
    }
  }

  private async loadUnits(): Promise<void> {
    try {
      const r = await firstValueFrom(this.http.get<{ ok: boolean; units?: Unit[] }>('/api/units'));
      if (r.ok && r.units?.length) {
        this.units.set(r.units);
        this.unit.set(r.units[0].NU);
        await Promise.all([this.loadUsers(r.units[0].NU), this.loadYears(r.units[0].NU)]);
      }
    } catch {
      this.units.set([]);
    }
  }

  private async loadYears(unit: string): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; years?: string[] }>(`/api/years?unit=${unit}`),
      );
      const years = r.ok && r.years?.length ? r.years : [String(new Date().getFullYear())];
      this.yearOptions.set(years);
      this.year.set(years[0]);
      this.entryYear.set(years[0]);
    } catch {
      const y = String(new Date().getFullYear());
      this.yearOptions.set([y]);
      this.year.set(y);
      this.entryYear.set(y);
    }
  }

  private async loadUsers(unit: string): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ ok: boolean; users?: LoginUser[] }>(`/api/login-users?unit=${unit}`),
      );
      const list = r.ok ? (r.users ?? []) : [];
      this.users.set(list);
      if (list.length) this.userId.set(list[0].nou);
    } catch {
      this.users.set([]);
      this.userId.set(null);
    }
  }
}
