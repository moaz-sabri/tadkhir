# PLAYBOOK — Tadkhir (الدليل التقني)

يشمل هذا الملف تفاصيل التنفيذ الفعلي كما هو مكتوب في الكود (النسخة العامة المطابقة للمستودع الحالي). كل قسم مبني مباشرة من الملفات المذكورة.

> هذا هو المرجع التقني التفصيلي. للبداية ولكيفية التشغيل راجع [`README.md`](README.md).

---

## 0) نظام التصميم — كيف تُبنى أي شاشة (`app/js/ui/` + `app/css/`)

القاعدة التي تحكم كل ما تحت: **لا صفحة تكتب رأسًا أو صفًّا أو زرًّا أو حالة فارغة بيدها.**
كل شاشة مركَّبة من `ui/components/ui.js` (الحاويات والأفعال) و`ui/components/fields.js` (الحقول والاختيار والبحث)، والـ CSS المقابل في `components.css`.

### الطبقات الأربع

| الطبقة | الملف | ما يصنعه |
|---|---|---|
| مُصنِّع الأيقونات | `ui/icons.js` | `ICONS` (سجلّ واحد) + `uiIcon(name)` + `NAV_ICON_NAMES` + `MONEY_ICON_NAMES` |
| النواة | `ui/components/ui.js` | `page` · `heading` · `pageHead` · `sectionTitle` · `pageSection` · `card` · `cardGrid` · `list` · `listRow` · `pickRow` · `badge` · `action` · `rowAction` · `actionRow` · `toolbar` · `stat` · `statGrid` · `statPanel` · `emptyState` · `notFoundView` · `errorView` · `target` · `targetGrid` |
| الحقول | `ui/components/fields.js` | `caption` · `field` · `fieldError` · `fieldGroup` · `fieldRow` · `formShell` · `saveButton` · `searchField` · `searchInput` · `selectControl` · `settingRow` |
| التخصّصات | `dialog.js` · `toast.js` · `icon-picker.js` · `nav.js` · `finance-nav.js` | النوافذ والرسوم والاختيار الثنائي وشريطا التنقّل |

`finance-fields.js` و`task-form.js` و`later-form.js` تبني حقولها كلّها بـ `field()`/`fieldError()`/`formShell()` من الطبقة الثالثة — لا نسخة خاصة منها.

### `action()` — الزرّ الوحيد في التطبيق

```js
action({ label, icon, tone, href, external, onClick, type, title, ariaLabel, disabled, block, className }, ...extra)
```

- `href` موجود ← `<a>` (`data-link`، أو `target="_blank"` مع `external`)، وإلا `<button>`.
- `tone` من ثلاثة فقط: `""` · `primary` · `danger` · `quiet`. (الأحمر للمدمّر فقط، و`danger` حدٌّ لا حشو، فصفّ أزرار لا يصير صفًّا أحمر.)
- **بلا `label` ← `.btn.icon-only`** (مربّع 44px)، يُقرَّر داخل المصنع فلا يستطيع صفٌّ أن يخطئ. الكلمة تصير `aria-label` و`title`.
- `rowAction({...})` غلاف الصفّ، ويمرّر `label` إلى `ariaLabel`.

### `listRow()` — تشريح واحد لكل القوائم

```
.list-row
├── .row-glyph      أيقونة واحدة للصفّ (اختيارية)
├── .row-body       .row-line  [.row-title] [.badge …]
│                   .row-sub   السطر الثاني (مقلّص بـ line-clamp)
└── .row-actions    [أيقونات مربّعة]
```

السبب: `.list-row > a:first-child` كان محدِّدًا على **الابن المباشر**، فالصفوف التي كان رابطُها داخل `.stack` كانت **تفقد** التحويم ونمط السطر كلّه. التشريح الجديد يجعل الرابط **دائمًا** عنصرًا مستقلًّا، فلا يتغيّر الشكل بوجود سطر ثانٍ.

**عرض ضيّق**: تحت `max-width: 479px` ينزل `.row-actions` إلى سطره (و`.row-body` يأخذ `100%`)، وتحت `359px` يختفي `.row-glyph`. هذا ما يجعل صفًّا بأربعة أفعال أيقونية يُقرأ كما هو في العربية.

### `listRow` مقابل `pickRow`

`listRow` صفٌّ يفتح شيئًا (رابط) ويلتفّ بأفعال. `pickRow` **هو** الخيار: `<button class="list-row list-row-pick">` بكامل السطر هدفًا — لحوار الاختيار.

### `pageHead()` — رأس واحد

```js
pageHead({ title, icon, leading, actions })
```

`leading` = فتحة البداية (رجوع)، `actions` = فتحة النهاية («جديد»/مرشّح/حقل فترة/مُفتِح حوار). **كلاهما الخانة نفسها في كل شاشة**، ولهذا يجتمع زرّ «جديد» ومرشّح التقارير ومُفتِح حوار في موضع واحد دون أن يبدو أحدهما رأسًا مختلفًا. الصفحات الأربع «جديد X» صارت لها `leading: backTo(BASE)` — لم يكن فيها طريق للخروج قبلها.

### `stat` / `statGrid` / `statPanel` / `badge`

- `stat({label, value, icon})` = خلية «اسم فوق قيمة» — **الشكل الوحيد** في التطبيق: التقارير، ملخّص المالية، تفاصيل الدين، الدورية، لوحة الجلسة، تفاصيل المهمة.
- `statGrid(...)` شبكة (عمود واحد ← اثنان عند `400px` ← ثلاثة عند `1024px`). **السقف ثلاثة**: الإطار محدود بـ `1180px` فالـ بطاقة ~580px، وعمود رابع فيها 130px لكل تسمية ينكسر إلى ثلاثة أسطر.
- `statPanel(...)` الشبكة نفسها داخل بطاقة مسوّرة — لملخّص شاشة واحدة.
- `badge(text, {icon})` = الرقيقة القصيرة على الصفّ.

### `field()` / `fieldError()`

`field(label, control, error, ...extra)` = `<label class="field">` فيه `<span class="label">` ثم التحكّم ثم سطر الخطأ.

- **التسمية دائمًا `<span class="label">`** لا نصّ عارٍ. نموذج «لاحقًا» كان يمرّر نصًّا عاريًا فيُعرض بخط المتصفح بجانب حقول رمادية صغيرة في الشاشة نفسها.
- **`fieldError` في الـ DOM من البداية** بلا مقاس وبلا حدّ حتى ينصّ (`role="status"` يجب أن يكون موجودًا قبل النصّ ليُلتقط). نموذج «لاحقًا» كان يترك `.field-error`، فيصل «هذا الحقل مطلوب» رماديًا حيث يصل أحمر في نموذج آخر.

### `searchField()` / `selectControl()`

- `searchField(placeholder)` يُعيد `{ input, element }`: عدسة مكبّرة **داخل** الحقل وزرّ مسح يظهر فقط حين يوجد نصّ، والـ `input` هو المُعاد فيستعمله النداء كحقل عادي. `searchInput(placeholder)` لاختصار إضافي.
- **`selectControl({options, value, ariaLabel, onChange})`** يُعيد `{ select, element }`: سهم أيقونة على `inset-inline-end`. **لا `<select>` عارٍ في التطبيق** — السهم القديم كان `linear-gradient` مثبَّتًا على `100%` (الحافة الفيزيائية) فيظهر في صفحة عربية على الجهة التي لا يقرأ منها القارئ، و`base.css` ينصّ على أن كل `<select>` ملفوف بـ `.select`.

### `emptyState()` / `notFoundView()` / `errorView()`

- `emptyState(text, {icon, action})` = `.empty` (مربّع 56px بأيقونة باهتة + جملة). **كل** حالة فارغة في التطبيق: اثنتا عشرة كانت فقرة رمادية عاردة، واثنتان (قائمة الجلسات، قائمة التصنيفات) كانتا **بلا شيء**.
- `notFoundView(root)` = شاشة السجلّ الغائب، **مشتركة** بالصفحات الست التي كانت تكتب `root.textContent = t("error.not_found")` فتكسر عقد الصفحة. `errorView(text)` لصفحة فشلت في التركيب (`router.js`) وللقاعدة غير المتاحة (`main.js`).

### `dialog` — النافذة الوحيدة

`dialog.confirm` · `dialog.choose` · `dialog.form(messageKey, { body, submit, titleKey, submitLabel, submitIcon })`.

- **`body(close)` و`submit(close)` كلاهما يحصل على `settle`**، فجسمٌ يختار بنفسه (حوار اختيار) وجسمٌ يُؤكَّد بزرّ يتشاركان تنفيذًا واحدًا.
- `submit: null` ← لا زرّ تأكيد إطلاقًا (الاختيار في الجسم). `messageKey: null` ← لا فقرة تحت العنوان.
- `dialog.form` **هو** نموذج التصنيف ومنتقي الشخص الآن. كانا يبنيان `.dialog-backdrop`/`.dialog` بأيديهما: لا يستمعان للتنقّل (فيبقان فوق الصفحة الجديدة)، ولا يحرسان حوارًا فوقهما، ويحلّان بـ `null` بدل `CANCELLED` (فتُفرض `orNull` على كل نداء). **نافذة جديدة = `dialog.form`، لا خلفية مكتوبة بيد.**
- كل مخرج (زرّ، Escape، الخلفية، تنقّل، استبدال) يمرّ بـ `settle` واحدة.

### الأيقونات (`ui/icons.js`)

- **`ICONS` هو كل بيانات المسارات في التطبيق.** `uiIcon(name)` يرمي على اسم مجهول (فشل باكر لا مربّع فارغ). الاختصار الوحيد المسموح هو `icon()` الخام، وداخليًا في `uiIcon`.
- **تسلسل بلا ازدواج**: `tests/ui.test.mjs` يفشل إن تطابق رسم أيقونتين، وإن وُجد `"M…"` خارج السجلّ، وإن حملت خريطة اسمها `*_ICONS` قيمةً ليست اسمًا.
- **`FLIPPED`** (‏`back` · `forward` · `chevronRight` · `undo`) تحمل `icon-flip`، والقاعدة `:root[dir="rtl"] .icon-flip` في `base.css` تقلبها **عند RTL فقط**. **المرآة على الصنف لا داخل بيانات المسار**، فتبرسم واحدة تخدم اللغتين.
- **سلّم الأحجام** `--icon-sm` / `--icon` / `--icon-lg` مطبَّق مرة عبر `.icon` / `.icon-sm` / `.icon-lg`. صنف مكوّن **لا يكتب مقاسًا**؛ `.btn-icon` و`.nav-icon` استثناءان لهما سبب (حجم ثابت داخل زرّ، وشريط الوجهات الذي يغيّر مقاسه مع عتبته).
- **الاعتماد على الأيقونات**: كل فعل داخل صفّ أيقونة مربّعة 44px والكلمة `aria-label` وعنوانًا؛ ولكل رأس صفحة وقسم وصفّ أيقونة؛ وحقول البحث فيها عدسة وزرّ مسح.

### المقياس الاستجابي — قيمة واحدة

كل قيمة `@media` في `app/css/*.css` من التسع في تعليق `tokens.css` (`400` · `480` · `640` · `1024` كحدود صغرى، `1023` · `639` · `479` · `359` كحدود عليا، وارتفاع `560` في الوضع الأفقي). **`tests/ui.test.mjs` يقرأ ذلك التعليق ويفشل على أي قيمة أخرى.** عتبة جديدة = سطر في `tokens.css` بسبب مكتوب. **لا عتبة فوق 1024px** لأن الإطار محدود بـ `1180px`.

### ما لا يُصنع في الصفحة

`class: "list-row"` · `class: "title"` · `class: "section-header"` · `class: "share-target` · `class: "row"` — محظورة كلها بـ `tests/ui.test.mjs`. أي شكل جديد يُعرَّف في `components.css` كـ**مكوّن**، لا كاستثناء على شاشة واحدة.

---

## 1) مخطط الجداول الفعلي

### خادم المزامنة — SQLite (`api/db.php`, `task_timer_schema`)

| الجدول | الأعمدة | دوره |
|---|---|---|
| `records` | `space_id INTEGER NOT NULL`, `store TEXT NOT NULL`, `id TEXT NOT NULL`, `rev INTEGER PRIMARY KEY AUTOINCREMENT`, `deleted INTEGER NOT NULL DEFAULT 0`, `updated_at INTEGER NOT NULL`, `data TEXT`, `UNIQUE (space_id, store, id)` | سجل واحد لكل سجل عميل، معزول بالمساحة. `rev` متسلسلة تصاعدية أحادية لكل مساحة وتُستخدم كـ cursor للسحب. `data` عمود واحد يخزّن JSON مشفَّرًا (أو NULL للحذف). |
| `spaces` | `id INTEGER PRIMARY KEY AUTOINCREMENT`, `code TEXT NOT NULL UNIQUE`, `password_hash TEXT NOT NULL`, `created_at INTEGER NOT NULL` | المساحة الخاصة: الرمز + هاش كلمة السر (`password_hash` عبر `password_hash()`/`PASSWORD_DEFAULT`). |
| `sessions` | `id INTEGER PRIMARY KEY AUTOINCREMENT`, `space_id INTEGER NOT NULL`, `token_hash TEXT NOT NULL UNIQUE`, `created_at INTEGER NOT NULL`, `expires_at INTEGER NOT NULL` | جلسات المصادقة من جهة الخادم (24 ساعة افتراضيًا). الـ cookie يحمل التوكن النصي، والجدول يحفظ `sha256(token)` فقط. |
| `devices` | `space_id INTEGER NOT NULL`, `device_id TEXT NOT NULL`, `label TEXT`, `created_at INTEGER NOT NULL`, `last_seen_at INTEGER NOT NULL`, `PRIMARY KEY (space_id, device_id)` | الأجهزة المسجّلة لكل مساحة — هوية/قياس تلقي فقط، لا تُستخدم في المصادقة. |
| `auth_failures` | `ip TEXT PRIMARY KEY`, `count INTEGER NOT NULL DEFAULT 0`, `window_start INTEGER NOT NULL` | عدّاد فشل المصادقة لكل IP لتحديد المعدّل. |

ملاحظة: `rev` عام لكل المساحة (ليس لكل store). عند `DELETE + INSERT` يُعاد إدراج الصف فيحصل على `rev` جديد أعلى، مما يبقي الـ cursor أحادي الاتجاه.

### عميل المتصفح — IndexedDB (`app/js/data/migrations.js`, `DB_NAME="task-timer"`, `DB_VERSION=7`)

