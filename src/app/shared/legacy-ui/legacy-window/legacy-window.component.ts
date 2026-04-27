import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-legacy-window',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './legacy-window.component.html',
  styleUrl: './legacy-window.component.scss',
})
export class LegacyWindowComponent {
  readonly title = input<string>('Legacy');
}
