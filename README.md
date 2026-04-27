# Alwael Accounting Web

واجهة ويب حديثة مبنية بـ Angular 21 مع خادم Hono/Node.js وارتباط بقاعدة Oracle.

## المتطلبات

- Node.js `>= 20.19.0`
- Oracle Database
- Oracle Instant Client اختياري عند الحاجة إلى Thick mode

## الإعداد

انسخ ملف البيئة النموذجي واضبط القيم الحقيقية محليا فقط:

```powershell
Copy-Item .env.example .env
```

المتغيرات المطلوبة:

- `ORACLE_CONNECT_STRING`: عنوان اتصال Oracle مثل `host:1521/service`
- `ORACLE_PASSWORD` أو `ORACLE_<SCHEMA>_PASSWORD`: كلمة مرور قاعدة البيانات

المتغيرات الاختيارية:

- `ORACLE_CLIENT_DIR`: مسار Oracle Instant Client
- `ORACLE_USER` أو `ORACLE_<SCHEMA>_USER`: اسم المستخدم إذا لم يكن مطابقا لاسم المخطط

لا ترفع ملف `.env` إلى GitHub.

## التشغيل

```powershell
npm install
npm run build
npm run serve:ssr:app-ng
```

العنوان الافتراضي:

```text
http://localhost:4000
```

## التطوير

```powershell
npm start
```

## ملاحظات

- ملفات البناء، السجلات، الصور المؤقتة، وملفات البيئة مستبعدة من Git.
- بيانات الاتصال بقاعدة البيانات لا توجد داخل الكود؛ يتم تمريرها عبر متغيرات البيئة.