| الكائن (store) | المفتاح | الفهارس | دوره |
|---|---|---|---|
| `tasks` | `id` | — | المهام (`title`, `estimatedMs`, `note`, `plannedAt`, `subtasks`, `pinned`, `archived`, `usageCount`, `lastUsedAt`, `createdAt`, `updatedAt`). |
| `sessions` | `id` | `startedAt`, `taskId`, `status`, `activeSlot` (unique) | جلسات المؤقّت. `activeSlot` حقل محلي فريد (=1 للجلسة النشطة) لا يُزامَن خارج الجهاز. |
| `events` | `id` | `sessionId` | سجل أحداث الجلسة (`session.started`, `session.paused`, `session.resumed`, `session.completed`, `session.cancelled`, `session.task.completed`, …). |
| `meta` | `key` | `key` (`enc_key`, Migration 3) | زوج مفتاح/قيمة: `settings`, `sync` (حالة المزامنة + cursor), `syncConfig` (deviceId/deviceName/code), `lastBackup`, مفتاح التشفير المشفّر وأملاحه. |
| `outbox` | `key` (= `type:id`) | — | طابور التغييرات غير المُرسَلة (Migration 2). |
| `transactions` | `id` | `occurredAt`, `category`, `recurringId` | حركات مالية منفردة (Migration 4). `amount` عدد صحيح بالوحدات الصغرى و`direction` = `in`\|`out`. `type` = `expense`\|`income`. `title` نصي قصير، `note` اختياري، `recurringId` اختياري (يحدّد أن الحركة ناتجة عن قاعدة دورية)، `occurredAt` طابع زمني. |
| `recurring` | `id` | `active` | **قواعد** دورية، لا حركات مستقبلية مُولَّدة مسبقًا (Migration 4). `title`, `amount`, `direction`, `type`, `category?`, `frequency` = `daily`\|`weekly`\|`monthly`, `anchorAt` (نقطة الارتكاز), `skipped[]` (طوابع تخطّي), `note?`, `active`. **لا يوجد `nextAt`** — تاريخ الاستحقاق التالي مشتقّ (انظر `domain/finance.js: nextDueAt`). |
| `debts` | `id` | `direction`, `category` | دين (`direction` = `owed_by_me`\|`owed_to_me`), `title`, `amount` (إجمالي الدين بوحدات صغرى), `personId?` (رابط حي للشخص), `person?` (لقطة اسم)، `dueAt?`, `note?`, `category?`. **المدفوع والمتبقي محسوبان دائمًا** من `debtPayments` ولا يُخزَّنان. |
| `debtPayments` | `id` | `debtId` | سجلات دفع مستقلة (`debtId`, `amount`، `paidAt`, `note?`, `title` = `null`). تُحذف تتاليًا عند حذف الدين محليًا وعند `applyChanges`. |
| `categories` | `id` | — | **أسماء التصنيفات فقط** — المفتاح `id` هو الاسم المعروض (Migration 5). بذر افتراضي: `home/work/car/food/health/shopping/other`. لا أيقونات/ألوان/ميزانيات/ترتيب. التصنيف الافتراضي `other` لا يُحذف. |
| `people` | `id` | — | شخص = اسم + ملاحظة اختيارية. لا نوع (مدين/دائن) — يُحدّد على كل دين. البحث بالتطابق غير الحساس لحالة الأحرف عند الإضافة المباشرة (Migration 5). |
| `later` | `id` | — | عناصر «لاحقًا» (Migration 6). `type` = `link`\|`note`, `title?`, `content`, `url?`, `completedAt?` (تابعَعت = ختم واحد، لا علم), `createdAt`, `updatedAt`. **بلا فهارس عمدًا**: المتجر محدود بـ 500 عنصر وكل شاشة تقرأ القائمة كاملة (لأنها تُقسّمها «غير متابَع/متابَع») — الفهرس وعدٌ لا يستهلكه أي مسار قراءة. |

| `pages` | `id` | — | صفحات حرة (`title?`, `description?`, `createdAt`, `updatedAt`) — Migration 7. **بلا فهارس عمدًا** مثل `later`: شاشة القائمة تقرأها كاملة. |
| `pageItems` | `id` | `pageId` | أسطر الصفحة (Migration 7). `pageId` (مالكها) + `type` + `position` + `content`. فهرس `pageId` وحده لأن قراءتَي `pageItems` هما `byPage` و`deleteByPage` فقط. |
| `routines` | `id` | — | **قواعد** الأنشطة المتكررة (Migration 10). `kind` = `timed`\|`counter`, `frequency` = `daily`\|`weekly`, `weekday?`, `title`, `durationMs?`, `target?`, `reminderBeforeMs?`, `reminderEveryMs?`, `active`, `createdAt`, `updatedAt`. **لا.activity إطلاقًا** — ولا حقل `nextAt` ولا `lastDoneAt`: "متى حان الدور" مشتقّ، و"ماذا فعل المستخدم" في السجلات القائمة. **بلا فهارس** مثل `later`/`pages`: السقف 100 وكل شاشة تقرأ القائمة كاملة. |
| `routineLogs` | `id` | `routineId`, `dayKey` | صفّ واحد لكل (قاعدة، يوم) — Migration 10. `id` = `` `${routineId}@${dayKey}` ``، أي أن **الزوج هو المفتاح**: صفُّ اليوم قراءةٌ واحدة، والعدّاد يبدأ من جديد ذاتيًا عند تغيّر اليوم بلا أي إعادة تهيئة. الفهسان يخدمان قراءتين حقيقيتين: `routineId` لـ `history()` و`deleteByRoutine()` (السلسلة المتتالية)، و`dayKey` لـ `today()` — ولهذا كُتبت الأيام صفًّا صفًّا. |

> **عناصر الصفحات: `content` يحمل المؤشّر لا السجلّ**. `text`/`heading` → `{ text }`، و`divider` → `null`، والأنواع الأربعة المرتبطة → `{ taskId }` / `{ sessionId }` / `{ laterId }` / `{ transactionId }` بحسب `PAGE_ITEM_TARGETS` في `validation.js`. كل تسمية وكل مبلغ وكل «هذا مكتمل» تعرضه الصفحة **يُقرأ من السجلّ الأصلي لحظة العرض**، فلا تملك الصفحة نسخة يمكن أن تخالف الأصل.

> **اصطلاح التسمية**: أسماء الـ IndexedDB **جمع** (`transactions`/`recurring`/`debts`/`debtPayments`/`categories`/`people`)، وأنواع المزامنة **مفرد** (`transaction`/`recurring`/`debt`/`debtPayment`/`category`/`person`) — انظر `SYNCED_STORES` في `sync-service.js`. `pages`/`pageItems` تتبع هذا الاصطلاح تمامًا (جمع في الجهتين). `later` استثناء محايد: الاسم مفرد في الجهتين لأنه لا جمع له.

---

## 2) منطق المزامنة كما هو مطبّق (`api/sync.php` + `app/js/services/sync-service.js`)

### Push (`POST /api/sync/push`)
- الجسم: `{ changes: [{ type, id, op, data, updatedAt }], device? }`.
- `task_timer_touch_device()`: يحدّث `devices.last_seen_at` لأي جهاز يدفع/يسحب فعليًا (إحصاء فقط — الجديد في نسخة العمل).
- تحقق الشكل (`task_timer_push`):
  - `type ∈ TASK_TIMER_STORES = ['task','session','event','meta','transaction','recurring','debt','debtPayment','category','person','later','page','pageItem','kanbanItem','routine','routineLog']`؛ خلاف ذلك يُعدّ `invalid`. الأنواع الأخيرة هي المالية/المفردات/Later/الصفحات/الكانبان/الأنشطة وتُخزَّن في نفس جدول `records` (لا مسار API منفصل لأي منها).
  - `op ∈ {upsert, delete}`؛ `id` نصي غير فارغ ≤ 256 حرفًا؛ `updatedAt` عدد صحيح > 0.
  - الـ upsert يشترط `data` ككائن؛ الـ delete يفرض `data = null`.
  - `invalid` تُحسب ولا تُطبق؛ الدفعة تُقتطع إلى `PUSH_BATCH` (200 افتراضيًا).
- **حل التعارضات (منفّذ)**: Last-Write-Wins على `updatedAt` — إذا كان الصف المخزَّن أحدث (`old.updated_at > c.at`) تُرفض النسخة (`rejected++`)، وإلا تُطبَّق عبر **حذف + إدراج** في معاملة واحدة لكي يحصل الصف على `rev` جديد عن طريق AUTOINCREMENT (يُبقي الـ pull cursor رتيبًا).
- المقبول يُدرج مع `deleted = (op === 'delete' ? 1 : 0)`، و`data = json_encode(data)` (على العميل: ciphertext).
- الرد: `{ ok, accepted, rejected, invalid }`.
- **حصة المتاجر غير الأساسية (backstop)**: بعد قبول التغييرات، تُحسب `$pendingNew` (السجلات الجديدة التي لم تكن موجودة) لكل store عبر `array_fill_keys`، وتُرفض بزيادة `rejected` إذا تجاوزت `MAX_FINANCE_RECORDS_PER_SPACE` (افتراضي 10000). **سقف واحد مشترك** لكل المتاجر غير `task`/`session` (منها `later`) بدل مفتاح env لكل متجر: العميل يفرض حدوده الأدق محليًا، وهذا يمنع فقط جهازًا واحدًا من ملء المساحة للجميع. الخادم يمنعان فقط، لأن العميل يفرض حدوده الأدق في `domain/validation.js` (`MAX_FINANCE_*`/`MAX_LATER_ITEMS`).
- ملاحظة من الاختبارات: push متساوي الطابع الزمني idempotent إلا أنه يحرّك `rev` (النسخة الثانية تُقبل ويُعاد إدراج الصف).
- **Tombstones تُنظَّف بسكربت GC**: `records` صفوف `deleted=1` تُحذف نهائيًا عبر `php api/gc.php` بعد فترة سماح `TOMBSTONE_GC_AGE` (افتراضي 30 يومًا، أعلى بكثير من أي فاصل مزامنة/backoff واقعي — انظر قسم الإجراءات التشغيلية).

### Pull (`POST /api/sync/pull`)
- الجسم: `{ cursor, device? }`؛ cursor افتراضي 0 إن لم يكن عددًا صحيحًا ≥ 0.
- الاستعلام: `SELECT ... WHERE space_id = ? AND rev > ? ORDER BY rev ASC LIMIT PULL_BATCH` (200 افتراضيًا).
- `nextCursor` = `rev` آخر صف في الصفحة إذا اكتملت الصفحة (`count(rows) === batch`)، وإلا الحد الأقصى الحالي لـ `rev` للمساحة. الرد يشمل `more` (صحيح إذا الصفحة ممتلئة).
- كل تغيير مرجَع: `{ type: store, id, op (deleted? delete: upsert), data (json_decode أو null), updatedAt, rev }`.
- الرد: `{ ok, changes, nextCursor, more }`.

### جانب العميل (`sync-service.js`)
- **push (pushPending)**: يقرأ كل outbox، يدفع بدفعات `SYNC_PUSH_BATCH = 100`؛ قبل الإرسال يشفر `data` (upsert) بـ AES-256-GCM — باستثناء `type==="session"` حيث يُستبعد `activeSlot` أولًا (`stripActiveSlot`). بعد نجاح `fetchJson("sync/push", …)` يُحذف كل إدخال الدفعة من outbox.
- **pull (pullAndApply)**: cursor محفوظ في meta بمفتاح `sync` (الحقل `cursor`). حلقة حتى `SYNC_PULL_LOOP_MAX = 50` صفحة؛ عند كل صفحة يكتب cursor الجديد في meta ثم `applyChanges`.
- **تطبيق التغييرات (applyChanges)**: داخل معاملة IndexedDB على `tasks/sessions/events/meta` + المتاجر الإضافية الستة (`transactions/recurring/debts/debtPayments/categories/people/later`):
  - LWW أيضًا: يُتخطّى التغيير إذا كان في outbox محلي بنفس الطابع أو أحدث (`pend && pend.updatedAt >= at`)، وإذا كان محليًا بلا pend و `at < local.updatedAt`.
  - `session` بحذف: يحذف أحداثها ثم الجلسة. `event` بحذف: يتجاهل إذا كان الإدخال المحلي الـ pend نفسه حذفًا.
  - `meta` يطبَّق فقط عندما `id === "settings"`.
  - **فرع المتاجر الإضافية**: `SYNCED_STORES` (المسمى سابقًا `FINANCE_STORES`، وسُمّي كذلك لأنه كان يخدع قبل إضافة `later`) يحوّل `type` المفرد إلى اسم الـ store. نفس قواعد LWW بالضبط. على `debt` بحذف تُحذف كل سجلات `debtPayments` المرتبطة به (`deleteByDebt`) — لا يترك أي يتيم. الترتيب آمن لأن السحب يرجّع `rev` تصاعديًا، فدفعة الدفع تُطبَّق قبل tombstone الدين التي تمحوها.
  - (لا يوجد دمج على مستوى الحقول ولا CRDT — المقارنة دائمًا `updatedAt`.)
- **متى يحدث**: `setInterval` كل `SYNC_INTERVAL_MS = 30000` عند `navigator.onLine`؛ debounce 5s بعد أي `enqueue`؛ أحداث `online`/`focus`/`visibilitychange`؛ إعادة محاولة بفاصل تصاعدي (5s → 300s `MAX_BACKOFF`) بعد الفشل.
- **إعادة المصادقة**: على `401/403` يحاول `trySessionReauth` عبر `POST /api/auth/rotate` (يتطلب master key محليًا)، وينجح يعيد push+pull، وإلا `status = “unauthorized”, authRequired: true` ويوقف الحلقة.
- حالات `status` المخزّنة في meta: `not_configured | offline | syncing | idle | unauthorized | error`.
- إشعار cross-tab عبر `BroadcastChannel("task-timer-sync")` → `bus.emit("data-changed")`.

---

## 3) منطق المصادقة كما هو مطبّق (`api/auth.php` + `services/auth-service.js` / `crypto-service.js`)

### المساحات
- **create** (`POST /api/auth/create`): يتحقق من الشكل عبر `tt_read_auth_body`:
  - `code` يطابق `/^[A-Za-z0-9_-]{3,64}$/` وإلا `400 invalid_code`.
  - `password` ≥ 8 أحرف وإلا `400 password_too_short`.
  - `device.id` إجباري ≤ 128 حرفًا وإلا `400 invalid_device`.
  - الرمز مكرر → `409 space_exists`. ثم `insert spaces (code, password_hash=password_hash(password), created_at)`، تسجيل الجهاز (`tt_register_device`)، وبدء جلسة (`tt_start_session`).
- **open** (`POST /api/auth/open`): فحص حد المعدّل أولًا، ثم `SELECT id, password_hash FROM spaces WHERE code = ?` و `password_verify`. **نفس `401 invalid_credentials`** للرمز المجهول وكلمة السر الخاطئة (لا تسريب عدم الوجود). النجاح: مسح عدّاد الفشل، تسجيل الجهاز، بدء الجلسة.

### الجلسات (خادم)
- `tt_start_session`: `token = bin2hex(random_bytes(32))`؛ `INSERT sessions (space_id, token_hash = sha256(token), created_at, expires_at = now + SESSION_LIFETIME)` (86400 ثانية افتراضيًا)؛ ثم cookie.
- الـ cookie: `tt_session`؛ `HttpOnly`؛ `SameSite=Lax` على نفس الأصل، ويتحول إلى `SameSite=None; Secure` فقط إذا كان `ALLOWED_ORIGIN` مضبوطًا و `HTTP_ORIGIN` المطابق (وضع cross-origin عبر `TT_SESSION_CROSS_ORIGIN`)؛ `Secure` تلقائيًا في بيئة `production`.
- التحقق: `tt_session_space_id` يجلد `sha256(cookie_value)` ويبحث في `sessions`؛ الصف المنتهي (`expires_at <= now`) يُحذف كسولًا ويُعامل كلا-جلسة.
- **rotate** (`POST /api/auth/rotate`): يشترط جلسة صالحة، يحذف صف التوكن القديم، يصدر توكنًا جديدًا. يستخدمه العميل: مزامنة مجدولة كل `SESSION_ROOTATION_MS = 24h` (`authService.scheduleSessionRotation`) وعند `401/403` أثناء المزامنة.
- **logout** (`POST /api/auth/logout`): يحذف صف الجلسة ويمسح الـ cookie.
- **status** (`POST /api/auth/status`): `{ ok, authenticated, spaceId, deviceCount, expiresAt }`.

### Rate limiting
- `auth_failures` لكل IP (`tt_request_ip` = `REMOTE_ADDR`)؛ النافذة `rate_window = 900` ثانية افتراضيًا، والحد `rate_max = 10` — كلاهما قابل للتعديل عبر `RATE_WINDOW` / `RATE_MAX`.
- `tt_rate_fail` (INSERT … ON CONFLICT): داخل النافذة `count+1`؛ عند انقضاء النافذة يُعاد العد من 1 وتنزلق `window_start`.
- عند تجاوز الحد: `429 rate_limited` — حتى بكلمة سر صحيحة (مؤكَّد بالاختبار)؛ النجاح يمسح العدّاد.
- طبقة إضافية بـ nginx: `limit_req zone=api rate=10r/s burst=20 nodelay` على `/api/`.

