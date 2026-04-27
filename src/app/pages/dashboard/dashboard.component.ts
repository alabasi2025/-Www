import { Component } from '@angular/core';

@Component({
  selector: 'app-dashboard',
  template: `
    <div class="home-wrap">
      <div class="oracle-title">Oracle Database 10g Enterprise Edition Release 10.2.0</div>

      <div class="hero-row">
        <div class="badge-card" aria-hidden="true">
          <div class="tick"></div>
        </div>

        <div class="stats-card" aria-hidden="true">
          <div class="bars">
            <span style="--h: 34%"></span>
            <span style="--h: 50%"></span>
            <span style="--h: 64%"></span>
            <span style="--h: 78%"></span>
            <span style="--h: 92%"></span>
          </div>

          <div class="trend">
            <span class="seg a"></span>
            <span class="seg b"></span>
            <span class="seg c"></span>
          </div>

          <div class="pie"></div>
          <div class="shadow-plate"></div>
        </div>
      </div>

      <div class="footer-text">حقوق النسخة والتوزيع محفوظة للأوائل سوفت لأنظمة الحاسب</div>
      <div class="footer-numbers">777153270 - 734570264 - 733633244 - 773964375</div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }

    .home-wrap {
      height: 100%;
      background: #dcdfe3;
      border: 1px solid #a9adb3;
      display: grid;
      grid-template-rows: auto 1fr auto auto;
      padding: 18px 22px 14px;
      box-sizing: border-box;
      direction: rtl;
      font-family: Tahoma, Arial, sans-serif;
    }

    .oracle-title {
      text-align: center;
      color: #0a2f9a;
      font-size: 18px;
      font-weight: 700;
      margin-top: 4px;
    }

    .hero-row {
      display: flex;
      justify-content: center;
      align-items: flex-start;
      gap: 56px;
      min-height: 0;
      padding: 16px 0 14px;
      direction: ltr;
    }

    .badge-card {
      width: 132px;
      height: 112px;
      border: 1px solid #c2c8cf;
      background: linear-gradient(#eff3f7, #e4e9ef);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.75);
      margin-top: 10px;
      display: grid;
      place-items: center;
    }

    .tick {
      width: 64px;
      height: 38px;
      border-left: 10px solid #d51620;
      border-bottom: 10px solid #d51620;
      transform: rotate(-45deg) translateY(-3px);
      border-radius: 2px;
      filter: drop-shadow(0 1px 0 #8c1017);
    }

    .stats-card {
      width: 430px;
      height: 300px;
      border: 1px solid #c3cbd4;
      background: linear-gradient(#eef4fb, #dfe8f2);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.75);
      position: relative;
      overflow: hidden;
    }

    .bars {
      position: absolute;
      left: 44px;
      bottom: 84px;
      width: 180px;
      height: 165px;
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }

    .bars span {
      width: 28px;
      height: var(--h);
      background: linear-gradient(#79b5f0, #3f78c1);
      border: 1px solid #3064a3;
      box-sizing: border-box;
      border-bottom-width: 2px;
    }

    .trend {
      position: absolute;
      left: 172px;
      top: 92px;
      width: 182px;
      height: 100px;
    }

    .seg {
      position: absolute;
      height: 8px;
      border-radius: 4px;
      background: linear-gradient(#90b7ea, #4f84c8);
      box-shadow: 0 1px 0 rgba(41, 88, 150, 0.7);
    }

    .seg.a {
      width: 70px;
      left: 0;
      top: 56px;
      transform: rotate(-28deg);
    }

    .seg.b {
      width: 62px;
      left: 52px;
      top: 28px;
      transform: rotate(33deg);
    }

    .seg.c {
      width: 74px;
      left: 105px;
      top: 4px;
      transform: rotate(-34deg);
    }

    .pie {
      position: absolute;
      right: 36px;
      bottom: 38px;
      width: 136px;
      aspect-ratio: 1;
      border-radius: 50%;
      background: conic-gradient(#59a3eb 0 34%, #80c3f8 34% 60%, #356eb3 60% 100%);
      border: 2px solid #3167a2;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
    }

    .shadow-plate {
      position: absolute;
      left: 96px;
      bottom: 28px;
      width: 248px;
      height: 20px;
      border-radius: 50%;
      background: radial-gradient(ellipse at center, rgba(48, 87, 140, 0.33) 0%, rgba(48, 87, 140, 0) 72%);
    }

    .footer-text {
      text-align: center;
      color: #0535b2;
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 8px;
      text-decoration: underline;
    }

    .footer-numbers {
      text-align: center;
      font-size: 14px;
      color: #153518;
      font-weight: 700;
      margin-bottom: 8px;
    }

    @media (max-width: 1300px) {
      .oracle-title { font-size: 16px; }
      .footer-text { font-size: 14px; }
      .footer-numbers { font-size: 13px; }
      .hero-row { gap: 24px; padding-top: 10px; }
      .badge-card { width: 104px; height: 86px; }
      .tick { width: 48px; height: 28px; border-left-width: 8px; border-bottom-width: 8px; }
      .stats-card { width: 340px; height: 240px; }
      .bars { left: 32px; bottom: 68px; width: 140px; height: 130px; gap: 6px; }
      .bars span { width: 22px; }
      .trend { left: 132px; top: 74px; width: 150px; }
      .pie { width: 108px; right: 26px; bottom: 30px; }
      .shadow-plate { left: 70px; width: 194px; }
    }
  `],
})
export class DashboardComponent {}
