# طريقة تشغيل خادم Angular / Node.js (SSR)

بسبب كبر حجم المشروع (80 شاشة)، استخدام `ng serve` يسبب استهلاك هائل للذاكرة (Out Of Memory) ويغلق نفسه بصمت (SIGKILL) في بيئة Windows.

**الطريقة الصحيحة والوحيدة المعتمدة للتشغيل السريع (بدون compilation):**

1. يجب الاعتماد دائماً على النسخة المجمّعة (`Build`) الموجودة في مجلد `dist/app-ng/server/server.mjs`.
2. يتم التشغيل باستخدام `node` مع تحديد المسار المدمج في المشروع.

### أمر التشغيل في PowerShell:
```powershell
Set-Location "D:\daty\app-ng"
$env:PATH = "D:\daty\tools\node-v20.19.0-win-x64;$env:PATH"

# إيقاف أي عملية Node سابقة لتجنب تعليق البورت 4000
Stop-Process -Name node -Force -ErrorAction SilentlyContinue

# تشغيل السيرفر المجمع
node dist/app-ng/server/server.mjs
```

### أمر التشغيل في Command Prompt (CMD) أو ملف .bat:
```cmd
cd /d D:\daty\app-ng
set PATH=D:\daty\tools\node-v20.19.0-win-x64;%PATH%
taskkill /f /im node.exe
node dist\app-ng\server\server.mjs
```

*ملاحظة: هذا السيرفر مبرمج ليعمل على `http://localhost:4000` وقد تم تعديل كود الـ SSR للسماح بطلبات Localhost بدون التسبب بخطأ SSRF.*