### التشفير (عميل فقط — الخادم لا يمتلك أي مفتاح)
- مفتاح رئيسي AES-GCM 256-bit؛ يُولَّد عشوائيًا (`crypto.subtle.generateKey`).
- حمايته بكلمة السر: `deriveKEK(password, salt)` عبر PBKDF2-SHA-256، **600,000 تكرار**، salt 16 بايت؛ ثم encrypt للمفتاح بـ KEK. الحمولة `{v:1, d: base64(salt || iv || ciphertext)}`.
- حماية السجلات: `encryptData(masterKey, record)` → `base64(iv(12) || ciphertext)`؛ تُخزن في meta كـ `task-timer-encrypted-key`، والمفتاح نفسه في الذاكرة فقط (`authService.masterKey`).
- ملفات المزامنة `.sync.enc` (الإصدار 3): `{ app:"task-timer", version, code, createdAt, ek }` — `ek` هو المفتاح الرئيسي المشفّر بكلمة السر. استيراده يتطلب كلمة السر ليدير `decryptMasterKey`. كلمة السر لا تُخزَّن في أي مكان.

---

## 4) الطابور / العمل offline

- أي كتابة عبر الخدمات (task/session/finance/later/backup) تنتهي بـ `syncService.enqueue(type, id, op, data, updatedAt)`:
  - يسجل `{ key: type:id, type, id, op, data, updatedAt, enqueuedAt }` في outbox (IndexedDB).
  - يستدعي `scheduleEventSync()` (debounce 5s) — أثناء عدم الاتصال لا يوجد أي توقيت نشط (`syncNowInternal` يوقف الحلقة عند `navigator.onLine === false` مع `status:"offline"`).
- عند عودة الاتصال: أحداث `online`/`focus`/`visibilitychange` تطلق `syncNowInternal`، وتستأنف حلقة الـ 30 ثانية.
- الترتيب: `pushPending` أولًا (دفعات من outbox، تشفير، `sync/push`) ثم `pullAndApply` — أي تغيير محلي يذهب للخادم قبل سحب الغرباء، وتطبيق LWW يحمي الإدخالات غير المُرسَلة.
- الاستيراد (`backupService.importAll`) يعيد بناء outbox كاملًا من البيانات المستوردة (ويُفرّغ أي outbox سابق) — يعمل دون اتصال ويفرّغ الطابور عند عودة الاتصال.

---

## 5) نقاط يجب الانتباه لها عند التطوير مستقبلًا

- **تداخل اسم `sessions`**: على الخادم، `sessions` تعني جلسة المصادقة (token_hash + expiry)؛ على العميل، store `sessions` هي جلسات المؤقّت (segments/status/taskItems). عند العمل عبر الجانبين انتبه أي `session` تقصد. كما أن `events` بالعميل = أحداث جلسة المؤقّت ولا يوجد مقابل لها على الخادم سوى `records/store='event'`.
- **`activeSlot` محلي فقط**: للجلسة النشطة وجود فهرس unique بالعميل؛ يُستبعد قبل أي push (`stripActiveSlot`) وعند import/export backup — لا يُزامَن أبدًا، فلن ترى حقلًا مساويًا له على الخادم.
- **`RATE_WINDOW` مقروء من env**: `config.php` يقرأ `RATE_WINDOW` (افتراضي 900) بنفس نمط `RATE_MAX` — النافذة قابلة للضبط على أي مثيل.
- **ليست هناك أسطر تالفة حاليًا**: سطر الحارس داخل `task_timer_touch_device` في `api/sync.php` كان يحتوي `return本文将:` (تشويه بايتات أثناء التحرير) وصُحّح إلى `return;`، ونُظّف التعليق المشوّه في نفس الدالة.
- **السجلات المخزنة على الخادم مشفّرة بلا مفتاح**: الخادم يخزّن `data` كـ ciphertext فقط؛ لا يمكنه فكها ولا التحقق منها. أي ميزة مستقبلية تحتاج محتوى (فهارس/بحث/تقارير) لن تجد نصًا صريحًا في الخادم.
- **Tombstones تُنظَّف**: يوجد GC يدوي/عبر cron (`php api/gc.php` — انظر القسم 6). فترة السماح الافتراضية 30 يومًا أطول من أي انقطاع واقعي؛ الـ index `idx_records_gc (deleted, updated_at)` يدعم الفحص.
- **لا دمج للتعارضات سوى LWW**: المتعارف عليه `updatedAt` رقمي (ms). الأجهزة بدون ساعة مضبوطة أو بتحرير متزامن تفقد التحديث الأقدم — لا يوجد دمج حقلي ولا ACK per-record.
- **لكل طلب HTTP مهلة، ولا تُهمل**: `SYNC_REQUEST_TIMEOUT_MS = 20s` عبر `app/net.js: requestSignal`. هذا ليس ضبط أدب في الشبكة، بل ما يُبقي المزامنة حيّة. طلبٌ لا يستقرّ أبدًا (بوابة خاطفة، أو اتصال نصف مفتوح، أو هاتف يخرج من المدى في منتصف الطلب) يعلّق دورة المزامنة إلى الأبد، لأن راية «لا تدع دورتين تتداخلان» لا تُحرَّر إلا في `finally` لا يبلغه أحد. فكل محاولة بعدها تجد المزامنة مشغولة وتفعل لا شيء بصمت حتى إعادة تحميل التبويب. ومؤقّت الـ 30 ثانية يظلّ يطرق، والتطبيق يعرض «جارٍ المزامنة» بينما لا شيء يُزامَن. انقطاع المهلة يُسجَّل `network` — الرمز نفسه الذي تنتجه شبكة فاشلة — فيتولّاه الـ backoff القائم كما هو. و`auth-service.js` يطلب الإشارة نفسها لأن تدوير الجلسة يجري كل 24 ساعة.
- **`offline` يوقف الحلقة فورًا**: كان انقطاع الشبكة يُكتشف في بداية دورة فقط. فجهاز يدخل نفقًا يظلّ يحاول كل 30 ثانية طوال غيابه، وكل محاولة تفشل، وكل فشل يُطيل الـ backoff لعلّا يعود، والحالة المعروضة تبقى «خامل». الآن `setup()` يستمع `offline`، فيوقف الحلقة ويمسح الـ backoff ويكتب الحالة.
- **اكتبٌ في تبويب آخر يعني مزامنة، لا انتظار 30 ثانية**: `app/sync.js` يصدّر `onRemoteChange`، وهو منفصل عن `bus` عن قصد. الحافلة تحمل «تغيّر شيء في هذا التبويب»، وهو ما لا يردّ عليه sync-service لأن الكتابة التي سبّته جُدولت مزامنتها بنفسها. القائمة المنفصلة تحمل الشيء الوحيد الذي لا تنقله الحافلة: تغييرٌ وصل من تبويب آخر، يعرفه هذا التبويب ولا يدفعه. والاشتراك بالحافلة بدلًا منها يبدأ حلقة لا تنتهي: `applyChanges` يطلق `broadcastChange()`، فيجدول التبويب الآخر مزامنة، فيسحب ما طُبِّق عليه للتو — طلب بلا فائدة بعد كل سحب فيه تغيير.
- **`setup()` غير قابل للاستدعاء مرّتين**: يضيف أربعة مستمعين ومؤقّتًا، واستدعاؤه مرّين يترك مؤقّتًا ثانيًا يعمل خلف ظهر الأول: دورتان تتسابقان على الراية نفسها، ونصف المُحفّزات تفعل لا شيء لأن الأخرى سبقتها. `setupDone` في أعلى الملف. (نفس الحارس أُضيف إلى `store.init` يومها وصُحّح سهوُه هنا.)
- **`meta` يؤخذ من أي جهاز**: pull يطبّق `records` من نوع `meta` مع `id==="settings"` ويستبدل إعدادات الجهاز المحلي بالكامل.
- **`test:client` يعمل الآن**: `package.json` يستدعي `node --test tests/*.test.mjs` وأصبح `tests/` موجودًا باختبارات node:test فعلية على الدوال النقية (validation / session-engine / time / analytics / config / finance) — `npm test` نجحت خطوة العميل.
- **الحد الموحّد على الحجم**: nginx `client_max_body_size 1m` يطابق `REQUEST_MAX_BYTES` الافتراضي (1 MiB / 1048576). رفع `REQUEST_MAX_BYTES` عبر env يتطلب رفع حد nginx معه (تعليق في `default.conf` يذكّر بذلك). في مسار dev router لا يوجد nginx — حد PHP وحده هو الفاعل.
- **المال بأعداد صحيحة**: كل المبالغ **وحدات صغرى** (عدد صحيح، `MINOR_UNITS = 100`) عبر `domain/money.js`. لا تخزّن ولا تُقارن ولا تجمع ولا تقرّب إلا بهذه الوحدة — الكسور العشرية في `float` ممنوعة (خطأ تقريب بنسبي).
- **لا حقل عملة في الواجهة**: المالية أحادية العملة بالتصميم. السجلات الجديدة تأخذ `DEFAULT_CURRENCY`؛ التعديل لا يعيد كتابة عملة سجل قائم إطلاقًا.
- **المدفوع/المتبقي للحساب محسوبان فقط**: `debts` لا تخلّص `amount` إلا كإجمالي أصلي؛ `paid`/`remaining` دالتان في `domain/finance.js: debtTotals` فوق `debtPayments`. لا تُخزَّن ولا تُزامَن.
- **القواعد الدورية ليست حركات مستقبلية**: لا `nextAt` ولا توليد مسبق. الجدولة = `anchorAt` + `frequency` + `skipped[]`، والتاريخ التالي مشتق في `nextDueAt`. الخطوة الشهرية تستخدم **يوم الشهر في `anchorAt`** (31 يناير → 28 فبراير → 31 مارس).
- **`debts` → `debtPayments` cascade في مكانين**: `financeService.removeDebt` محليًا، و`applyChanges` في `sync-service.js` على tombstone الدين. أي مسار حذف جديد للمالية يجب أن يمرّ بأحدهما.
- **`pages` → `pageItems` cascade في المكانين نفسهما**: `pageService.remove` محليًا (معاملة واحدة + `enqueueMany`)، و`applyChanges` على tombstone الصفحة. **عبرهما يجب أن يمرّ أي مسار حذف صفحة جديد**، وإلا بقي سطر لا يعرضه أي مسار شاشة بينما يظل يُزامَن — وجهاز ثالث يعيد ترتيب الصفحة يُحييه من جديد.
- **`pages.title` اختياري عمدًا**: الصفحة تُنشأ بلا عنوان وتُسمّى بعد فتحها، فرفض الفراغ يعني قسرًا على إنشاء `/pages/new`. العنوان الفارغ حالة حقيقية لا مدخلًا خاطئًا، ولهذا وُجد `oneLineTitle`/`oneLineText` في `validation.js` بلا قاعدة `required` على حقل العنوان.
- **`oneLineTitle` صار مشتركًا**: `validateLaterTitle` صار يفوّض إليه. أي حقل عنوان جديد (سطر، عرض) يستعمل الدالة نفسها بدل نسخ شرط `required` والحدّ الأقصى — وإلا تفرّق حدود العناوين بين الشاشات.
- **ترتيب `pageItems` بفهرس `pageId` وحده**: أي استعلام `s.index(...)` آخر على `pageItems` غير موجود ويكشفه الاختبار (`tests/pages.test.mjs`)، فالمتجر يُقرأ دائمًا `byPage` — لا عبر المفتاح الأساسي إلا في `get`/`put`/`delete` لسطر واحد.
- **`debtPayments.title` يُقبل `null`**: `assertFinanceRecords` يستدعي `assertFinanceRecords(..., { titleRequired: false })` لهذا الـ store تحديدًا — وإلا فشل استيراد نسخة احتياطية صالحة بخطأ `validation_failed`.
- **`withTx` يرفض `ConstraintError`**: أي معاملة IndexedDB يجب ألا تصير خاملة (لا `await` لـ WebCrypto داخلها) وإلا انتهت بـ `ActiveSessionExistsError`. `applyChanges` يفك التشفير **قبل** فتح المعاملة.
- **لا تُنتظر أي عملية خارج المعاملة داخل `withTx`** — لا `enqueue` ولا `fetch` ولا WebCrypto. الخمول يُنهي المعاملة تلقائيًا، وطلبٌ بعده يرمي `TransactionInactiveError`، فالكتابة التي ظنّ الكود أنها صارت تضيع. النمط الصحيح: اجمع ما ستكتبه داخل المعاملة، ثم صفّه إلى الـ outbox **بعد** إغلاقها (`categoryService.rename` / `sessionService.remove` / `financeService.removeRecurring`). و`withTx` الآن يرصد هذا: لو انتهت المعاملة و`fn` ما زال معلّقًا يرفض بـ `TransactionInactiveError` بدل أن يُبلغ نجاحًا كاذبًا.
- **حذف قاعدة دورية يفكّ ارتباط كل دفعاته**: `domain/finance.js: unlinkRecurringPayments` يشتقّ السجلات المفرَّطة (نفس السجلات بـ `recurringId: null`)، وتُكتب دفعةً دفعةً في معاملة واحدة. أي دفعة تبقى تشير إلى قاعدة محذوفة = رابط معلّق يفتح «غير موجود» من شاشة الحركة.
- **`later` لا فهرس له، وهذا مقصود**: المتجر محدود بـ 500 عنصر وكل شاشة تقرأه كاملًا (لأنها تُقسّمه «غير متابَع/متابَع»). أي `s.index(...)` على `later` يفشل عند التشغيل فقط — راجع `tests/finance.test.mjs` («كل متجر تقرأه الواجهة له فهارسه») و`tests/later.test.mjs`.
- **`later.title` مسمّى مرتين لو أُهملت**: `t("later.title")` هو عنوان الصفحة/القسم، وحقل العنوان الاختياري في النموذج هو `later.titleField`. تكرار `title` في نفس جدول i18n يجعل الثاني يبتلع الأول بصمت (ظهر فعلًا: صار عنوان الصفحة نص الحقل).
- **مشاركة النظام تُستهلك قبل الراوتر**: `consumeShareTarget()` في `ui/pages/later.js` تُستدعى من `boot()` **قبل** `router.start()`. الراوتر يطابق `location.pathname` فقط ثم يستبدل المسار، فصفحة تُركَّب على `/later/share?...` ستُنادي الراوتر من داخل `mount()` نفسه (استبدال راوتر داخل استبدال راوتر) وتترك سلسلة الاستعلام في العنوان لتُحفظ من جديد عند كل تحديث. الاستهلاك المسبق + `history.replaceState` يجعلان الحفظ مرة واحدة لكل مشاركة.
- **السقف المشترك على الخادم**: `later` و`page` و`pageItem` و`kanbanItem` و`routine` و`routineLog` تستخدم `$sharedCap` (نفس `MAX_FINANCE_RECORDS_PER_SPACE`). إن أضفت متجرًا غير أساسي جديدًا أضِف اسمه إلى نفس الحلقة — لا مفتاح env جديد ولا فرع quota جديد.
- **لا تُنشئ شكلًا جديدًا على شاشة واحدة**: أي رأس أو صفّ أو زرّ أو حالة فارغة يُبنى من `ui/components/ui.js` و`fields.js` (القسم 0). الصنف الجديد يذهب في `components.css` **مكوّنًا** له اسم ودلالة، لا كاستثناء داخل صفحة. `tests/ui.test.mjs` يمنع `class: "list-row"` و`class: "title"` و`class: "row"` خارج النواة.
- **لا تكتب `"M…"` خارج `ui/icons.js`**: أضف الاسم إلى `ICONS` واستعمل `uiIcon(name)`. خريطة أيقونات (`*_ICONS`) **أسماء لا مسارات**، والاختبار يفشل علىخلاف ذلك. لا تكتب `✕` ولا `✓` ولا `○` في DOM — استعمل `icon("close")` و`icon("check")` و`icon("minus")`.
- **لا تكتب `<select>` عاريًا**: كل واحد ملفوف بـ `selectControl()`، لأن السهم مرسوم بـ `inset-inline-end` لا بـ `100%` الفيزيائي.
- **نافذة واحدة فقط**: `dialog.confirm` / `dialog.choose` / `dialog.form`. كتابة `.dialog-backdrop` بيدك تعيد حرفةً ما أفسدته: لا Escape، ولا خروج على التنقّل، ولا حارس ضدّ حوار ثانٍ.
- **عتبة جديدة = سطر في `tokens.css`**: `tests/ui.test.mjs` يقرأ تعليق المقياس في `tokens.css` ويفشل على أي `@media` بقيمة خارجه.
- **قلب الأيقونات في `base.css` وحده**: `:root[dir="rtl"] .icon-flip`. لو أضفت `transform` إلى `.icon-flip` في `components.css` من غير شرط اتجاه، انقلب السهم في اللغتين.
- **لا تبعية وقت تشغيل، وهذه قاعدة مكتوبة**: `dependencies` في `package.json` **فارغة، و`tests/config.test.mjs` يفشل إن لم تبقَ**. التطبيق يُقدَّم network-first لجهاز قد يكون غير متصل أسبوعًا، كحزمة واحدة؛ وتبعية وقت تشغيل لا تفشل، بل تجعل الحزمة مخرجات مدير حزم بدل مخرجات هذا المشروع، وثمنها يدفعه المستخدم الأقدر على تحمّله. والتغيير الذي جرّب القاعدة هو بالضبط محرّر WYSIWYG: الجواب المعتاد مكتبة 30–80 KB، والجواب المأخوذ هنا محلّل من مئتين سطر يخزّن نصًّا. **إن صارت التبعية ضرورية يومًا، فالتصحيح حذف هذا الشرط بسببٍ مكتوب، لا إضافة مكتبة.**
- **`hasEstimate(session)` صار له بابان**: `!!(session.taskId || session.routineId) && session.estimatedMs > 0`. هذا هو التغيير الوحيد في `session-engine.js` وحجمه سطر واحد، وهو ما يعطي الموقوت عدّادًا تنازليًّا وتنبيهَ تجاوزِ تقدّم من الكود القائم بلا سطر جديد. أي تعديل آخر على هذا الشرط يعود إلى `tests/device.test.mjs` الذي يرفض إعادة صياغة القاعدة في أي موضع آخر.
- **صفُّ اليوم = صفٌّ واحد لكل (قاعدة، يوم)**: انظر القسم 14. القاعدة `logId = ${routineId}@${dayKey}` مشتقّة لا مولَّدة، والعدّاد يبدأ من جديد لأن اليوم صفٌّ جديد — فلا هناك مهمة منتصف الليل لتُنسى ولا حالة "متى آخر مرة" تُخزَّن وتُنسخ.
- **التشغيل يُنسب إلى اليوم الذي بدأ فيه لا اليوم الذي انتهى فيه — وكلاهما يقرأ `startedAt`**: `routineService.today()` يضع حدًّا أدنى على `sessions.startedAt` عبر `sinceStarted(startOfDay)`، و`todayView` يقارن `dayKey(s.startedAt)`. تشغيل بدأ ٢٣:٥٠ وانتهى ٠٠:١٠ هو تشغيل الأمسية التي بدأ فيها. لو قارنت المطابقةُ بـ`endedAt` والقراءةُ بـ`startedAt` لوقع التشغيل في **لا يومٍ إطلاقًا** — وهو الجواب الوحيد الذي لا يمكن الدفاع عنه. اختبار `a run belongs to the day it was started` يحرس القاعدة من الجهتين.
- **`sessions` بلا فهرس `routineId`** — والسبب مُثبت: `routineService.today()` يقرأ عبر `sinceStarted(startOfDay)` لا عبر getAll، و`routineActivity` في التقارير تصفّي الجلسات كلها كما تفعل `completedTaskCount` و`dayStreak`. فهرس على `routineId` كان سيكون وعدًا لا يستهلكه أي مسار قراءة، وهو الانحراف نفسه الذي حذف فهرس `later` من رفقته. (و`sinceStarted` موجود أصلًا وفهرس `startedAt` يخدمه — انظر `app/js/app/store.js`.)
- **تذكير الـRoutine يُخزَّن ويُعرض، ولا يُجدوَل**: لا خادم push ولا مجدول في المشروع (انظر `notifications.js`: "التنبيه تفاعليٌّ لا مجدول")، ولهذا `reminderBeforeMs` و`reminderEveryMs` قيم من **قائمتين مغلقتين** (`ROUTINE_REMINDER_BEFORE` / `ROUTINE_REMINDER_EVERY`) تُقرأ في النموذج وتُعرض كشارة على الصف. أي عدد ساعات حرّ كان سيصبح وعدًا لا يستطيع التطبيق الوفاء به. **التذكير لا يفرض موعدًا ولا يبدأ جلسة** — وهذا شرط التصميم لا نقص: "الوقت اختياري وغير ملزم" يعني أن المستخدم يبدأ متى أراد.
- **لا `overdue` ولا `streak` ولا نسبة التزام في الأنشطة المتكررة**: هذه ليست قاعدة أسلوب بل شرط الميزة. `todayView` تعيد `{routine, count, target, done}` ولا شيء غير ذلك، و`routineActivity` في `analytics.js` تترك أي نشاط بلا حدث خارج التقرير. اختبار `no day but today can be asked about` في `tests/routine.test.mjs` يفشل إن أُضيف حقل `late` أو `overdue` أو `streak` someday.
- **`stat` و`badge` و`emptyState` و`pageHead` هي الأشكال الوحيدة** لتلك المفاهيم. `.stats` و`.stat` و`.badge` ليست ثلاثة مقاسات للشيء نفسه — ادمجها في `ui.js` لا في الصفحة.

