# Autopilot Runbook (Supaya bisa jalan saat Anda tidur)

## 1) Cara Operasional

Gunakan 1 komando briefing untuk memulai loop panjang:

- Objective proyek
- Scope MVP
- Batasan teknis
- Rule eksekusi (boleh/tidak boleh)
- Kriteria selesai

Lalu agent menjalankan siklus SDLC berulang tanpa menunggu prompt baru, kecuali saat butuh keputusan bisnis penting atau aksi berisiko.

## 2) Guardrails (disarankan)

Boleh otomatis:
- coding, refactor, test, build, dokumentasi, commit lokal

Butuh persetujuan CEO:
- deploy production
- perubahan biaya/infrastruktur berbayar
- perubahan destructive pada data
- perubahan security policy kritikal

## 3) Jadwal Wajib IT Director

- 08:00 UTC -> Morning Improvement Assessment
- 17:00 UTC -> Evening Improvement Assessment

Output wajib tiap assessment:
- Strategic quality findings
- Akar masalah (root cause themes)
- Action plan baru lintas tim
- Prioritas 24 jam berikutnya

## 4) Continuous Improvement (di luar rutinitas)

Setiap role wajib mengusulkan improvement mandiri minimal 1 item/siklus:
- test hardening
- coding standard tightening
- observability improvements
- build-time reduction without quality loss
- defect-prevention actions
