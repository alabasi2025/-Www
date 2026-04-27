# تقرير فجوات Pilot من المصدر القديم الحقيقي

المرجع: `D:/daty/_legacy_source_catalog_20260424_full`

هذا التقرير مبني على قراءة ملفات `.fmb/.rep/.rdf/.pll/.sql` الحقيقية، وليس على ملفات تحليل نصية قديمة.

## ملخص سريع

| الشاشة | Component جديد | Registry محدث من المصدر | API أساسي | فجوات مهمة قبل اعتماد مطابق بالملي |
|---|---:|---:|---:|---|
| TREE | نعم | نعم | جزئي | تقرير EXD، LOV NA2 بالكامل، مطابقة كل KEY behavior |
| SNDK | نعم | نعم | نعم | called forms: REPKHALL/REPSK، مراجعة print SNDK مقابل التقرير القديم |
| SNDS | نعم | نعم | نعم | تقارير SNDS2/SNDS3/SNDSK، called forms: REPKHALL/REPSS |
| SNDKD | نعم | نعم | نعم | called form REPKHALL، تدقيق منطق كل تريجر محاسبي |
| SNDKD2 | نعم | نعم | نعم | called forms: REPKD2/REPKHALL، تدقيق LOV NA22/NAM2 |
| SYSALL | نعم | نعم | جزئي | ربط SCR/DATA_AG وظيفيًا، تثبيت منطق SANDT/TBK/TBS كما القديم |

## أرقام المصدر الحقيقي

| الشاشة | تريجرات فريدة | ظهور خام للتريجرات | وحدات/باكجات | جداول/عروض | نماذج مستدعاة | تقارير | دوال DB | مفاتيح Legacy |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| TREE | 41 | 328 | 16 | 25 | 0 | 1 | 1 | 17 |
| SNDK | 44 | 520 | 38 | 19 | 3 | 1 | 7 | 20 |
| SNDS | 43 | 422 | 36 | 21 | 3 | 4 | 7 | 18 |
| SNDKD | 42 | 370 | 32 | 26 | 3 | 1 | 7 | 18 |
| SNDKD2 | 38 | 412 | 24 | 18 | 2 | 1 | 7 | 18 |
| SYSALL | 23 | 227 | 6 | 4 + TITL block | 0 | 0 | 0 | 12 |

## قرارات تنفيذية مباشرة

1. لا نعتمد أي شاشة كمطابقة بالملي حتى تمر بثلاث بوابات: Visual، Functional، Dependency.
2. Registry داخل Angular صار يحمل: الجداول، التقارير، called forms، LOVs، DB routines، legacy keys، و sourceMeta.
3. أي اختلاف بين التحليل والقديم الحي يحسم لصالح القديم الحي.
4. لا يوجد تعديل على `D:/daty/form` أو `D:/daty/rep`.

## أولويات التنفيذ التالية

1. SYSALL: تثبيت SANDT/TBK/TBS لأنها تؤثر مباشرة على ترحيل القيود والسندات.
2. SNDKD/SNDKD2: مراجعة LOVs والـ called forms والـ post/unpost مقابل التريجرات.
3. SNDK/SNDS: مطابقة الطباعة والتقارير الفرعية.
4. TREE: إكمال EXD/NA2 ومفاتيح Legacy.