---

## 6) إجراءات تشغيلية

### النسخ الاحتياطي لقاعدة SQLite
- القاعدة الافتراضية `api/var/sync.sqlite` (في Docker: حجم `sync-data` عند `/app/api/var`).
- تعمل بوضع **WAL** — عند النسخ انسخ الملفات الثلاثة معًا: `sync.sqlite` + `sync.sqlite-wal` + `sync.sqlite-shm` (أو استخدم SQLite backup API أثناء توقف الكتابة).
- توجد أداتا نسخ احتياطي داخل التطبيق نفسه (من الإعدادات): تصدير ملف `.enc` مشفّر بكلمة السر (`backupService.exportAll`) — الخيار الموصى به لأنه محمول ومشفّر، وملف مزامنة `.sync.enc` (`syncService.exportSyncFile`) لنقل المساحة بين الأجهزة.
- المجلد `api/var/` وملف `api/config.local.php` في `.gitignore`.

### الترحيلات (migrations)
- **الخادم (SQLite)**: ترحيل inline في `task_timer_schema` (`api/db.php`): إذا وُجدت `records` قديمة بلا عمود `space_id` (نسخة v1 قبل النطاق بالمساحات) تُبنى `records_new` وتُدمج الصفوف في المساحة رقم `1`، ثم تُستبدل. بخلاف ذلك `CREATE TABLE IF NOT EXISTS` للجداول الخمسة.
- **العميل (IndexedDB)**: `migrations.js` — `1` ينشئ stores (tasks/sessions/events/meta)، `2` ينشئ outbox، `3` يضيف فهرس `enc_key` على meta، `4` ينشئ stores المالية الأربعة (`transactions`, `recurring`, `debts`, `debtPayments`) بفهارسها، `5` ينشئ `categories`/`people` + فهرس `category` على `recurring`/`debts` و يبذر التصنيفات السبعة، `6` ينشئ `later` (بلا فهارس)، `7` ينشئ `pages` (بلا فهارس) و`pageItems` (فهرس `pageId`). `DB_VERSION = 7` في `config.js`، والترحيلات **مجمَّدة**: تعديل ترحيل مُصدَر يعني أن قاعدةً عند إصداره لن تمرّ بها هذه الترقية أبدًا. الترقية تزامنية داخل `onupgradeneeded` وتتمسح فقط (`objectStoreNames.contains`) — بيانات Stores القديمة لا تُمسّ ولا تُعاد كتابتها.
- **Later (Migration 6)**: ترحيل **إضافي بحت** كما كان 4 و5 — متجر جديد، ولا شيء قائم يُقرأ أو يُعاد كتابته. لا بذر ولا فهارس. الترقية من 5 مُتحقَّق منها على قاعدة حقيقية فيها مهمة وحركة مالية وإعدادات وسبعة تصنيفات: كل ذلك بقي كما هو، و`later` ظهرت فارغة، وكل الفهارس القائمة بقيت كما هي (`recurring`: `active`+`category`، `debts`: `category`+`direction`، `sessions`: الأربعة بما فيها `activeSlot` الفريد).
- **Pages (Migration 7)**: ترحيل إضافي بحت كالذي قبله. `pages` بلا فهارس (تُقرأ كاملة في شاشة القائمة)، و`pageItems` بفهرس `pageId` وحده — وهو ما تطلّبه القراءتان الوحيدتان: `byPage` و`deleteByPage`. لا بذر ولا تعديل لأي متجر قائم.

### أوامر الصيانة / الاختبار الموجودة
```sh
npm run test:api                 # php api/tests/run.php — اختبارات API تكاملية (منفذ عشوائي + DB معزولة)
npm run test:client              # node --test tests/*.test.mjs — اختبارات node:test على الدوال النقية (tests/)
php api/tests/rate-window-check.php   # تحقق مستقل من SQL نافذة rate-limit
php api/gc.php [--dry-run]       # GC للمُسارات (tombstones): حذف deleted=1 الأقدم من TOMBSTONE_GC_AGE
npm run build                    # إعادة بناء أصول الواجهة (app/dist)
docker compose up --build        # تشغيل الحزمة الكاملة
docker compose run --rm --entrypoint nginx web -t   # فحصُ إعدادات nginx (انظر أدناه)
docker build --target test .     # CI: يبني + يشغّل test:client
```

### فحصُ `nginx -t` — الخطوة التي لا تعوّضها أيّ اختبارات
```sh
docker compose run --rm --entrypoint nginx web -t
# nginx: configuration file /etc/nginx/nginx.conf test is successful
```
هذا الفحص **جزءٌ من كلّ تغييرٍ في `docker/nginx/default.conf`**، ولا يمكن استبداله بشيء:

- **`docker-router.php` ليس بديلًا.** يطبّق نفس سياسة التخزين المؤقّت بمنطقٍ مختلف، فلا يقرأ محرّك nginx ولا يكتشف خطأً نحويًّا فيه.
- **اختبارٌ يقرأ النصّ لا يكتشفه.** محرّك إعدادات nginx يقرأ `{` كبداية كتلة **حتى داخل نمط `location ~`**، فمكمِّل `{8}` بلا علامات اقتباس يُنهي الكتلةَ مبكرًا ويقرأ بقيّةَ النمط أمرًا (directive) مجهولًا:
  ```text
  [emerg] unknown directive "8}\.(?:js|css)$" in /etc/nginx/conf.d/default.conf:128
  ```
  وnginx **يرفض الإقلاع**: الحاوية تدخل دورة إعادة تشغيل، ولا يصل `docker compose up` إلى «يعمل». وقد مرَّ هذا سطرٌ واحدٌ بلا اقتباس مع كلّ الاختبارات خضراء، لأنّ `tests/build.test.mjs` يقرأ الملفّ نصًّا فيرى نمطًا سليمًا تمامًا. لذلك: **كلّ نمطٍ في `location ~` يحتوي `{` أو `}` يكون بين علامتَي تنصيص**، و`tests/build.test.mjs` يؤكّد ذلك، و`nginx -t` هو الدليل النهائي.
- **لماذا لا في `Dockerfile`**: `fastcgi_pass php:9000` تجعل nginx تحلّ اسمًا لا وجود له وقت البناء، فيفشل `nginx -t` داخل الـ build بـ`host not found in upstream "php"` ولا يمكن أن ينجح أبدًا. الحلّ: تشغيله حيث يُحلّ الاسم، أي مع `php` على شبكة compose.

### GC للـ tombstones
- `records` صفوف `deleted=1` (علامات الحذف) لا تُنظَّف تلقائيًا؛ `php api/gc.php` يحذف نهائيًا كل tombstone أحدثه `updated_at` أقدم من `TOMBSTONE_GC_AGE` ثانية (افتراضي 2592000 = 30 يومًا؛ يُقبل `--age SECONDS` أيضاً).
- **لماذا 30 يومًا (ولماذا لا تكون أقل)**: السحب يتم عبر cursor أحادي الاتجاه (`rev > cursor`). حذف tombstone قبل أن يسحبه جهاز انقطع يعني أن ذلك الجهاز لن يعرف بالحذف أبدًا، وقد «يستعيد» السجل لاحقًا عبر LWW عند دفعه. المزامنة تعمل كل 30 ثانية مع تراجع تصاعدي أقصاه 5 دقائق، ففترة سماح 30 يومًا تترك هامشًا هائلًا فوق أي انقطاع واقعي.
- `--dry-run` يعرض ما سيُحذف دون لمس أي شيء. لتقليص حجم ملف SQLite بعد حذف كبير: `PRAGMA wal_checkpoint(TRUNCATE);` ثم `VACUUM;` يدويًا (يتطلب قفلًا حصريًا).
- الـ index `idx_records_gc ON records (deleted, updated_at)` (في `task_timer_schema`) يجعل فحص GC وعدّادات tombstones سريعة.
- healthcheck: `GET /api/health` → `{"ok":true,"time":…}` (نقطة عامة بلا أي معلومة حساسة).
- بيئة `ENVIRONMENT=development` في docker-compose.override تُفعّل وضع non-production (cookie بدون `Secure` تلقائي).

---

## 7) ختم الإصدارات (release)

الإصدار الحالي **`1.2.0`** (2026-09-27) — على خط الأساس المستقر `1.0.0`. وسم `v1.1.0` وُضع عند `279cc65` لكن `APP_VERSION` بقي `1.0.0` في الشيفرة يومها، فالانتقال في الشيفرة يقفز `1.0.0` ← `1.2.0` عمدًا: الرقم لا يُعاد على وسم قائم. تفاصيل ما تضمّنه في `CHANGELOG.md`.

