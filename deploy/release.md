# إصدارات Rawmat الموقّعة

تنشر [صفحة الإصدارات](https://github.com/mrchemist03/rawmat/releases) إصدار Linux ‏`amd64` مع بصمة صورة Docker. تنشئ GitHub Actions شهادة منشأ وقائمة مكوّنات CycloneDX موقّعتين لبصمة الصورة باستخدام هوية سير العمل عبر OIDC. تجتاز الصورة اختبارات التشغيل والاستعادة وفحوص التبعيات والأسرار قبل اعتماد وسم الإصدار.

## التحقق من الصورة

انسخ بصمة الصورة ووسم الإصدار من صفحة الإصدار نفسها. استعمل GitHub CLI للتحقق من هوية المستودع وسير العمل ووسم المصدر، ومن وجود قائمتي التوقيع على بصمة الصورة.

```bash
tag='v0.1.0'
image='ghcr.io/mrchemist03/rawmat@sha256:REPLACE_WITH_RELEASE_DIGEST'
policy=(--repo mrchemist03/rawmat
  --signer-workflow mrchemist03/rawmat/.github/workflows/ci.yml
  --source-ref "refs/tags/$tag" --deny-self-hosted-runners --bundle-from-oci)
gh attestation verify "oci://$image" "${policy[@]}"
gh attestation verify "oci://$image" "${policy[@]}" --predicate-type https://cyclonedx.org/bom
```

يمكن تمرير بصمة الالتزام من صفحة الإصدار أيضًا عبر `--source-digest`. بعد نجاح الفحصين، اضبط `APP_IMAGE` في ملف بيئة التشغيل على مرجع الصورة الكامل الذي يحتوي على `@sha256:`. خذ نسخة احتياطية متسقة ثم اسحب الصورة وشغّلها بملفات البيئة المعتادة.

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml pull app
docker compose --env-file deploy/.env -f deploy/compose.yml up -d --wait
```

## نشر إصدار جديد

بعد تحديث رقم النسخة في ملفات الحزم والقفل ونجاح CI على `main`، ادفع وسمًا بصيغة `vMAJOR.MINOR.PATCH` يطابق رقم حزمة المشروع. يتولى سير العمل إعادة الفحوص ونشر الصورة الموقّعة إلى GitHub Container Registry. بعد نجاحه، سجّل بصمة الصورة وبصمة الالتزام في صفحة إصدار GitHub.