### تسلسل الختم (نفسه لكل مرحلة قادمة)
1. **تأكّد أن الاختبارات تنجح فعليًا** — `npm run test:client` ثم `npm run test:api`. على Windows، إن كانت امتدادات `pdo_sqlite`/`mbstring` غير محمّلة (لأن تثبيت PHP يشحن بلا `php.ini`)، شغّل الأوامر بعد `$env:PHPRC="C:\Users\<your-user>\.php"` في الجلسة الحالية، أو `setx PHPRC "C:\Users\<your-user>\.php"` ثم أعد فتح الطرفية — وإلا أعاد كل طلب API خطأ 500 `could not find driver` ويفشل `test:api` كاملًا (وهذا خلل بيئة لا خلل في الكود).
2. **ابنِ الأصول**: `npm run build` ← `app/dist/app.<hash>.js` + `app/dist/app.<hash>.css` + `app/dist/index.html`. **الاسمان يحملان هاشَ محتواهما، والصفحةُ مُولَّدة**: `app/index.html` قالبٌ لا يذكر أصلًا، و`app/dist/index.html` هو ما يخدمه `/` و`/index.html` وسقوط الـSPA. فلا تُنسخ ملفات يدويًا إلى `app/dist` أبدًا، ولا يُضاف `<script>` إلى القالب (انظر `tests/build.test.mjs`).
3. **افحص إعداد nginx بالحقيقة نفسها**: `docker compose run --rm --entrypoint nginx web -t` (فصل «أوامر الصيانة» أعلاه). لا تثق باختبارٍ يقرأ النصّ: نمطٌ بلا اقتباس يُخرج الحاوية من الخدمة بلا أن يتغيّر لونُ أيّ اختبار. ثم `docker compose up --build` وتأكّد أنّ `web` عنده `(healthy)`.
4. **صحّح رقم الإصدار**: `APP_VERSION` في `app/js/config.js` و`version` في `package.json` (مصدران لا واحد). الرقم معروض في **الإعدادات** أسفل الصفحة.
5. **سجّل التغييرات** في `CHANGELOG.md` (الجديد / المتغيّر / المعروف) وأضف سطر الإصدار في `README.md`.
6. **commit ثم tag مُعنون**:
   ```sh
   git commit -am "release: v1.0.0"
   git tag -a v1.0.0 -m "Tadkhir v1.0.0 - stable baseline"
   git push origin master --tags
   ```
7. **أرشيف مستقل**: نسخة مضغوطة من المصدر + `app/dist` المبني، بلا `node_modules` و`.git` و`api/var` و`api/config.local.php` — انظر «سكربت الأرشفة» أدناه.

### سكربت الأرشفة
`git archive` يصدّر الحالة المُصنَّفة فقط (بلا `node_modules`، وبلا `api/var` لأنه مُستثنى أصلًا):
```sh
git archive --format=zip --prefix=tally-v1.0.0/ -o ../tally-v1.0.0.zip v1.0.0
```
هذا الأرشيف لا يحتوي `app/dist` (مُستثنى في `.gitignore`)، فللحصول على حزمة **قابلة للتشغيل مباشرة** (لها `dist` مبني وجاهزة للنشر بـ nginx أو `php -S`) خُذ نسخة العمل نفسها بعد `npm run build` واطبعها في zip مع استثناء `node_modules` و`.git` و`api/var` و`api/config.local.php`. والقاطرةُ الآن ثلاثةُ ملفّات لا اثنين: الحزمة والصفحةُ المبنيّة `dist/index.html` — **ومن نسخ `dist` بلا صفحةٍ مبنيّة خدم قالبًا لا يحمّل شيئًا**.

### ما لا يُرقَّم مع الإصدار
- `DB_VERSION` (7) — إصدار قاعدة IndexedDB عند العميل: ترحيل بيانات، لا علاقة له بإصدار التطبيق.
- `sync.enc version` (4) — صيغة ملف المزامنة نفسها؛ القارئ يقبل v3 القديم (انظر `tests/sync-file.test.mjs`). لا ترفعه إلا مع بقاء دعم القراءة للنسخة القديمة.
- `records.rev` على الخادم — تسلسل داخلي للمزامنة (cursor) لا علاقة له بالإصدار الدلالي.
- Service Worker: كاش واحد اسمه `task-timer-v<APP_VERSION>` واستراتيجية network-first، فلا حاجة لاسم كاش جديد عند كل إصدار؛ النسخة الجديدة تُلتقط مع أول طلب ناجح.
- `backup.enc version` (1) — مفاتيح المالية **و**Later **و**الصفحات **مضافة/اختيارية** داخل الصيغة نفسها، فلم يتغير رقم النسخة: لا كسر في أي اتجاه (ملف v1 جديد يُقرأ على القديم، وملف قديم بلا مالية/لاحقًا/صفحات يُقرأ على الجديد).

---

## 7-ب) لماذا بقي الاسم القديم `task-timer` في المعرّفات التقنية

التطبيق صار اسمه **Tadkhir**، لكن اسمًا تقنيًا باقيًا عن قصد. هذه القائمة ليست إهمالًا، وكل بند منها **تغييرُه يكسر شيئًا للمستخدم**:

| المعرّف | المكان | لماذا بقي |
|---|---|---|
| `DB_NAME = "task-timer"` | `app/js/config.js` | اسم قاعدة IndexedDB. تغييره يجعل التطبيق يبدأ بقاعدة **فارغة** ويبدو كأن كل البيانات ضاعت — وهي ليست في الجهاز. |
| `task-timer-master-key` / `-encrypted-key` / `-kek-salt` / `-owner-verifier` | `app/js/services/crypto-service.js`، و`ENCRYPTED_KEY_NAME` في `app/js/config.js` | مفاتيح التشفير في IndexedDB. تغييرها يجعل التطبيق **لا يجد مفتاحه** فيرفض فتح البيانات المشفّرة. |
| `data.app === "task-timer"` | `app/js/domain/validation.js` | مُعلِّم صيغة ملفات **النسخ الاحتياطي `.enc`**. تغييره يجعل كل نسخة احتياطية قديمة تُرفض بـ `wrong_app`. |
| `SYNC_FILE_APP = "task-timer"` | `app/js/services/sync-file.js` | مُعلِّم صيغة ملف **المزامنة `.sync.enc`** — نفس المنطق، وهو الملف الذي ينقل المفتاح إلى جهاز جديد. |
| `task-timer-<date>.enc` / `task-timer-<date>.sync.enc` | `app/js/services/sync-file.js` و`backup-service.js` | **اسم الملف** الذي يُنزَّل على جهاز المستخدم. تغييره يجعل الملفات القديمة تبدو من'application آخر. |
| `CACHE = "task-timer-v…"` | `app/sw.js` | اسم ذاكرة Service Worker. تغييره يمسح ذاكرة إصدار ويلغي العمل دون اتصال — وهو **سلوك مقصود عند كل إصدار**، لا عيب. الاختبار `tests/config.test.mjs` يربطه بـ`APP_VERSION`. |
| `"task-timer-sync"` | `app/js/app/sync.js` | اسم `BroadcastChannel` للإخبار بين تبويبات المتصفح نفسه. لا يعبر الأجهزة ولا يُرى. |
| `TAG = "task-timer-session"` | `app/js/app/notifications.js` | وسم إشعار واحد حيّ. تغييره يترك الإشعار القديم معلقًا على الجهاز. |
| `task_timer_*()` و`task_timer_config()` | `api/*.php` | **بادئة دوال PHP عامة.** تغييرها آمن وظيفيًا لكنه مسحٌ لملفات الخادم بلا فائدة للمستخدم: لا تظهر في الواجهة ولا في أي ملف يُصدَّر. أبقيناها لتفادي churn قبل أول إصدار عام. |
| `tt_session` | `api/config.php` | اسم كوكي الجلسة. تغييره يُخرج كل الجلسات المفتوحة. |
| `name: "task-timer"` | `package.json` | اسم حزمة npm خاصة (`"private": true`)، لا تُنشر ولا تُستورد من أي مكان. |
| `[task-timer-sync]` | `api/index.php` (سجلّ الأخطاء) | بادئة سطر في سجلّ الخادم فقط. |

**القاعدة للأجيال القادمة**: الاسم القديم مسموح في **المعرّف التقني الذي يحمل بيانات المستخدم أو يتصل بجهازه**، وممنوع في كل ما يراه المستخدم. متى لزم تغيير واحد من هذه مستقبلًا، فالتغيير آمن فقط مع **ترحيل صريح** ينقل القيم القديمة — لا بإبدال النص.

أما **النصوص الظاهرة للمستخدم** — اسم التطبيق في الصفحة، و`apple-mobile-web-app-title`، واسم التطبيق القصير في الـmanifest، ونصوص الترحيب والتثبيت بالعربية والإنجليزية — فكلها تستخدم **Tadkhir** الآن.

---

## 7-ج) الـ CI — ما الذي يغطيه، ولماذا بهذا الترتيب

الملف `.github/workflows/ci.yml`، على كل `push` و`pull_request`، بصلاحيات **قراءة فقط**، بلا أسرار، ولا ينشر شيئًا.

| Job | الخطوات | لماذا |
|---|---|---|
| `verify` | `npm ci` ← **بناء** ← `test:client` ← `check:i18n` ← `test:api` ← فحص `app/dist/` | نفس أوامر التشغيل المحلي، على Node 22 وPHP 8.5 — أي إصدارَي صور Docker. |
| `docker` | `docker build --target test .` ← `docker compose config --quiet` ← `docker compose build` ← `nginx -t` | ليس تكرارًا لـ`verify`: الاختبارات هنا تعمل على `node:22-alpine` داخل الصورة، و`nginx -t` هو المحلّل الحقيقي. و`compose config` يتحقّق من صحّة الملفين معًا قبل البناء. |

**ترتيب «البناء قبل الاختبارات» ليس اعتباطًا.** أربعة اختبارات في `tests/build.test.mjs` تقرأ `app/dist/` وتتخطّى نفسها إن كان مفقودًا — الشرط `{ skip: !built && "run npm run build" }` يبدأ عند سطره 57، و`built` يُحسب في السطر 32. فتشغيل الاختبارات أولًا على نسخة نظيفة يعطي **446 ناجحًا و4 متخطّاة** بدل 450 — رقم يبدو ناجحًا وهو ناقص. البناء أولًا هو ما يجعل الـ450 تعني شيئًا.

**الإصدارات مثبّتة على ما في المشروع فعلًا**: `node-version: "22"` مقابل `node:22-alpine` في `Dockerfile`، و`php-version: "8.5"` مقابل `php:8.5-fpm-alpine`. `engines` في `package.json` يقول `>=20`، فالصورة هي المرجع.

**ما لا يغطيه الـCI عن قصد**:
- **`deploy/hosting-nginx.conf` لا يمرّ على `nginx -t`**: قالب مليء بـ`{{…}}` الخاصة بلوحة استضافة بعينها، فلا يستطيع nginx قراءته قبل ملئها على ذلك المضيف. يبقى ضمن تحقق الإصدار. و`tests/build.test.mjs` يقارنه نصًّا بإعداد الحاوية.
- **النشر**: لا شيء هنا ينشر.

**حارس clean checkout**: `deploy/hosting-nginx.conf` كان ضمن `deploy/*` في `.gitignore` بينما `tests/build.test.mjs` يقرأه — أي أن `npm test` كان يفشل على أي نسخة نظيفة بخطأ `ENOENT`. أُزيل `deploy/*` من `.gitignore`، وصار الملف ضمن المتتبَّع. عند إضافة أي ملف يقرأه اختبار، تأكّد أنه سيُرفع.

**عيبٌ في الاختبار لا في التطبيق**: `tests/net.test.mjs` كان ينتظر حدث `abort` من `AbortSignal.timeout` ومؤقّتُه **غير مرجَع** (لا يُبقي حلقة الأحداث حيّة). في المتصفّح لا يظهر ذلك — الصفحة حيّة دائمًا، وطلب شبكة حقيقي يُبقي الحلقة بنفسه — لكن على Node 22 تُفرَّغ الحلقة أولًا فيلغي `node --test` الاختبار المعلّق ويخرج 1. أُضيف `keepAlive()` إلى ذلك الملف وحده، والسبب مكتوب في تعليق هناك. السلوك المُختبَر لم يتغيّر، ولم يُمسّ `app/js/app/net.js`.

---

## 8) الوحدة المالية (Finance) كما هي منفَّذة

### الطبقات (نفس نمط بقية التطبيق بالضبط — لا بنية موازية)
- **نقي (بلا I/O)**: `domain/money.js` (وحدات صغرى + تنسيق `latn`) و`domain/finance.js` (كل منطق الجدولة والحساب).
- **تحقّق**: ثوابت وحدود المالية في `domain/validation.js` مع `validateFinanceTransactionInput` / `…RecurringInput` / `…DebtInput` / `…DebtPaymentInput` و`assertFinanceRecords`. لا استيراد من `finance.js` إلى `validation.js` ولا العكس — لا دورات.
- **تخزين**: `data/transactions.repo.js`, `data/recurring.repo.js`, `data/debts.repo.js`, `data/debt-payments.repo.js` — نفس عقد الـ repo الموجودة (بدون منطق أعمال).
- **خدمة واحدة**: `services/finance-service.js` — جانب القراءة (قوائم، مجاميع، تذكيرات) وجانب الكتابة (CRUD + `markRecurringPaid` + `skipRecurring` + `setRecurringActive` + دفعات الدين + `removeDebt`/`removeRecurring` المتتاليان). كل كتابة تنتهي بـ `syncService.enqueue(...)` ثم `notify()`.
- **واجهة**: `ui/pages/finance.js` (نظرة عامة) + `finance-transactions.js` + `finance-recurring.js` + `finance-debts.js`، ومكونات مشتركة في `ui/components/finance-*.js` (حقول، صفوف، نموذج لكل نوع، شريط تبويب فرعي `finance-nav.js`). كلها على `ui.js`/`fields.js` — انظر القسم 0.
- **اختيار النوع والاتجاه = راديو بأيقونة**: حقول ذات إجابتين فقط (`financeTypeField` دخل/مصروف، و`financeDirectionField` مدين/دائن) **لا تُنتج `<select>`** بل `<fieldset class="icon-picker">` فيه `<input type="radio" class="sr-only">` لكل خيار داخل `<label class="icon-option">`، والوجه المرئي هو `<span class="icon-face">` الذي يحمل أيقونة SVG ويُلوَّن من `input:checked + .icon-face`. باني واحد `icon-picker.js` يخدم الحقلين ومنتقي نوع «لاحقًا» أيضًا، فلا ازدواج. الراديو حقيقي عمدًا: أسهم لوحة المفاتيح و`aria` تعمل مجانًا. `name` يولَّد بعدّاد متسلسل لا بالصفحة — صفحة الدين تحمّل نموذج تعديل بجانب نموذج دفعة، واسم مشترك كان سيشوّش بينهما.
  - **لغة الأيقونات**: `TYPE_ICONS` و`DIRECTION_ICONS` في `finance-fields.js` **خريطة أسماء** إلى `ICONS` في `ui/icons.js` — لا بيانات مسارات هناك. `moneyIn`/`moneyOut` سهم صاعد/هابط فوق خط أساس (حساب)؛ `owedToMe`/`owedByMe` نفس السهم مع **كفّ** في الجهة التي يسير منها المال — «مدين لي» الكفّ تحت والسهم صاعد، «أنا مدين» الكفّ فوق والسهم هابط؛ انعكاس رأسي تام. الرسم بالخطوط لا بالتعبئة فيتبع لون الثيم على الوجه المختار والمحدَّد معًا، وكل الإحداثيات داخل `viewBox="0 0 24 24"`. و`uiIcon` يرمي على اسم مجهول، فخطأ إملائي في الاسم يفشل عند أول رسم بدل أن يترك مربّعًا فارغًا.
- **تسمية الاتجاه تُؤخذ من القيمة**: `directionLabel(direction)` واحد في `finance.js` و`finance-debts.js`. كان في `finance.js` توقيعان مختلفان للاسم نفسه — واحد يأخذ دينًا وآخر يأخذ اتجاهًا — فكان `d.direction` دائمًا `undefined` في ملخّص المالية، وكل صفّ يقرأ «أنا مدين» أيًّا كان اتجاهه الحقيقي.
- **نوعان من الحقول الزمنية**: `financeDateTimeField` (`datetime-local`، يملأ نفسه بالوقت الحالي تلقائيًا) لـ `occurredAt` في الحركة ودفعة الدين — لحظة حدثت فعلًا؛ و`financeDateField` (`date`) لتاريخ استحقاق الدين ونقطة ارتكاز الدورية — يوم تقويمي، لأن `nextOccurrence` يبني من `anchor.getDate()`. ودوال `domain/time.js` هي `toDateTimeInputValue` / `fromDateTimeInputValue` (تبني من أجزاء محلية صراحةً، لأن `new Date("…T14:35")` يُفسَّر UTC فيزيح اللحظة) و`formatDateTime` للعرض.

### قواعد مُطبَّقة
- **الدورية قاعدة لا توليد مسبق**: «تم الدفع» ينشئ `transaction` حقيقيًا يشير بـ `recurringId`؛ «تخطّي» يضيف الطابع الزمني إلى `skipped[]`؛ وسجل الدفعات يقرأ من الحركات المرتبطة + المتخطّاة. لا يوجد أي صف حركة مستقبلية.
- **لا تجاوز في الدفع**: `assertPaymentFits` يُفحص مرتين — مرة في النموذج (رسالة فورية) ومرة **داخل معاملة IndexedDB** في `financeService.addDebtPayment` (سباق جهازين لا يمرّر).
- **لا ارتباط تلقائي بدفعات الدين**: في النسخة الأولى دفع الدين **ليس** حركة مالية (`recurringId` لا يُملأ تلقائيًا) — قرار مقصود لفصل السجلّين.
- **لا إشعارات دفع**: لا يوجد نظام push في المشروع أصلًا، فالتذكيرات تُخزَّن (`reminderAt`) وتُعرض فقط.
- **التصفية داخل الصفحة**: الراوتر يطابق المسار فقط (بلا query string)، فتصفية الفئة حالة داخل الصفحة، وشرائح مجاميع الفئات أزرار تبديل.
- **النسخ الاحتياطي**: `BACKUP_STORES` + `FINANCE_LIMITS` + `normalizeFinance` في `backup-service.js`؛ الاستيراد يُعاد بناء الـ outbox من كل السجلات المستوردة بما فيها المالية.

---

## 9) خدمة «لاحقًا» (Later) كما هي منفَّذة

أصغر خدمة في المشروع عمدًا: حاوية مستقلة يحفظ فيها المستخدم أي شيء يريد الرجوع إليه، **بلا** أي صلة بمهمة أو جلسة.

### الطبقات (نفس نمط المالية بالضبط — لا بنية موازية)
- **نقي (بلا I/O)**: `domain/later.js` — `createLaterItem`، `splitLater`، `isDone`، `hostOf`، `laterLabel`، و`fromSharePayload` (تحليل حصة المشاركة).
- **تحقّق**: `validateLaterInput` و`assertLaterRecords` و`LATER_TYPES` / `MAX_LATER_ITEMS` / `MAX_LATER_URL` في `domain/validation.js`. استيراد أحادي الاتجاه: `later.js` يستورد من `validation.js` فقط.
- **تخزين**: `data/later.repo.js` — نفس عقد الـ repo، بلا فهارس (انظر القسم 5).
- **خدمة واحدة**: `services/later-service.js` — قراءة (`list` تُرجع `{open, done}`، `get`، `count`) وكتابة (`create`، `createFromShare`، `update`، `setCompleted`، `remove`). كل كتابة تنتهي بـ `syncService.enqueue("later", …)` ثم `notify()`.
- **واجهة**: `ui/pages/later.js` (قائمة + `/later/new` + `/later/:id` + `consumeShareTarget`) و`ui/components/later-form.js` و`ui/components/later-row.js`. منتقي النوع يستعمل `ui/components/icon-picker.js` — نفس منتقي المالية (مستخرَج منه ليُعاد استخدامه، لا منسوخ): سلسلة/ورقة.

### قواعد مُطبَّقة
- **النوع أولًا**: `type` يقرّر أي جسم مطلوب — `link` يحتاج `url`، و`note` يحتاج `content`. وملاحظة **لا تحتفظ برابط أبدًا**، فتحويل عنصر من رابط إلى ملاحظة لا يحتاج حقلًا ثانيًا لتفريغه.
- **الرابط يُخزَّن مطلقًا و`http(s)` فقط**: `validateLaterUrl` يضيف `https://` إن كُتب بدون مخطّط، ويرفض `javascript:`/`data:`/`mailto:` (مشاركة النظام مدخل غير موثوق). رابط مكسور لا يصل إلى `href` أصلًا.
- **«تمت المتابعة» ختم واحد**: `completedAt` أو لا شيء — لا علم بجانب تاريخ يمكن أن يتناقضا. `setCompleted` كتابة لا‑عمل إن كانت الحالة هي نفسها (لا زحام سجلات ولا حركة مزامنة بلا داعٍ).
- **الترتيب مشتقّ لا مخزَّن**: `splitLater` يرتّب في كل قراءة — غير المتابَع بـ `createdAt` تنازليًا، والمتابَع بـ `completedAt` تنازليًا، وكسر التعادل بـ `id` (ترتيب محلي لا يُوثَّق عبر الأجهزة).
- **نوع واحد للإضافة**: الحقل السريع في الصفحة يُمرّر نصه إلى `fromSharePayload` — نفس المُحلِّل الذي يخدم مشاركة النظام. مسار واحد وقواعد واحدة، لا «إضافة سريعة» و«مشاركة» تنحرفان عن بعضهما.
- **`title` اختياري في كل مكان**: العنصر بلا عنوان يعرض **اسم المضيف** (لرابط) أو **أول سطر** من نصه — `laterLabel` في `domain/later.js`، والقالب في `later-row.js` (السطر الثاني لا يكرّر الأول: رابط بعنوان يُظهر اسم مُضيفه، ورابط بلا عنوان يُظهر سبب حفظه).
- **الاستقلال**: لا يقرأ `later` ولا يكتب أي متجر آخر، ولا يفهم منه `tasks`/`sessions` شيئًا. الربط بخدمات أخرى مستقبلًا ممكن بلا فرض أي ربط الآن.

---

## 10) خدمة «الصفحات» (Pages) كما هي منفَّذة

طبقة تنظيم فوق الخدمات القائمة، **لا بديل عنها ولا نسخة منها**: صفحة حرة تحمل — بالترتيب الذي يختاره المستخدم — كلماتها (عناوين، فقرات، فواصل) و**مؤشّرات** إلى سجلّات موجودة (مهام، جلسات، عناصر لاحقًا، سجلات مالية). المؤشّر هو التصميم كله: عنصر يشير إلى مهمةٍ تحمل `taskId` فقط، وكل تسمية وكل مبلغ وكل «هذا مكتمل» يعرضه **يُقرأ من السجلّ الأصلي لحظة العرض**. لا شيء يُنسخ، فلا تستطيع الصفحة أن تخالف ما تشير إليه.

### الطبقات (نفس نمط المالية وLater بالضبط — لا بنية موازية)
- **نقي (بلا I/O)**: `domain/pages.js` — `createPage`، `createPageItem`، `sortPages`، `sortItems`، `nextPosition`، `moveItem`، `linkFor`، `targetIdOf`، `itemText`، `pageLabel`، و`PAGE_ITEM_ROUTES`.
- **تحقّق**: `validatePageInput` و`validatePageItemInput` و`assertPageRecords` و`assertPageItemRecords`، و`PAGE_ITEM_TYPES` / `PAGE_ITEM_TARGETS` / `MAX_PAGES` / `MAX_PAGE_ITEMS` / `MAX_PAGE_TEXT` في `domain/validation.js`.
- **تخزين**: `data/pages.repo.js` و`data/page-items.repo.js` — الثاني وحده له `byPage` و`deleteByPage` عبر فهرس `pageId`.
- **خدمة واحدة**: `services/page-service.js` — قراءة (`list`، `get`، `count`، `items`، `load` لكل صفحة وأسطارها معًا) وكتابة (`create`، `update`، `remove`، `addItem`، `updateItem`، `removeItem`، `move`). كل كتابة تنتهي بـ `syncService.enqueue`/`enqueueMany` ثم `notify()`.
- **واجهة**: `ui/pages/pages.js` (قائمة + `/pages/:id`)، `ui/components/page-item.js` (سطر واحد بكل أنواعه)، `ui/components/page-picker.js` (منتقي السجلّ المرتبط)، `ui/components/page-records.js` (حلّ المؤشّرات إلى سجلّاتها).
- **أيقونات**: `PAGE_ITEM_ICONS` في `ui/components/page-item.js` (مصدر واحد يستورده `page-picker.js`): `heading`→`tag`، `text`→`note`، `divider`→`minus`، `task`→`tasks`، `session`→`clock`، `reference`→`bookmark`، `expense`→`wallet`. **لم تُرسم أيقونة جديدة** — كلها أسماء من `ICONS` القائمة.

### قواعد مُطبَّقة
- **نوعان في السجلّ، لا نوع واحد بمصفوفة**: الصفحة/items سجلّان منفصلان (Migration 7). إعادة الترتيب وتعديل النص واقعتان عن سجلّين مختلفين، وLWW يحسمهما باستقلال. مصفوفة `items` على الصفحة كانت ستجعل كل حفظ نصٍّ يعيد كتابة ترتيب الصفحة كلها.
- **الترتيب فهرس متّصل يُعاد رقمه عند كل نقل**، لا مواضع كسرية: `moveItem` يُخرج الصفوف التي تغيّر موضعها فقط — صفحة من أي طول = سطران لزر «لأعلى/لأسفل»— والصفوف خارج المدى تعود **الكائن نفسه** لا نسخة بتاريخ جديد، وهذا ما يسمح للخدمة أن تعرف ما يكتبه فعلًا. المواضع الكسرية («أدرج بين 3 و4») تحتاج ضغطًا دوريًا = شيء ثانٍ يُخطئ وشيء ثانٍ يُزامَن. نقل لا يغيّر شيئًا لا يكتب ولا يلمس `updatedAt`.
- **لا سحب وإفلات**: النقل بزرّي أعلى/أسفل. الزر معطّل على الأول والأخير بعنوان (`pages.first`/`pages.last`)، و`move` موجَّه إلى صفحة أخرى **لا يفعل شيئًا** بدل أن يرمي — سطر لا في ترتيب تلك الصفحة لا يمكن أن يُحرَّك.
- **العناوين الفارغة حالة مشروعة**: `oneLineText` بلا `required`، لأن قاعدة `required` كانت ستُبطل كل ضغطة backspace في حقل العنوان. الفقرة بـ `MAX_PAGE_TEXT`، والعنوان بـ `MAX_TITLE`، وكلاهما يُقصّ عند الحفظ. الحفظ التلقائي (debounce ‏500ms + عند مغادرة الحقل) **بلا إعادة بناء للصفحة** — العنوان في `<span>` حيّ، وإعادة البناء كانت ستقفز بمؤشّر الكتابة وتطيح بالصف.
- **المؤشّر إلى أصل محذوف حالة سليمة لا تالفة**: يُعرض سطرًا باهتًا «الأصل لم يعد موجودًا» بلا `href` — يبقى قابلًا للنقل والحذف. الاختبارات تثبت أن كل شاشة يفتحها سطر صفحة مسارٌ حقيقي (`PAGE_ITEM_ROUTES`).
- **الواجهة لا تلمس الـ repo**: `ui/components/page-records.js` يحلّ المؤشّرات عبر **قراءة الخدمات القائمة**، و`resolveAll` يحمّل كل خدمة **مرة واحدة كحد أقصى** وخدمةً واحدة فقط إن كانت الصفحة تحوي من ذلك النوع. صفحة بلا مهام ولا جلسات تعمل كاملة، ولهذا هي الحالة المختبَرة لا استثناء.
- **لا مسار `/pages/new`**: زر «صفحة جديدة» في القائمة يُنشئ صفحة بلا عنوان ثم ينتقل إلى `/pages/:id` حيث يُركَّز حقل العنوان. شاشة إنشاء تُلغي العنوان الاختياري الذي لا لزوم له.

---

## 11) النصّ المنسّق — لماذا لا مكتبة WYSIWYG (`domain/rich-text.js`)

محرّر نصوص كامل (Quill ونحوها) سطح `contenteditable` يخزّن HTML أو مستند JSON خاصًّا به. كان سيكلّف هذا المشروع ثلاثة أشياء قرّر ألا ينفقها، وكلها معمارية لا تجميلية:

1. **الحزمة**: محرّر WYSIWYG 30–80 KB قبل الضغط، وتطبيق العميل كله ملفٌّ واحد (~247 KB) يُقدَّم network-first لهاتف قد يكون غير متصل أسبوعًا. المحلّل والمحرّر والعارض كلّهم جزء من هذا البند، والحزمة كلها زادت 6 KB فقط.
2. **ما يسافر**: كل حقل نصّي في التطبيق يخزّن **نصًّا** (`content.text`، `description`، ملاحظة «لاحقًا»). تخزين HTML يضخّم كل حمولة مزامنة وكل ملفّ نسخة احتياطية عدّة مرّات، مقابل markup على العميل أن يقرأه ويفسّره من جديد. تخزين **المصدر** يُبقي نموذج البيانات والمتحقّقات والسقوف وصيغة النسخة الاحتياطية وبروتوكول المزامنة كما هي تمامًا — تعديل نصٍّ يبقى نصًّا يحسمه LWW.
3. **الشيء الوحيد الذي لا يحتمله التطبيق**: مصرف HTML. **لا يوجد `innerHTML` في هذه الشيفرة**، و`h()` لا يصنع إلّا عُقدًا نصّية، فلم يدخل نصّ المستخدم إلى الـ markup ولا مرّة. ومحرّر WYSIWYG يُنتج HTML يجب تحليله وتنقيته في مكان ما، أي أوّل مصرف في المشروع. أمّا هنا فتُحوَّل التوكيلات إلى عناصر بالمصنع نفسه، فلا يزال لا يوجد مكان يستقبل نصًّا.

### المجموعة عمدًا صغيرة، وكل استبعاد قرارٌ لا نقص
- **بلا عناوين (`#`)**: للتطبيق مفهومُ عنوانٍ واحد — سطر صفحة من نوع `heading` — وثانيٌ مخفيّ داخل فقرة يعني طريقتين لشيء واحد بنتيجتين مختلفتين. فيبقى `#` الحروف التي كتبها المستخدم.
- **بلا HTML خام**: `<b>` خمسة أحرف. من لصق HTML يريد أن يراه، والحالة المهمة (نصٌّ جاء من مشاركة أو لصق) يُقرأ أوضح كحروف منه كـ markup صامت.
- **بلا تداخل**: عريضٌ داخل رابط غير مدعوم، لأن دعمه يحوّل مسحًا واحدًا من اليسار إلى اليمين إلى محلّلٍ له مكدّس ومجموعة أنماط فشل. **وكل علامةٍ لا تُطابق تبقى نصًّا، دائمًا.**
- **بلا صور**: بايتات، ووعد هذه الميزة كلّه أن الصفحة تخزّن مؤشّرات وكلمات لا نسخًا.

### القواعد
- **`safeHref` وحدها تقرّر وجهة الرابط**: `http`/`https`/`mailto` فقط، ولا محرف تحكّم. وما ترفضه السياسة **يبقى نصًّا**، فملاحظة تستشهد بـ `[x](javascript:…)` تُقرأ كاقتباس لا كخطر.
- **الرابط الشارد يُقصّ من نقطته**: `https://a.dev/x.` رابط 404 يبدو تمامًا كرابط صحيح، فيُعطى النصُّ ما بَقِيَ من الجملة **و** يُعطى `href` الرابطَ المقصوصَ لا كاملَ ما التقطه المسح.
- **محتوى كل علامة يبدأ وينتهي بغير العلامة نفسها**: هذا القيد الواحد هو ما يمنع القراءات المَرَضية — بدونه `***` خطأٌ مائل حول نجمة، و`*` محاولةٌ لتعليم لا شيء. وبه، سلسلةُ علامات متماثلة نصٌّ عادي، وهو ما قصده كاتبها.
- **`_` محميّة من الطرفين**: `_` تظهر داخل الكلمات العادية (`some_var_name`)، والقاعدة على الحرفين معًا، وفئة `\p{L}` لتغطية أي كتابة لا اللاتينية وحدها.
- **التوكيلات مسطّحة**: كل `kind` إلى وسمٍّ مغلق، و`kind` غير معروف **نصّ**. فلا يصبح نوعٌ جديد عنصرًا غير متوقّع بالخطأ.
- **لا فهرسة سطر، والشرط سطرٌ يبدأ أو ينتهي بغير العلامة** — اختبارٌ على أطول مدخل يحمله التطبيق (4000 حرف)، لأن محللًا يتدهور على المدخل الطويل يفشل على الملاحظات تحديدًا، وعلى الملاحظات وحدها.

### التحرير والعرض
- **`ui/components/markdown-editor.js`**: `textarea` + شريط خمسة أزرار + معاينة حيّة. يُحفَظ المصدرُ لا المستند، فيبقى السجلّ نصًّا.
- **الشريط والمعاينة يظهران بـ `:focus-within` في CSS لا في JavaScript**، والمعاينة تُفرَّغ عند فقدان التركيز: صفحة تحتمل ألف سطر، وألف شريط وألف شجرة معاينة في المستند = ألف ضعف عملٍ لحقولٍ لا ينظر إليها أحد.
- **كل تعديل ينتهي بحدث `input` حقيقي**، فيرى المستدعي الحفظَ التلقائي، ولا يُكتب شيء حول الحقل — وهذا ما يبقي مؤشر الكتابة مكانه.
- **`Ctrl/Cmd+B` و `I` و `K`**؛ و`Enter` في عنوانٍ يُغادر الحقل لأنه سطرٌ واحد؛ و`Ctrl+Enter` يُرسل النموذج (ملاحظة «لاحقًا»).
- **`rowAction` لا `action`**: الأزرار بلا كلمات، فالكليمة هي الاسم المُتاح **و** التلميح. و`action` بكلمة يضعها في التلميح فقط — صحيح لزرٍّ يُظهرها، خطأ لزرٍّ لا يُظهرها.
- **المعاينة `aria-hidden`**: تكرارٌ لحقل المستخدم داخله، ولا يصحّ أن يقرأه قارئ الشاشة مرّتين.
- **التصميم** في `components.css` تحت `/* ---- Rich text ---- */`: كتلة `.prose` للقراءة، و`.md` للتحرير.

### التحقّق
- **`tests/rich-text.test.mjs` (35 اختبارًا)** يحمي ثلاثة أشياء بترتيب: **لا شيء يُفقد** (علامةٌ لا يفهمها المحلّل تبقى حروف المستخدم)، **لا markup يُخترع** (`<` و`&` نصّ، ولا سلسلة HTML في الوحدة أصلًا)، **ولا رابط خارج السياسة**.
- **فحصٌ يدوي في المتصفح** (لا غلاف DOM في المشروع، فلا تغطّي الاختباراتُ وحدةَ الواجهة): أنشأت صفحة، وراجعت الأزرار والاختصارات وما صُرِف إلى IndexedDB. كشف هذا شيئين لم تكشفهما الاختبارات: أزرار الشريط بلا `aria-label` (استُخدم `action` بدل `rowAction`)، ومؤشّر الرابط درجةً واحدة قبل قوسه. **كلاهما مُصلَح ومُتحقَّق منه**، والقيمة المخزَّنة فُحصت مباشرةً فكانت نصًّا لا markup.

---

## 13) طبقة الجهاز — اهتزاز، إشعارات، إبقاء الشاشة، الكاميرا (`app/haptics.js` + `notifications.js` + `wake-lock.js` + `session-watch.js` + `capture.js`)

خمسُ وحداتٍ صغيرة، كلٌّ منها يملك قرارًا كان موزّعًا على أكثر من موضع. **لا مكتبة ولا تبعية**: كلُّها غلافٌ رفيع حول API موجودة أصلًا في المتصفّح، والفصلُ بينها هو ما يجعل اختبارَها ممكنًا بلا متصفّح.

### القاعدة التي تحكم الأربع

- **القدرة** (هل الـAPI موجودة؟) و**الميل** (هل يريد المستخدم؟) و**الصلاحية** (هل أجاب المتصفح؟) ثلاثةُ أشياءٍ منفصلة. `haptics` يقرأ الأولَين، و`notifications` الثلاثة، و`wake-lock` يأخذهما ويقرأ **«ليس false»** لا «=== true» — فسجلُّ إعداداتٍ كُتب بإصدارٍ أقدم لا يحمل المفتاح، والمفتاحُ الغائب يجب أن يعني «القيمة التي يشحن بها التطبيق» لا «false».
- **كلُّ شيءٍ هنا progressive enhancement بالمعنى الصارم**: جهازٌ بلا اهتزاز، أو متصفّحٌ بلا إشعارات، أو إذنٌ مرفوض، أو قفلٌ غير متاح — كلُّها تنتهي عند نفس المسار الهادئ، ولا يستدعيها شيءٌ في التطبيق. **ولا خطأً في الطرف الآخر**: كلٌّ منها تبتلع استثناءاتها، لأن جهازًا يعرض `vibrate` ثم يرمي ما زال جهازًا لا يستطيع الاهتزاز.
- **لا يوجد نمطُ «نقرة»**، وهذا شرطٌ لا نقصٌ في الجدول: نبضةٌ تعني شيئًا حدث، و«كلُّ ضغطةٍ تهتزّ» هي الطريقة التي تجعل المستخدم يتوقّف عن قراءة النبضاتِ التي تعني شيئًا. واختبارُ `there is no pattern for an ordinary tap` يكتب ذلك صراحةً حتى لا يُضاف نمطٌ عامّ في مراجعةٍ عابرة.
- **الاهتزاز ليس حركة**، فلا يُربط بـ `prefers-reduced-motion` — لا استعلامَ منصّة للحركة أصلًا. كتلةُ `base.css` تُسقِط كلَّ الحركات في التطبيق (ومنها نبضُ المسرح والشريحة) لأنّها في CSS لا في JavaScript. ولو استُعمل `element.animate()` لاضّ أن يُعيد فحص استعلام الوسائط بنفسه، وهذا وحده سببُ اختيار سمةٍ بدل استدعاء.

### `haptics.js` — النمطُ هو الاسم

جدولُ `PATTERNS` (‏`ack` · `start` · `pause` · `resume` · `finish` · `warn` · `error` · `over`) وثلاثةُ شروطٍ أُخرى: النمطُ معروف (خطأٌ إملائيّ = صمت)، والميلُ مفعّل، ونفسُ النمط لا يتكرّر خلال 90ms. **الاختزالُ الثالث** ليس تفصيلًا: ضغطةٌ واحدة على «إنهاء» تؤكّد وتكتب وتنتقل وتبلّغ عن نفسها، وبلا اختزالٍ تسمع ثلاثَ نبضاتٍ متطابقة حيث واحدةٌ مقصودة. والميلُ **يُقرأ من المخزن في كل نداء** لا من متغيّرٍ محليّ، حتى يسري إطفاؤه في الإعدادات على الضغطة التالية بلا شيءٍ يُkept في تزامن.

### `notifications.js` — لماذا الآن، ولماذا مرّةً واحدة

الحدثُ الوحيد الذي يستحقّ مقاطعة هو **تجاوزُ تقدير الجلسة**، لأنه يحدث والمستخدمُ لا ينظر. والطريقةُ الوحيدة التي تصل إلى شاشةٍ لا أحدُ ينظر إليها هي إشعارُ نظام.

- **الصلاحية تُطلب عند `sessionService.start()` لا عند الإقلاع**، **وكأول جملةٍ فيه** — أي في المهمة نفسها التي كانت نقرةَ المستخدم، لأن بعض المحركات ترفض طلبًا خارج إيماءة المستخدم، وبانتظار أوّل `await` تكون الإيماءة قد انتهت. وطلبُ إذنٍ عند أوّل فتحٍ هو أسرع طريقة لتدريب المستخدم على رفض الطلبات.
- **لا إعادةَ سؤالٍ أبدًا**: `ask()` يعود فورًا ما لم تكن الحالة `default`.
- **المرورُ عبر Service Worker لا عبر المُنشئ**، لأن `notificationclick` هو الطريقُ الوحيد الذي يمكن معالجة النقر منه. و`main.js` هو الذي يسمع الرسالة ويوجّه، لأنه **الشيءُ الوحيد في التطبيق الذي يملك العنوان**.
- **لا تكديسَ**: `tag` واحد و`renotify: false`، فتبويبٌ مخنوقٌ يلحق مرارًا يُنتج تنبيهًا واحدًا يستبدل نفسه.
- **حدودُ ما يُقال صراحةً** (في تعليق الوحدة نفسها): لا خادم push، فالتنبيه **تفاعليٌّ لا مجدول**. في الواجهة يصل خلال ثانية، وخلفها قد لا يُنفَّذ أبدًا، وعلى العودة يُفحص فيصل متأخّرًا ومرّةً واحدة. **والمؤقّتُ لا يعتمد على أيٍّ من هذا** — انظر `elapsedMs()`.

### `capture.js` — إذنٌ يُسأل عنه، لا يُخمَّن

الاستثناء في هذه المجموعة: **هذه الوحدة ترسم شيئًا**، لأنها وحدها تسأل المنصّة عن إجابة. والفصلُ بقى كما هو في 파일 نفسه — `app/` لا `ui/` — لأن ما فيها تحويلُ بايتات لا بناءُ عناصر.

- **سؤالان، وإجابةٌ واحدةٌ تُعطى، والإجابةُ تُسأل ولا تُطيع.** (١) **هل تقبل هذه الصفحة التقاط صورة أصلًا؟** `navigator.mediaDevices` غير موجود خارج سياق آمن، فالتطبيق على `http` بعنوان شبكة محلية — وهو بالضبط كيف تُفتح نسخةٌ مُستضافة ذاتيًا من الهاتف — كان يرمي "المتصفح لا يدعم". (٢) **ماذا قال المتصفح من قبل؟** `navigator.permissions` يستطيع أن يقول `granted`/`denied`/`prompt` **دون** فتح نافذة.
- **قاعدةُ هذا القسم: جوابُ `permissions` سؤالٌ لا بوابة.** الإصدار الأول من هذا الإصلاح **رفض** التسجيل عند `denied` — وهذا ما حوّل إذنًا أصلحه المستخدم إلى تطبيق ميّت لا مخرج منه:
  - **الجواب لقطةٌ وقت التحميل.** كروم وإيدج يواصلان قول `denied` حتى يُعاد تحميل التبويب، **حتى بعد** السماح من `chrome://settings/content/camera` والعودة. فالتوصية التي كانت يعرضها التطبيق — «اسمح من إعدادات المتصفح» — كان قد نُفِّذت، وتنفيذها لم يغيّر شيئًا.
  - **النتيجة أن `getUserMedia` لم يُنادَ قط**، فلا ظهرت نافذة الطلب. ضغط المستخدم تسجيلًا وانتظر حوار المتصفح، فجاء بدلًا منه `toast` يقول إن الوصول مرفوض.
  - **القاعدة:** `getUserMedia` هو السلطان وهو أيضًا الطلب، فالمحاولة **تكلّف لا شيء** حين يكون الرفض حقيقيًا: ترفض فورًا بـ`NotAllowedError` بلا نافذة. والخطأ في اتجاه الرفض يكلّف كاميرا تعمل؛ والخطأ في اتجاه المحاولة يكلّف رفضًا صامتًا واحدًا.
  - **`requestCapturePermission()` لا تختصر عند `denied`.** لأن `getUserMedia` بُالغتُه فعلًا، فـ`denied` العائدة منها **مؤكَّدةٌ من المنصّة** لا مُخمَّنةٌ من لقطة — وهذا ما يسمح لصف الإعدادات بحذف الزر بثقة.
- **زرُّ «السماح» يظهر في `denied` عمدًا**، وهو عكس قاعدة صف الإشعارات (`prompt`/`unknown` فقط). الإخفاء كان يقول لمن سمح للتو أنه لا شيء بقي ليضغطه. تطبيقٌ لا يستطيع أن يتيقّن أن ضابطًا قد مات **يجب ألّا يخفيه**؛ الضغط يكلّف تدفّقًا واحدًا ويجيب بقسمٍ حاسم في الحالتين.
- **`unknown` تعني «دع `getUserMedia` يسأل»، لا «ارفض».** سفاري ينفّذ `navigator.permissions` **ويرفض** اسمي `camera` و`microphone` (`TypeError`). فكلُّ مسار فشل يجيب `unknown` **ولا يرمي استثناءً أبدًا**، ورفضٌ على أساس جواب استعلامٍ غير مدعوم كان سيرفض تسجيلًا كان يعمل تمامًا.
- **`InsecureContextError` رمزٌ خاص** لا نكهةٌ من `NotSupportedError`. السبب أن إصلاحه الوحيد ليس في قائمة إعدادات: العنوان. ورسالةٌ تقول "المتصفح لا يدعم" ترسل مستخدمًا يبحث عن متصفّح آخر بدل أن يفتح الرابط بـ `https`.
- **`requestCapturePermission()` تفتح تدفّقًا ثم تغلقه في `finally`.** لا يوجد استدعاءُ إذنٍ منفصل للكاميرا — **`getUserMedia` هو الطلب** — فالتدفّق موجود ليُجبر المتصفح على السؤال فقط، وما يُسجَّل شيء. **وسمّاؤها مختلف عن `notifications.ask()` عمدًا**: اختبار `only the notifications module is allowed to show a notification` يمسح `requestPermission` من كل مكان، فاسمٌ مشترك كان سيُضعف حارسًا ذا معنى.
- **تراجعُ الكاميرا لا يسقط الميكروفون.** كلُّ محاولةٍ في `openStream` تحمل قيد الصوت — الشيفرة القديمة كانت تسلّم الكائن بعد وضع `video` عليه فقط، فالفيديو المطلوب بالصوت كان يعود **صامتًا** وقد سُجّل بنجاح.
- **صفُّ الإعدادات** يعرض الحالة ويضع الزر لكل حالة **عدا `granted`**، وعلى `http` لا يضع زرًّا أصلًا: لا شيء يمكنه أن يعمل.

### `recorder.js` — تفكيكٌ يُنفَّذ مرّتين، وفصلُ عمرين لا عمر

الوحدة في `ui/components/` لا في `app/`، وهي هنا لأنّ درسها عن **عمر المورد** وهو موضوع هذا القسم، لا عن مكانها. وهي أخطر مثال في التطبيق على قاعدةٍ عامة: **خروجٌ واحدٌ من الشيفرة يُنظَّف في أكثر من موضع، فلا بدّ أن يكون التنظيف آمنًا للإنفاذ مرّتين.**

- **كان `release()` يُنفَّذ مرّتين في كل تسجيل ناجح**: مرّةً في `onStop` حين يُسلَّم المُخرَج إلى الحوار، ومرةً في `finally` الخاص بـ`record()` حين يُلغى الحوار من طريقه الخروج. و`stop()` الخاص بالمؤشّر الصوتي لم يكن آمنًا للإنفاذ مرّتين — فكان ينادي `close()` مرّتين.
- **والقاعدة التي عمّت العموم:** `AudioContext.close()` **يعيد وعدًا**، ويرفضه بـ`InvalidStateError` إذا كان السياق مغلقًا أو في طور الإغلاق. و`try { audio?.close() } catch {}` **لا يمكن أن يكون حيًّا**: `try` تصطاد **رميًا**، والرفضُ وعدٌ عائمٌ يصل إلى `unhandledrejection` في `main.js` فيعرض شريط «خطأ غير متوقّع». **القاعدة: من ينشئ الوعد هو من يمسك برفضه**، لأن كلَّ من يعلوه `finally` يكون قد عاد بالفعل حين يستقرّ الوعد. **وأثنا عشر عمودًا في مؤشّر مستوى الصوت صارت سببًا في أن يُظنّ أن التسجيل ضاع، في اللحظة التي وصل فيها.**
- **عمران لا عمر** — وهو ما كشفه الإصلاح الثاني. المؤشّر صار له `start()` (حلقة الرسم، في **كل** محاولة عبر `begin()`)، و`stop()` (إيقافها، في `release()` — بين محاولتين وداخل واحدة)، و`dispose()` (إغلاق السياق، في `stopEverything()` وحده). وقبل الفصل كانا شيئًا واحدًا، فكان **إيقافُ محاولةٍ بـ«قصير جدًا» يقتل المؤشّر**: تلك المحاولة تترك الحوار مفتوحًا بزرّ تسجيل ظاهر، فترث المحاولةُ الثانيةُ سياقًا مغلقًا وحلقةً غير مجدولة — اثني عشر عمودًا متجمدًا عند بلوغ الأولى، **على الشاشة الوحيدة التي يفحص فيها المستخدم إن كان يُسمع**. القاعدة: **ما بين المحاولات يبقى حيًّا؛ وما يخرج معه الحوار وحده يموت.**
- **`dispose()` آمنةٌ بالتصميم لا بالحظ**: `audio = null` أولًا (فلا يجد نداءٌ ثانٍ ما يغلقه)، و`closing.state === "closed"` حاجزٌ ثانٍ، و`.catch()` على الرفض. **وحارس الاختبار `the level meter is torn down once, and survives being asked twice` يفشل على الثلاثة معًا** — استدعاءُ `close()` عارٍ، أو نزولُ `dispose` إلى `release`، أو سقوطُ `meter?.start()` من `begin()`.

### `wake-lock.js` — دورةُ حياة، لا سطر

المنصّة **تُفلت القفل** كلّما توقّفت الصفحة عن الظهور، ولا بدّ للصفحة أن تطلب واحدًا جديدًا. ولم يكن شيءٌ يفعل. فصارت الوحدة: قفلٌ واحد، يُؤخذ حين تكون جلسةٌ جارية والميلُ مفعّلًا، ويُترك حين لا يكون، **ويُؤخذ ثانيةً عند كل `visibilitychange` إلى ظاهر**. و`if (held) return` سطرٌ واحد يمنع التكديس، وكلُّ انتقالِ جلسةٍ كان يترك `sentinel` خلفه.

### `session-watch.js` — صاحبُ القرار، ومَن لا يقرّر

كان «بلغ التقدير» مكرّرًا في موضعين، لكلٍّ منهما عَلَمُ `vibrated`، **والتنبيهُ لا وجود له أصلًا ما لم يكن أحدهما مركّبًا**. الآن الوحدةُ الواحدة تجيب، والمرّاتان في الواجهة تستعملان الجوابَ في الرسم فقط.

- **مِفتاحُ تذكّرٍ واحد لكل عبور** (`alerted`)، يُصفَّر بانتهاء الجلسة وبمعرّفٍ جديد وبأن يصير التقدير غير متجاوز — وهذا بالضبط ما يجعل **العودة إلى الواجهة** آمنةً: التبويبُ المخنوق الذي يلحق مرارًا يُنتج تنبيهًا واحدًا.
- **مؤقّتُه عن الحافّة لا عن الساعة**: ثانيةٌ في الواجهة ودقيقةٌ خلفها، وعلى `visibilitychange` يُعاد الضبط. فالأرقامُ تُشتقّ من `segments` مقابل `Date.now()`، وهذا المؤقّت موجودٌ ليرصد **حَدًّا**، وحدٌّ يُفحص كلّ دقيقةٍ يُفحص في الدقيقة التالية أيضًا.
- **لا يدير حالةً ولا يكتب شيئًا**: يقرّر، ويُمرّر القرار إلى `haptics` و`beep` و`notifications`. كلُّها تحتمل الغياب.

### `hasEstimate()` — مثالٌ على قاعدةٍ نمت في المكان الخطأ

`isOver()` كانت `elapsed >= estimatedMs`، و`estimatedMs` في الجلسة الحرّة صفر، فكانت **كلُّ جلسةٍ حرّة تتجاوز تقديرها بعد ملّي ثانية**. ولم تكن للدالة أيُّ نداءٍ في المشروع، فلم يكتشفها أحد؛ وكلُّ موضعٍ يسأل السؤال فعلًا كان قد كتب الحارسَ بيده. الآن القاعدةُ في `domain/session-engine.js` وحدها، و**اختبارٌ يرفض على المسرح والشريحة والمنبّه أن يعيدوا صياغتها بكلماتهم** — لأن هذا هو نوعُ الخطأ الذي يعود: ليس مؤقّتًا ينتهي بل شرطًا يتكرّر.

### ما الذي تحرسه `tests/device.test.mjs` (40 اختبارًا)

- **لا شيء يرمي**: جهازٌ بلا اهتزاز، و`vibrate` يرمي، و`Notification` غير موجودة، وإذنٌ مرفوض، و`showNotification` يرمي، و`wakeLock` غير موجود، و`request` مرفوض، و`release` يرمي، ونافذةٌ بلا `addEventListener`.
- **لا يتكرّر**: نبضةٌ واحدة لكل حدث، وقفلٌ واحد مهما تكرّرت المزامنة، وتنبيهٌ واحد لكل عبور مهما تكرّرت العودة إلى الواجهة.
- **يحترم الميل**: إطفاءُ الاهتزاز أو الصوت أو الإشعار في الإعدادات يسري على النداء التالي.
- **حوارسُ بنيوية**: `navigator.vibrate` و`showNotification` و`navigator.wakeLock` لا وجود لها خارج وحداتها — وإلا عاد السؤال إلى أربعة مواضع.
- **الـPWA**: الـmanifest يصفُّ تطبيقًا قابلًا للتثبيت ولا يقفل الاتجاه، ووسومُ iOS موجودة، و`notificationclick` و`beforeinstallprompt` و`hadController`.
- **الـCSS**: `touch-action: manipulation`، و`@media (pointer: coarse)`، وكتلةُ `prefers-reduced-motion` تأخذ الحركاتَ الجديدة، والمفتاحُ يتحرّك بـ`inset-inline-start` لا بـ`transform` — وهو الدرسُ الذي كُتب مرّةً في هذا المشروع.

---

## 12) الحفظ عند اختفاء التطبيق (`app/flush.js`)

كل حقل يحفظ نفسه بنفسه بتأخير 500ms، وكلٌّ منها يحفظ أيضًا عند مغادرة الحقل. ولا يغطّيان الحالة التي تُفقد أكثر ما تُفقد وتُصمت أكثر ما تُصمت: يكتب المستخدم سطرًا ثم **ينتقل إلى تطبيق آخر**. المغادرة لا يُتوقَّع أن تُطلق عندها حدث blur، والمؤقّت لا يزال يعدّ، ثم يُجمَّد التبويب أو يُهجر — فتضيع الكلمات المكتوبة. ويعود المستخدم فيجد السطر أقصر مما يتذكّر، ولا شيء في أي مكان يشرح لماذا.

فصار هناك مكان واحد يعرف أن التطبيق سيغادر الشاشة، وكل حفظٍ معلّق يسجّل نفسه فيه.

- **مُحفِّزان، وكلاهما لازم**: `visibilitychange` (إلى `hidden`) هو الموثوق — يُطلق على تبديل التبويب وعلى قفل الشاشة وعلى الانتقال إلى تطبيق آخر، والكتابة في IndexedDB تبدأ منه عادةً لأن الصفحة ما تزال حيّة. و`pagehide` لصفحة bfcache ولإغلاق الصفحة: أبعد وأقلّ يقيقنًا، فقد تُجمَّد الصفحة فور عودتها فيضيع ما تبقّى. **والاثنان على أفضل تقدير**، وهكذا كان الحفظُ عند المغادرة يومًا.
- **`Set` لا قائمة، مع إلغاء اشتراك**: شاشة تُركَّب وتُفكّ مرارًا (الصفحة نفسها، وتعود إليها) يجب ألّا تكدّس دوالّ تكتب في DOM لم يعد موجودًا. و`Set` يجعل تسجيل الدالة نفسها مرّتين ينفّذها مرّة واحدة.
- **فشلٌ واحد لا يوقف الباقي**: الحقلان في صفحة واحدة كتابةان مستقلّتان لسجلّين مستقلّين، والثاني يهمّ بقدر الأول. والخطأ هنا يُبتلع عن قصد: هذا يعمل من مُعالِج حدث في طريق الخروج من الصفحة، ولا مكان يُبلَّغ عنه، وفشل شاشةٍ لا يصير فقدانًا لشاشة أخرى.
- **ليس مخزن مسوّدات**: لا يمكن أن يكون، فكتابةٌ غير مُثبَّتة لم تُحقَّق منها، ومسار استرجاعها كان سيقرّر أيّ نصفِ السجلّ يسبق الآخر. هذا يُغلق نافذة الـ 500ms، وهي الخسارةُ كلّها، ويستخدم الحفظَ الذي كانت الشاشة تملكه أصلًا.

يُثبَّت مرّة واحدة من `boot()` **قبل** الراوتر، حتى تُسجّل الشاشة الأولى حفظها المعلّق قبل أن يمكن لشيءٍ أن يُخفي التبويب. وتغطّي `tests/flush.test.mjs` التوقيتَ والفشلَ والإلغاءَ والتسجيلَ المكرّر.

---

## 14) خدمة «الأنشطة المتكررة» (Routines) كما هي منفَّذة

قاعدة يكتبها المستخدم مرّة واحدة ("اركض ٣٠ دقيقة كل يوم")، و**نشاطٌ حقيقيٌ يُحفظ حيث له مكان**. أصغر خدمة في المشروع بعد `later`، والفرق الوحيد المهم أن **`later` لا تنتج شيئًا، والأنشطة تنتج**: موقوتٌ يُشغَّل بمؤقّت التطبيق نفسه، وعدّادٌ يكتب صفًّا واحدًا ليومه.

### الطبقات (نفس نمط المالية وLater والصفحات بالضبط — لا بنية موازية)

- **نقي (بلا I/O)**: `domain/routine.js` — `createRoutine`، `isDueOn`، `logId`، `logFor`، `todayView`. يستورد من `validation.js` ومن `time.js` فقط.
- **تحقّق**: `ROUTINE_KINDS` / `ROUTINE_FREQUENCIES` / `ROUTINE_REMINDER_BEFORE` / `ROUTINE_REMINDER_EVERY` / `MAX_ROUTINES` / `MAX_ROUTINE_LOGS` / `MAX_ROUTINE_TARGET` / `MAX_ROUTINE_COUNT`، و`validateRoutineInput` و`assertRoutineRecords` في `domain/validation.js` (استيراد أحادي الاتجاه مثل `later.js`).
- **تخزين**: `data/routines.repo.js` (بلا فهارس، كـ`later`) و`data/routine-logs.repo.js` (`byRoutine` / `byDay` / `deleteByRoutine`).
- **خدمة واحدة**: `services/routine-service.js` — قراءة (`list`، `get`، `today`، `count`، `history`) وكتابة (`create`، `update`، `remove`، `bump`، `start`). كل كتابة تنتهي بـ`syncService.enqueue`/`enqueueMany` ثم `notify()`.
- **واجهة**: `ui/pages/routines.js` (قائمة + `/routines/new` + `/routines/:id`) و`ui/components/routine-form.js` و`ui/components/routine-row.js`. النوعان يستعملان `iconPicker` الموجود (ساعة/هدف)، لا منت picker جديدًا.
- **تقارير**: `routineActivity` في `domain/analytics.js` (تُستدعى من `reportSummary`، و`reportService.summary` يقرأ `routines`/`routineLogs` في نفس معاملة الجلسات).

### قواعد مُطبَّقة

- **نوعان × تكراران، بلا مصفوفة استثناءات**: `timed`/`counter` × `daily`/`weekly`. الحقول التي لا تخصّ النوع **تُمسح** لا تُحفظ (`target` على موقوت مرفوض، `durationMs` على عدّاد مرفوض): سجلّ يدّعي شكلين ليس سجلًّا. وهذا ما يجعل تبديل النوع في النموذج آمنًا بلا حقل يترك خلفه قيمة.
- **المدة اختيارية حتى للموقوت**: "الوقت اختياري وغير ملزم" — قاعدة بلا مدة تظهر في يومها وتسجّل تشغيلها، لكن بلا عدّاد تنازلي. والحدود هما حدود التقدير القائمة (`MIN_ESTIMATE`..`MAX_ESTIMATE`): **لا حدّ جديد**.
- **الجلسة القائمة هي المؤقّت**: `routineService.start` يستدعي `sessionService.start({routineId, title, durationMs})` وخلاص. **لا فرع routine في `session-service.js`** ولا نوع جلسة جديد: العدّاد التنازلي وتنبيه تجاوز التقدير وإبقاء الشاشة والحق "جلسة واحدة نشطة" والتقارير كلها من الكود الذي كان يخدم المهام. والأثر الوحيد على السجلّ هو `routineId`.
- **عدّاد لا ينشئ Task ولا Session**: صفٌّ واحد في `routineLogs`. والقراءة والكتابة في **معاملة واحدة** (`bump`) لأن ضغطتين متتاليتين كانتا ستقرآن 0 وتكتبان 1؛ والضغط تحت الصفر **مرفوض** لا مثبَّت.
- **السلسلة المتتالية في مكانين**: `routineService.remove` و`applyChanges` في `sync-service.js` على tombstone القاعدة. كل صفّ يوم يُرسل **tombstone خاصًّا به** في نفس الدفعة — لأن الخادم لا يعرف ما هو صفّ يوم ولا يستطيع أن يسقطه بنفسه.
- **الترتيب مشتقّ لا مخزَّن**: `todayView` و`sortRoutines` يرتّبان في كل قراءة (`createdAt`، والموقوفة أخيرًا).
- **الواجهة على `ui.js`/`fields.js`**: لا `class: "list-row"` ولا `class: "row"` ولا `<select>` عارٍ. عدّاد الصفّ `badge("3 / 5")` بزرَّي `plus`/`minus` من `rowAction` — بلا CSS جديد.
- **وجهة في قائمة الأقسام**: `/routines` في `NAV_ICON_NAMES` بالعلامة `repeat`، وداخل طبقة `nav.groupServices` في `nav.js`. الشريط السفلي لم يعد موجودًا: زرٌّ واحد إلى جانب الاسم يفتح القائمة كاملة، therefore nothing here is about fitting a fixed-width bar — the order is priority. **اختباران** في `tests/ui.test.mjs`: `the navigation covers every destination and nothing extra` (تساوي المجموعات مع جدول المسارات) و`the destinations are ordered the same way in both lists` (تساوي **الترتيب** — تساوي المجموعات وحده كان يكفي للقيم لا للترتيب، فكان من الممكن أن تُقرأ القائمة بترتيب والشارة بترتيب آخر).

### ما الذي لا وجود له إطلاقًا

`overdue` · `missed` · `streak` · نسبة التزام · `nextAt` · `lastDoneAt` · جدولة · إشعارات مُجدوَلة · مهمة أو جلسة لكل نشاط. والاختبارات تحرس هذا الغياب: `no day but today can be asked about` يفشل إن أُضيف أي حقل عن يومٍ آخر إلى `todayView`، و`the report counts what happened and lists nothing else` يفشل إن ظهر صفّ صفري لنشاط بلا حدث.
